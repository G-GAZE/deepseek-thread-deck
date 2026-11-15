import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openDeckDatabase } from '@/core/db';
import { createConversationSync } from '@/core/sync/conversation-sync';
import { createCursorStorage } from '@/core/sync/cursor';
import { resolveFlags } from '@/shared/feature-flags';

import { createFixtureSource } from '../fixtures/fixture-source';
import { generateFixtureData } from '../fixtures/generate-fixtures';
import { createMemoryStorage } from '../unit/helpers/memory-storage';

/**
 * 同步基准（`pnpm bench`，不随 `pnpm test` 跑）。
 *
 * 指标口径（固化，见 docs/tasks/0001-conversation-sync-design.md §10）：
 * - 这里看的是 **全量 / 增量总耗时**，不是 P95；单次查询 P95 属于 search.bench.ts；
 * - fake-indexeddb 是纯 JS 内存实现，**sync 耗时没有参考意义**，本文件只证明
 *   「500 对话 / 5 万消息能跑完、结果正确、增量能跳过」；
 * - **禁止把本文件数字当性能承诺**，真实性能在 M1b 真实环境验收。
 */

const CONVERSATIONS = 500;
const MESSAGES_PER_CONV = 100;

function formatMs(value: number): string {
  return `${value.toFixed(0)} ms`;
}

describe('sync 基准（fake-indexeddb，非性能承诺）', () => {
  it('全量同步 500 对话 / 5 万消息，再跑一次增量', async () => {
    const data = generateFixtureData({
      conversations: CONVERSATIONS,
      messagesPerConv: MESSAGES_PER_CONV,
      chineseRatio: 0.6,
      withThinking: true,
      withAttachments: true,
      seed: 42,
    });

    const opened = await openDeckDatabase(`bench-sync-${randomUUID()}`);
    if (!opened.ok) throw new Error(`基准数据库打开失败: ${opened.error.code}`);
    const db = opened.data;

    try {
      const memory = createMemoryStorage();
      const source = createFixtureSource({ conversations: data.conversations });
      const sync = createConversationSync({
        source,
        db,
        flags: resolveFlags({}),
        cursor: createCursorStorage(memory),
      });

      const fullStartedAt = performance.now();
      const full = await sync.syncAll();
      const fullWall = performance.now() - fullStartedAt;

      const incrementalStartedAt = performance.now();
      const incremental = await sync.syncAll();
      const incrementalWall = performance.now() - incrementalStartedAt;

      const conversationCount = await db.conversation.count();
      const messageCount = await db.message.count();

      console.log(
        [
          '',
          '==== sync bench (fake-indexeddb) ====',
          `对话数: ${CONVERSATIONS}   消息数: ${CONVERSATIONS * MESSAGES_PER_CONV}`,
          `全量: ${formatMs(fullWall)}（summary.durationMs=${
            full.ok ? formatMs(full.data.durationMs ?? 0) : 'n/a'
          }，synced=${full.ok ? full.data.synced : 'n/a'}）`,
          `增量: ${formatMs(incrementalWall)}（skipped=${
            incremental.ok ? incremental.data.skipped : 'n/a'
          }）`,
          `落库: conversation=${conversationCount} message=${messageCount}`,
          '口径: 仅验证逻辑可跑完 500/50k 且结果正确；fake-indexeddb 耗时不代表真实 IndexedDB，禁止作为性能承诺。',
          '',
        ].join('\n'),
      );

      // 只断言正确性，不断言耗时（耗时在 fake-indexeddb 下无参考意义）。
      expect(full.ok).toBe(true);
      if (!full.ok) throw new Error('unreachable');
      expect(full.data.synced).toBe(CONVERSATIONS);
      expect(full.data.failed).toEqual([]);
      expect(conversationCount).toBe(CONVERSATIONS);
      expect(messageCount).toBe(CONVERSATIONS * MESSAGES_PER_CONV);

      expect(incremental.ok).toBe(true);
      if (!incremental.ok) throw new Error('unreachable');
      expect(incremental.data.synced).toBe(0);
      expect(incremental.data.skipped).toBe(CONVERSATIONS);
    } finally {
      db.close();
      await db.delete();
    }
  }, 300_000);
});
