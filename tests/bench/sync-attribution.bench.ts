import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openDeckDatabase } from '@/core/db';
import { toMessageKey, type ConversationRecord, type MessageRecord } from '@/core/db/schema';
import { createConversationSync } from '@/core/sync/conversation-sync';
import { createCursorStorage } from '@/core/sync/cursor';
import { resolveFlags } from '@/shared/feature-flags';

import { createFixtureSource } from '../fixtures/fixture-source';
import { generateFixtureData, type FixtureData } from '../fixtures/generate-fixtures';
import { createMemoryStorage } from '../unit/helpers/memory-storage';

/**
 * 同步耗时归因（`pnpm bench`）。
 *
 * 目的：回答「全量同步的时间花在哪」，据此判断 M1b 真实环境需不需要做并发或批量优化。
 *
 * 口径（见 docs/tasks/0001-conversation-sync-design.md §10）：
 * - 数据全部来自 fake-indexeddb（纯 JS 内存实现），**不代表真实 IndexedDB**；
 * - 每项取多次运行的中位数，降低抖动；
 * - 只看总耗时与相对占比，不看 P95；禁止把这里的数字当性能承诺。
 *
 * 拆解项：
 * 1. generate —— 夹具生成（每次 bench 重新生成，确定性，不入 git）
 * 2. source   —— list + 500 次 fetchConversation（含 structuredClone 成本，不写库）
 * 3. sync@20  —— 生产默认分片（20 会话/批，约 25 次让出事件循环）
 * 4. sync@500 —— 单批（1 次让出），衡量分片 overhead 上界
 * 5. bulk     —— 一个事务直接写全量：观察「大事务」在 fake-indexeddb 下的表现
 */

const CONVERSATIONS = 500;
const MESSAGES_PER_CONV = 100;

const SYNC_REPEATS = 3;
const SOURCE_REPEATS = 3;
const GENERATE_REPEATS = 5;
const BULK_REPEATS = 2;

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
}

async function measure(run: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await run();
  return performance.now() - startedAt;
}

async function measureMedian(run: () => Promise<void>, repeats: number): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < repeats; index += 1) {
    samples.push(await measure(run));
  }
  return median(samples);
}

async function withFreshDb(
  run: (db: Awaited<ReturnType<typeof openDeckDatabase>>) => Promise<void>,
): Promise<void> {
  const opened = await openDeckDatabase(`bench-attr-${randomUUID()}`);
  if (!opened.ok) throw new Error(`基准数据库打开失败: ${opened.error.code}`);
  try {
    await run(opened);
  } finally {
    opened.data.close();
    await opened.data.delete();
  }
}

function buildRows(data: FixtureData): {
  conversations: ConversationRecord[];
  messages: MessageRecord[];
} {
  const conversations: ConversationRecord[] = [];
  const messages: MessageRecord[] = [];

  for (const conversation of data.conversations) {
    conversations.push({
      id: conversation.remoteId,
      remoteId: conversation.remoteId,
      title: conversation.title,
      projectId: null,
      tags: [],
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });

    for (const message of conversation.messages) {
      const row: MessageRecord = {
        id: toMessageKey(conversation.remoteId, message.remoteId),
        convId: conversation.remoteId,
        role: message.role,
        content: message.content,
        order: message.order,
        attachmentMeta: message.attachmentMeta ?? [],
      };
      if (message.thinking !== undefined) row.thinking = message.thinking;
      messages.push(row);
    }
  }

  return { conversations, messages };
}

