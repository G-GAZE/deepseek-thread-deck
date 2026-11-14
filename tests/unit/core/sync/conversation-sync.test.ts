import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDeckDatabase, type DeckDatabase } from '@/core/db';
import { createConversationSync } from '@/core/sync/conversation-sync';
import { SYNC_CURSOR_KEY, createCursorStorage } from '@/core/sync/cursor';
import { SYNC_LOCK_KEY, createStorageLock } from '@/core/sync/lock';
import type { ConversationSync, RemoteConversationDetail, RemoteSource } from '@/core/sync/types';
import { resolveFlags, type FeatureFlagName } from '@/shared/feature-flags';
import { ok, type CoreErrorCode } from '@/shared/result';

import { createFixtureSource, type FixtureSource } from '../../../fixtures/fixture-source';
import type { FixtureConversation, FixtureMessage } from '../../../fixtures/generate-fixtures';
import { createMemoryStorage, type MemoryStorage } from '../../helpers/memory-storage';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

function message(
  convIndex: number,
  order: number,
  overrides: Partial<FixtureMessage> = {},
): FixtureMessage {
  return {
    remoteId: `m-${convIndex}-${order}`,
    role: order % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${convIndex} 个会话的第 ${order} 条`,
    order,
    ...overrides,
  };
}

function conversation(
  index: number,
  overrides: Partial<FixtureConversation> = {},
): FixtureConversation {
  const createdAt = 1_700_000_000_000 + index * 60_000;
  return {
    remoteId: `conv-${index}`,
    title: `会话 ${index}`,
    createdAt,
    updatedAt: createdAt,
    messageCount: 2,
    messages: [message(index, 0), message(index, 1)],
    ...overrides,
  };
}

interface Harness {
  db: DeckDatabase;
  source: FixtureSource;
  memory: MemoryStorage;
  sync: ConversationSync;
}

interface HarnessOptions {
  flags?: Partial<Record<FeatureFlagName, boolean>>;
  unavailableReason?: CoreErrorCode;
  failList?: CoreErrorCode;
  failFetch?: Record<string, CoreErrorCode>;
  onFetch?: (remoteId: string) => void;
  now?: () => number;
  /** 用自定义 RemoteSource 取代夹具（用于构造不合规返回等边界） */
  customSource?: RemoteSource;
}

async function setup(
  conversations: FixtureConversation[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const opened = await openDeckDatabase(`sync-test-${randomUUID()}`);
  if (!opened.ok) throw new Error(`打开测试数据库失败: ${opened.error.code}`);
  const db = opened.data;
  cleanups.push(async () => {
    db.close();
    await db.delete();
  });

  const memory = createMemoryStorage();
  const fixture = createFixtureSource({
    conversations,
    unavailableReason: options.unavailableReason,
    failList: options.failList,
    failFetch: options.failFetch,
    onFetch: options.onFetch,
  });
  const sync = createConversationSync({
    source: options.customSource ?? fixture,
    db,
    flags: resolveFlags(options.flags ?? {}),
    cursor: createCursorStorage(memory),
    lock: createStorageLock(memory),
    now: options.now,
  });

  return { db, source: fixture, memory, sync };
}

describe('syncAll() 前置校验', () => {
  it('readonlySyncEnabled 关闭时直接返回 SYNC_DISABLED，不读页面不写库', async () => {
    const { sync, db, source } = await setup([conversation(0)], {
      flags: { readonlySyncEnabled: false },
    });

    const result = await sync.syncAll();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SYNC_DISABLED');
    expect(source.listCalls()).toBe(0);
    await expect(db.conversation.count()).resolves.toBe(0);
  });

  it('选择器不可用时返回原因码，不写库', async () => {
    const { sync, db } = await setup([conversation(0)], {
      unavailableReason: 'SELECTOR_MISSING',
    });

    const result = await sync.syncAll();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SELECTOR_MISSING');
    await expect(db.conversation.count()).resolves.toBe(0);
  });

  it('listConversations 失败时整体失败，不写库', async () => {
    const { sync, db } = await setup([conversation(0)], { failList: 'SOURCE_UNAVAILABLE' });

    const result = await sync.syncAll();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SOURCE_UNAVAILABLE');
    await expect(db.conversation.count()).resolves.toBe(0);
  });
});

describe('syncAll() 全量同步', () => {
  it('写入会话与消息，并返回准确的汇总', async () => {
    const { sync, db } = await setup([conversation(0), conversation(1), conversation(2)]);

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.total).toBe(3);
    expect(result.data.synced).toBe(3);
    expect(result.data.skipped).toBe(0);
    expect(result.data.failed).toEqual([]);
    expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
    await expect(db.conversation.count()).resolves.toBe(3);
    await expect(db.message.count()).resolves.toBe(6);
  });

  it('新建会话以 remoteId 作为主键，projectId 为 null、tags 为空', async () => {
    const { sync, db } = await setup([conversation(0)]);

    await sync.syncAll();

    const stored = await db.conversation.get('conv-0');
    expect(stored).toMatchObject({
      id: 'conv-0',
      remoteId: 'conv-0',
      projectId: null,
      tags: [],
    });
  });

  it('空会话（0 条消息）也能同步成功', async () => {
    const { sync, db } = await setup([conversation(0, { messages: [], messageCount: 0 })]);

    const result = await sync.syncAll();

    expect(result.ok && result.data.synced).toBe(1);
    await expect(db.message.count()).resolves.toBe(0);
  });

  it('不写 searchIndex 表（与检索层解耦）', async () => {
    const { sync, db } = await setup([conversation(0)]);

    await sync.syncAll();

    await expect(db.searchIndex.count()).resolves.toBe(0);
  });

  it('重复标题不影响身份判定，两条都同步', async () => {
    const { sync, db } = await setup([
      conversation(0, { title: '同一个标题' }),
      conversation(1, { title: '同一个标题' }),
    ]);

    const result = await sync.syncAll();

    expect(result.ok && result.data.synced).toBe(2);
    await expect(db.conversation.count()).resolves.toBe(2);
  });

  it('同批重复 remoteId 只处理第一条，其余计入 skipped', async () => {
    const duplicate = conversation(0, { title: '重复的' });
    const { sync, source } = await setup([conversation(0), duplicate]);

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.total).toBe(2);
    expect(result.data.synced).toBe(1);
    expect(result.data.skipped).toBe(1);
    expect(source.fetchCalls).toEqual(['conv-0']);
  });
});

describe('syncAll() 内容保真', () => {
  it('保留 thinking 与 attachmentMeta', async () => {
    const rich = conversation(0, {
      messages: [
        message(0, 0, {
          thinking: '先验证约束',
          attachmentMeta: [{ name: 'a.pdf', mimeType: 'application/pdf', size: 1024 }],
        }),
      ],
    });
    const { sync, db } = await setup([rich]);

    await sync.syncAll();

    const stored = await db.message.get('conv-0:m-0-0');
    expect(stored?.thinking).toBe('先验证约束');
    expect(stored?.attachmentMeta).toEqual([
      { name: 'a.pdf', mimeType: 'application/pdf', size: 1024 },
    ]);
  });

  it('没有 thinking / attachmentMeta 时不凭空补字段', async () => {
    const { sync, db } = await setup([conversation(0)]);

    await sync.syncAll();

    const stored = await db.message.get('conv-0:m-0-0');
    expect(stored).toBeDefined();
    expect(stored?.thinking).toBeUndefined();
    expect(stored?.attachmentMeta).toEqual([]);
  });

  it('100KB 超长消息原样保留', async () => {
    const long = 'x'.repeat(100_000);
    const { sync, db } = await setup([
      conversation(0, { messages: [message(0, 0, { content: long })] }),
    ]);

    await sync.syncAll();

    await expect(db.message.get('conv-0:m-0-0')).resolves.toMatchObject({ content: long });
  });

  it('中英 emoji 特殊字符混合原样保留', async () => {
    const mixed = '中文 English 😀🚀 「引号」 <tag> & *markdown*';
    const { sync, db } = await setup([
      conversation(0, { messages: [message(0, 0, { content: mixed })] }),
    ]);

    await sync.syncAll();

    await expect(db.message.get('conv-0:m-0-0')).resolves.toMatchObject({ content: mixed });
  });

  it('order 不连续、起始非 0 时按远端原值保存', async () => {
    const { sync, db } = await setup([
      conversation(0, {
        messages: [
          message(0, 9, { remoteId: 'm-0-9' }),
          message(0, 5, { remoteId: 'm-0-5' }),
          message(0, 2, { remoteId: 'm-0-2' }),
        ],
      }),
    ]);

    await sync.syncAll();

    const rows = await db.message
      .where('[convId+order]')
      .between(['conv-0', -Infinity], ['conv-0', Infinity])
      .toArray();
    expect(rows.map((row) => row.order)).toEqual([2, 5, 9]);
  });
});

describe('syncAll() 幂等与增量', () => {
  it('全量重跑不会产生重复数据，会话主键保持不变', async () => {
    const { sync, db, source } = await setup([conversation(0), conversation(1)]);
    await sync.syncAll();

    await db.conversation.update('conv-0', { title: '远端旧标题' });
    source.updateConversation('conv-1', { title: '远端新标题' });
    const second = await sync.syncAll({ full: true });

    expect(second.ok && second.data.synced).toBe(2);
    await expect(db.conversation.count()).resolves.toBe(2);
    await expect(db.message.count()).resolves.toBe(4);
    await expect(db.conversation.get('conv-1')).resolves.toMatchObject({
      id: 'conv-1',
      title: '远端新标题',
    });
  });

  it('本地 projectId / tags 不被同步覆盖', async () => {
    const { sync, db } = await setup([conversation(0)]);
    await sync.syncAll();
    await db.conversation.update('conv-0', { projectId: 'project-1', tags: ['重要'] });

    await sync.syncAll({ full: true });

    await expect(db.conversation.get('conv-0')).resolves.toMatchObject({
      id: 'conv-0',
      projectId: 'project-1',
      tags: ['重要'],
    });
  });

  it('增量同步跳过 updatedAt 未前进的会话', async () => {
    const { sync, source } = await setup([conversation(0), conversation(1), conversation(2)]);
    await sync.syncAll();

    const second = await sync.syncAll();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.data.synced).toBe(0);
    expect(second.data.skipped).toBe(3);

    source.updateConversation('conv-1', { updatedAt: 1_900_000_000_000 });
    const third = await sync.syncAll();
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('unreachable');
    expect(third.data.synced).toBe(1);
    expect(third.data.skipped).toBe(2);
    expect(source.fetchCalls).toHaveLength(4);
  });

  it('游标内容为最后成功会话的最大 updatedAt', async () => {
    const { sync, memory } = await setup([conversation(0), conversation(5)]);

    await sync.syncAll();

    expect(memory.entries.get(SYNC_CURSOR_KEY)).toMatchObject({
      schemaVersion: 1,
      lastSyncedAt: 1_700_000_000_000 + 5 * 60_000,
    });
  });

  it('游标损坏时退回全量同步', async () => {
    const { sync, db, memory } = await setup([conversation(0)]);
    memory.entries.set(SYNC_CURSOR_KEY, 'broken');

    const result = await sync.syncAll();

    expect(result.ok && result.data.synced).toBe(1);
    await expect(db.conversation.count()).resolves.toBe(1);
  });
});

describe('syncAll() 部分失败', () => {
  it('单会话失败不影响其他会话，整体仍 ok', async () => {
    const { sync, db } = await setup([conversation(0), conversation(1), conversation(2)], {
      failFetch: { 'conv-1': 'SOURCE_PARSE_FAILED' },
    });

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.synced).toBe(2);
    expect(result.data.failed).toEqual([
      { remoteId: 'conv-1', reason: 'SOURCE_PARSE_FAILED: 模拟 conv-1 读取失败' },
    ]);
    await expect(db.conversation.count()).resolves.toBe(2);
  });

  it('失败时游标不推进，下次重跑能补上（不会永不重试）', async () => {
    const { sync, source, memory } = await setup([conversation(0), conversation(1)], {
      failFetch: { 'conv-1': 'SOURCE_UNAVAILABLE' },
    });

    const first = await sync.syncAll();
    expect(first.ok && first.data.synced).toBe(1);
    expect(memory.entries.has(SYNC_CURSOR_KEY)).toBe(false);

    source.failFetchFor('conv-1', null);
    const second = await sync.syncAll();

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.data.synced).toBe(2);
    expect(second.data.failed).toEqual([]);
  });

  it('写库失败时该会话回滚并计入 failed', async () => {
    const { sync, db } = await setup([conversation(0)]);
    vi.spyOn(db.message, 'bulkPut').mockRejectedValueOnce(new Error('磁盘已满'));

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.failed).toHaveLength(1);
    expect(result.data.failed[0]?.reason).toContain('DB_WRITE_FAILED');
    await expect(db.conversation.count()).resolves.toBe(0);
  });

  it('全部失败时仍返回 ok，failed 覆盖全部会话，游标不推进', async () => {
    const { sync, memory } = await setup([conversation(0), conversation(1)], {
      failFetch: { 'conv-0': 'SOURCE_UNAVAILABLE', 'conv-1': 'SOURCE_UNAVAILABLE' },
    });

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.synced).toBe(0);
    expect(result.data.failed).toHaveLength(2);
    expect(memory.entries.has(SYNC_CURSOR_KEY)).toBe(false);
  });
});

describe('syncAll() 异常返回与降级', () => {
  function mismatchSource(): RemoteSource {
    const detail: RemoteConversationDetail = {
      remoteId: 'conv-other',
      title: '串号会话',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messageCount: 1,
      messages: [{ remoteId: 'm-x', role: 'user', content: '内容', order: 0 }],
    };

    return {
      async getAvailability() {
        return ok({ ready: true });
      },
      async listConversations() {
        return ok([
          {
            remoteId: 'conv-0',
            title: '串号会话',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            messageCount: 1,
          },
        ]);
      },
      async fetchConversation() {
        return ok(detail);
      },
    };
  }

  it('远端返回的 remoteId 与请求不一致时计入 failed，不写入错误数据', async () => {
    const { sync, db } = await setup([], { customSource: mismatchSource() });

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.synced).toBe(0);
    expect(result.data.failed[0]?.reason).toContain('SOURCE_PARSE_FAILED');
    await expect(db.conversation.count()).resolves.toBe(0);
  });

  it('syncConversation 遇到串号返回 SOURCE_PARSE_FAILED', async () => {
    const { sync } = await setup([], { customSource: mismatchSource() });

    const result = await sync.syncConversation('conv-0');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SOURCE_PARSE_FAILED');
  });

  it('游标读取失败时退化为全量同步，不阻塞', async () => {
    const { sync, memory, db } = await setup([conversation(0)]);
    memory.failNextReadFor(SYNC_CURSOR_KEY, new Error('cursor io error'));

    const result = await sync.syncAll();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.synced).toBe(1);
    await expect(db.conversation.count()).resolves.toBe(1);
  });

  it('数据库读取失败时 getStatus 返回 DB_READ_FAILED', async () => {
    const { sync, db } = await setup([conversation(0)]);
    vi.spyOn(db.conversation, 'count').mockRejectedValueOnce(new Error('db closed'));

    const status = await sync.getStatus();

    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('unreachable');
    expect(status.error.code).toBe('DB_READ_FAILED');
  });
});

describe('syncAll() 取消', () => {
  it('中途取消返回 cancelled 且游标不推进', async () => {
    const controller = new AbortController();
    let fetched = 0;
    const { sync, memory } = await setup(
      [conversation(0), conversation(1), conversation(2), conversation(3)],
      {
        onFetch: () => {
          fetched += 1;
          if (fetched === 2) controller.abort();
        },
      },
    );

    const result = await sync.syncAll({ signal: controller.signal, batchSize: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.cancelled).toBe(2);
    expect(result.data.synced).toBe(2);
    expect(memory.entries.has(SYNC_CURSOR_KEY)).toBe(false);
  });

  it('同批内取消：批内第一条后中止，剩余会话不再读取', async () => {
    const controller = new AbortController();
    const { sync, source, memory } = await setup(
      [conversation(0), conversation(1), conversation(2)],
      {
        onFetch: () => {
          controller.abort();
        },
      },
    );

    const result = await sync.syncAll({ signal: controller.signal, batchSize: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.cancelled).toBe(2);
    expect(result.data.synced).toBe(1);
    expect(source.fetchCalls).toEqual(['conv-0']);
    expect(memory.entries.has(SYNC_CURSOR_KEY)).toBe(false);
  });

  it('未取消时 cancelled 恒为 0', async () => {
    const { sync } = await setup([conversation(0)]);

    const result = await sync.syncAll();

    expect(result.ok && result.data.cancelled).toBe(0);
  });

  it('开始前已取消：返回 SYNC_CANCELLED，不读页面不写库', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sync, source, db } = await setup([conversation(0)]);

    const result = await sync.syncAll({ signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SYNC_CANCELLED');
    expect(result.error.retryable).toBe(true);
    expect(source.listCalls()).toBe(0);
    await expect(db.conversation.count()).resolves.toBe(0);
  });
});

describe('syncAll() 多标签页互斥锁', () => {
  it('其他标签页持锁时返回 SYNC_IN_PROGRESS，不读页面', async () => {
    const { sync, source, memory } = await setup([conversation(0)]);
    memory.entries.set(SYNC_LOCK_KEY, {
      owner: 'other-tab',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    });

    const result = await sync.syncAll();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SYNC_IN_PROGRESS');
    expect(result.error.retryable).toBe(true);
    expect(source.listCalls()).toBe(0);
  });

  it('同步成功后释放锁，后续同步可再次进入', async () => {
    const { sync, memory } = await setup([conversation(0)]);

    await sync.syncAll();
    expect(memory.entries.has(SYNC_LOCK_KEY)).toBe(false);

    const second = await sync.syncAll({ full: true });
    expect(second.ok).toBe(true);
  });

  it('同步失败也释放锁，不会把用户锁死', async () => {
    const { sync, memory } = await setup([conversation(0)], { failList: 'SOURCE_UNAVAILABLE' });

    await sync.syncAll();

    expect(memory.entries.has(SYNC_LOCK_KEY)).toBe(false);
  });
});

describe('syncConversation()', () => {
  it('只同步指定会话，不写游标', async () => {
    const { sync, db, memory } = await setup([conversation(0), conversation(1)]);

    const result = await sync.syncConversation('conv-1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.synced).toBe(1);
    await expect(db.conversation.count()).resolves.toBe(1);
    await expect(db.conversation.get('conv-1')).resolves.toBeDefined();
    expect(memory.entries.has(SYNC_CURSOR_KEY)).toBe(false);
  });

  it('失败时返回错误码而不是空结果', async () => {
    const { sync } = await setup([conversation(0)], {
      failFetch: { 'conv-0': 'SOURCE_PARSE_FAILED' },
    });

    const result = await sync.syncConversation('conv-0');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SOURCE_PARSE_FAILED');
  });

  it('写库失败时返回 DB_WRITE_FAILED 并回滚该会话', async () => {
    const { sync, db } = await setup([conversation(0)]);
    vi.spyOn(db.message, 'bulkPut').mockRejectedValueOnce(new Error('写放大'));

    const result = await sync.syncConversation('conv-0');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
    await expect(db.conversation.count()).resolves.toBe(0);
  });
});

describe('getStatus()', () => {
  it('返回计数、选择器状态与最后同步时间', async () => {
    const { sync } = await setup([conversation(0), conversation(1)]);
    await sync.syncAll();

    const status = await sync.getStatus();

    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error('unreachable');
    expect(status.data.conversationCount).toBe(2);
    expect(status.data.messageCount).toBe(4);
    expect(status.data.selectorsReady).toBe(true);
    expect(status.data.lastSyncedAt).toBe(1_700_000_000_000 + 60_000);
  });

  it('选择器不可用时 selectorsReady 为 false', async () => {
    const { sync, source } = await setup([conversation(0)]);
    source.setUnavailable('SELECTOR_MISSING');

    const status = await sync.getStatus();

    expect(status.ok && status.data.selectorsReady).toBe(false);
    expect(status.ok && status.data.lastSyncedAt).toBeNull();
  });
});
