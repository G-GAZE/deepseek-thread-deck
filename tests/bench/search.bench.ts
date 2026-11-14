import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openDeckDatabase } from '@/core/db';
import { toMessageKey } from '@/core/db/schema';
import { createSearchIndex } from '@/core/search/search-index';
import { resolveFlags } from '@/shared/feature-flags';

import { generateFixtureData } from '../fixtures/generate-fixtures';

/**
 * 检索基准（`pnpm bench`，不随 `pnpm test` 跑）。
 *
 * 指标口径（固化，见 docs/tasks/0001-search-design.md §6）：
 * - 这里看的是**单次查询 P50 / P95**，不是总耗时（总耗时属于 sync.bench.ts）；
 * - 目标：P95 < 300ms（任务书验收）；
 * - fake-indexeddb 下检索耗时接近真实 IndexedDB，可作参考；但**索引构建成本**仍受
 *   fake 环境影响，需在 M1b 真实环境复测；
 * - 不做硬断言：超阈值打 WARN，避免 CI 抖动误报。
 */

const CONVERSATIONS = 500;
const MESSAGES_PER_CONV = 100;
const QUERY_COUNT = 100;
const WARMUP_COUNT = 5;
const P95_BUDGET_MS = 300;

const QUERIES = [
  '分词',
  '游标',
  '索引',
  '会话',
  '检索',
  '迁移',
  '并发',
  '缓存',
  '附件',
  '分叉',
  'dexie',
  'minisearch',
  'service worker',
  '幂等',
  '降级',
  '选择器',
  '遥测',
  '权限',
  '导出',
  '相似',
];

function percentile(samples: readonly number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

describe('search 基准（fake-indexeddb）', () => {
  it('500 对话 / 5 万消息的索引构建与单次查询 P95', async () => {
    const data = generateFixtureData({
      conversations: CONVERSATIONS,
      messagesPerConv: MESSAGES_PER_CONV,
      chineseRatio: 0.6,
      withThinking: true,
      withAttachments: true,
      seed: 42,
    });

    const opened = await openDeckDatabase(`bench-search-${randomUUID()}`);
    if (!opened.ok) throw new Error(`基准数据库打开失败: ${opened.error.code}`);
    const db = opened.data;

    try {
      // 直接灌数据（不经 sync），保证搜索基准只测搜索本身。
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

      const index = createSearchIndex({ db, flags: resolveFlags({}) });

      const buildStartedAt = performance.now();
      const rebuilt = await index.rebuild();
      const buildMs = performance.now() - buildStartedAt;
      if (!rebuilt.ok) throw new Error(`索引构建失败: ${rebuilt.error.code}`);

      const documentCount = await db.searchIndex.count();

      for (let index_ = 0; index_ < WARMUP_COUNT; index_ += 1) {
        await index.search(QUERIES[index_ % QUERIES.length] ?? '分词');
      }

      const samples: number[] = [];
      let hitTotal = 0;
      for (let round = 0; round < QUERY_COUNT; round += 1) {
        const query = QUERIES[round % QUERIES.length] ?? '分词';
        const startedAt = performance.now();
        const result = await index.search(query);
        samples.push(performance.now() - startedAt);
        if (result.ok) hitTotal += result.data.length;
      }

      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const max = Math.max(...samples);
      const verdict = p95 <= P95_BUDGET_MS ? 'PASS' : 'WARN（超过 300ms 预算）';

      console.log(
        [
          '',
          '==== search bench (fake-indexeddb) ====',
          `规模: ${CONVERSATIONS} 对话 / ${CONVERSATIONS * MESSAGES_PER_CONV} 消息，索引文档 ${documentCount}`,
          `索引构建: ${ms(buildMs)}（fake 环境，需 M1b 复测）`,
          `查询次数: ${QUERY_COUNT}（warmup ${WARMUP_COUNT}），平均命中 ${(
            hitTotal / QUERY_COUNT
          ).toFixed(1)} 条`,
          `P50: ${ms(p50)}`,
          `P95: ${ms(p95)}   （预算 ${P95_BUDGET_MS}ms → ${verdict}）`,
          `Max: ${ms(max)}`,
          '口径: 单次查询 P50/P95；fake-indexeddb 下检索耗时接近真实 IndexedDB，可作参考；不做硬断言。',
          '',
        ].join('\n'),
      );

      expect(documentCount).toBe(CONVERSATIONS * MESSAGES_PER_CONV);
      expect(samples).toHaveLength(QUERY_COUNT);
      expect(hitTotal).toBeGreaterThan(0);
    } finally {
      db.close();
      await db.delete();
    }
  }, 900_000);
});