describe('sync 耗时归因（fake-indexeddb，非性能承诺）', () => {
  it('拆解生成 / 数据源 / 分片 / 事务的开销', async () => {
    const generateOptions = {
      conversations: CONVERSATIONS,
      messagesPerConv: MESSAGES_PER_CONV,
      chineseRatio: 0.6,
      withThinking: true,
      withAttachments: true,
      seed: 42,
    } as const;

    let data: FixtureData | undefined;
    const generateMs = await measureMedian(async () => {
      data = generateFixtureData(generateOptions);
    }, GENERATE_REPEATS);
    if (data === undefined) throw new Error('夹具生成失败');
    const fixture = data;

    const sourceMs = await measureMedian(async () => {
      const source = createFixtureSource({ conversations: fixture.conversations });
      await source.getAvailability();
      await source.listConversations();
      for (const conversation of fixture.conversations) {
        await source.fetchConversation(conversation.remoteId);
      }
    }, SOURCE_REPEATS);

    const syncMs = new Map<number, number>();
    for (const batchSize of [20, 500]) {
      syncMs.set(
        batchSize,
        await measureMedian(async () => {
          await withFreshDb(async (opened) => {
            if (!opened.ok) throw new Error('unreachable');
            const sync = createConversationSync({
              source: createFixtureSource({ conversations: fixture.conversations }),
              db: opened.data,
              flags: resolveFlags({}),
              cursor: createCursorStorage(createMemoryStorage()),
            });
            const result = await sync.syncAll({ batchSize });
            if (!result.ok) throw new Error(`同步失败: ${result.error.code}`);
            expect(result.data.synced).toBe(CONVERSATIONS);
          });
        }, SYNC_REPEATS),
      );
    }

    const { conversations, messages } = buildRows(fixture);
    const bulkMs = await measureMedian(async () => {
      await withFreshDb(async (opened) => {
        if (!opened.ok) throw new Error('unreachable');
        await opened.data.transaction(
          'rw',
          opened.data.conversation,
          opened.data.message,
          async () => {
            await opened.data.conversation.bulkAdd(conversations);
            await opened.data.message.bulkPut(messages);
          },
        );
      });
    }, BULK_REPEATS);

    const batch20 = syncMs.get(20) ?? 0;
    const batch500 = syncMs.get(500) ?? 0;
    const yieldCount = Math.ceil(CONVERSATIONS / 20) - 1;
    const yieldOverhead = batch20 - batch500;
    const perYield = yieldOverhead / Math.max(1, yieldCount);
    const bulkDelta = bulkMs - batch500;
    const sourceShare = batch20 === 0 ? 0 : (sourceMs / batch20) * 100;

    console.log(
      [
        '',
        '==== sync 耗时归因 (fake-indexeddb, 中位数) ====',
        `规模: ${CONVERSATIONS} 对话 / ${CONVERSATIONS * MESSAGES_PER_CONV} 消息`,
        `重复次数: sync=${SYNC_REPEATS} source=${SOURCE_REPEATS} generate=${GENERATE_REPEATS} bulk=${BULK_REPEATS}`,
        '',
        '阶段                          中位耗时   占全量',
        `1. 夹具生成                   ${ms(generateMs).padEnd(10)} ${((generateMs / batch20) * 100).toFixed(1)}%`,
        `2. 数据源(list+500 fetch)     ${ms(sourceMs).padEnd(10)} ${sourceShare.toFixed(1)}%`,
        `3. sync 全量 @batch=20        ${ms(batch20).padEnd(10)} 100%（生产默认）`,
        `4. sync 全量 @batch=500       ${ms(batch500).padEnd(10)} ${((batch500 / batch20) * 100).toFixed(1)}%`,
        `5. 单事务 bulk 写全量         ${ms(bulkMs).padEnd(10)} ${((bulkMs / batch20) * 100).toFixed(1)}%`,
        '',
        '推导',
        `A. 分片 overhead (3-4)        ${ms(yieldOverhead)}（${yieldCount} 次让出，每次约 ${ms(
          perYield,
        )}）`,
        `B. 单事务 vs 逐会话事务 (5-4) ${ms(bulkDelta)}${
          bulkDelta > 0 ? '（大事务更慢，反向）' : '（大事务更快）'
        }`,
        `C. 数据源占比 (2/3)           ${sourceShare.toFixed(1)}%`,
        '',
        '结论口径：',
        '- fake-indexeddb 是纯 JS 内存实现，事务/批量写入的性能特征与真实 IndexedDB 不同（此处单事务大写入反而更慢），',
        '  因此**不能**据此决定 M1b 要不要做并发或批量优化；',
        '- 可以在 M1b 用真实 IndexedDB 复测同一拆解（改用本文件同样的计时点），再决定优化方向；',
        '- 禁止把以上数字当性能承诺。',
        '',
      ].join('\n'),
    );

    expect(batch20).toBeGreaterThan(0);
    expect(batch500).toBeGreaterThan(0);
    expect(bulkMs).toBeGreaterThan(0);
  }, 600_000);
});
