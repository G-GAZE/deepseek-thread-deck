import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openDeckDatabase } from '@/core/db';
import { toMessageKey } from '@/core/db/schema';
import { createSearchIndex, loadMiniSearchEngine } from '@/core/search/search-index';
import { createProgressStorage } from '@/core/search/progress';
import { createSearchLock } from '@/core/search/lock';
import { createSnapshotStore, SNAPSHOT_ID } from '@/core/search/snapshot';
import { resolveFlags } from '@/shared/feature-flags';

import { generateFixtureData } from '../fixtures/generate-fixtures';
import { createMemoryStorage } from '../unit/helpers/memory-storage';

/**
 * 阶段 5.5 基准：重建耗时 / 快照体积 / loadJSON 耗时 / 内存。
 *
 * 口径（docs/tasks/0002-search-index-persistence-design.md）：
 * - 重建耗时为 fake-indexeddb 数值，仅看「修复前后相对变化」，不作性能承诺；
 * - loadJSON 与内存为量级参考（Node 堆 ≠ Chrome content script 堆）。
 * - 内存用 `--expose-gc` 运行：`pnpm bench` 不强制该参数，缺失时退化为不强制定 GC。
 */

const CONVERSATIONS = 500;
const MESSAGES_PER_CONV = 100;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

describe('search 持久化基准（fake-indexeddb）', () => {
  it('重建 / 快照 / loadJSON / 内存', async () => {
    const data = generateFixtureData({
      conversations: CONVERSATIONS,
      messagesPerConv: MESSAGES_PER_CONV,
      chineseRatio: 0.6,
      withThinking: true,
      withAttachments: true,
      seed: 42,
    });

    const opened = await openDeckDatabase(`bench-persist-${randomUUID()}`);
    if (!opened.ok) throw new Error(`基准数据库打开失败: ${opened.error.code}`);
    const db = opened.data;

    try {
      await db.conversation.bulkAdd(
        data.conversations.map((conversation) => ({
          id: conversation.remoteId,
          remoteId: conversation.remoteId,
          title: conversation.title,
          projectId: null,
          tags: [],
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        })),
      );
      await db.message.bulkAdd(
        data.conversations.flatMap((conversation) =>
          conversation.messages.map((message) => ({
            id: toMessageKey(conversation.remoteId, message.remoteId),
            convId: conversation.remoteId,
            role: message.role,
            content: message.content,
            order: message.order,
            attachmentMeta: message.attachmentMeta ?? [],
            ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
          })),
        ),
      );

      const memory = createMemoryStorage();
      const index = createSearchIndex({
        db,
        flags: resolveFlags({}),
        lock: createSearchLock(memory),
        progress: createProgressStorage(memory),
      });

      const rebuildStartedAt = performance.now();
      const rebuilt = await index.rebuild();
      const rebuildMs = performance.now() - rebuildStartedAt;
      if (!rebuilt.ok) throw new Error(`重建失败: ${rebuilt.error.code}`);

      const snapshot = await createSnapshotStore(db).read();
      if (!snapshot.ok || snapshot.data === undefined) throw new Error('快照缺失');
      const snapshotBytes = Buffer.byteLength(snapshot.data.json, 'utf8');
      const docCount = await db.searchIndex.count();
      const tokensEmpty = (await db.searchIndex.toArray()).every((row) => row.tokens.length === 0);

      gc();
      const baseline = process.memoryUsage();

      const loadStartedAt = performance.now();
      const loaded = loadMiniSearchEngine(snapshot.data.json);
      const loadMs = performance.now() - loadStartedAt;
      const peak = process.memoryUsage();
      expect(loaded.search('游标', { limit: 10 }).length).toBeGreaterThan(0);

      const storage = createProgressStorage(memory);

      console.log(
        [
          '',
          '==== search 持久化基准（阶段 5.5） ====',
          `规模: ${CONVERSATIONS} 对话 / ${CONVERSATIONS * MESSAGES_PER_CONV} 消息；索引文档 ${docCount}`,
          `重建 rebuild: ${rebuildMs.toFixed(0)} ms（阶段 5 为 21,451 ms；已去掉重复分词）`,
          `快照体积: ${snapshotBytes} bytes = ${mb(snapshotBytes)}（文档 ${docCount}）`,
          `loadJSON: ${loadMs.toFixed(0)} ms`,
          `loadJSON 堆增量（峰值，含 JSON 字符串）: ${mb(peak.heapUsed - baseline.heapUsed)}`,
          `loadJSON rss 增量: ${mb(peak.rss - baseline.rss)}`,
          `索引行 tokens 是否全空数组: ${tokensEmpty ? '是' : '否'}`,
          `进度 key 可用: ${(await storage.read()).ok ? '是' : '否'}`,
          '口径: fake-indexeddb 数值仅看相对变化；Node 堆 ≠ Chrome content script 堆。',
          '',
        ].join('\n'),
      );

      expect(docCount).toBe(CONVERSATIONS * MESSAGES_PER_CONV);
      expect(tokensEmpty).toBe(true);
      expect(snapshot.data.id).toBe(SNAPSHOT_ID);
    } finally {
      db.close();
      await db.delete();
    }
  }, 900_000);
});
