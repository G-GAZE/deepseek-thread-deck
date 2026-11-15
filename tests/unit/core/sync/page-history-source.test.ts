import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createPageHistorySource } from '@/core/sync/page-history-source';

const STORE = 'history-message';

interface SeedFragment {
  type: string;
  content: string;
}

interface SeedMessage {
  message_id: number;
  role: string;
  inserted_at: number;
  fragments: SeedFragment[];
}

interface SeedRecord {
  key: string;
  data: {
    chat_session: {
      id: string;
      title: string;
      inserted_at: number;
      updated_at: number;
    };
    chat_messages: SeedMessage[];
  };
}

/** 每个用例用独立库名，避免 fake-indexeddb 跨用例的连接/删除状态互相干扰。 */
function createDbName(): string {
  return `deepseek-chat-${randomUUID()}`;
}

function seedDatabase(dbName: string, records: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [index, record] of records.entries()) {
        store.put(record, `key-${index}`);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function record(overrides: Partial<SeedRecord> = {}): SeedRecord {
  const id = overrides.key ?? randomUUID();
  return {
    key: id,
    data: {
      chat_session: {
        id,
        title: '中文分词方案',
        inserted_at: 1_794_636_911.125,
        updated_at: 1_794_637_132.733,
      },
      chat_messages: [
        {
          message_id: 1,
          role: 'USER',
          inserted_at: 1_794_636_950.56,
          fragments: [{ type: 'REQUEST', content: '游标推进怎么写' }],
        },
        {
          message_id: 2,
          role: 'ASSISTANT',
          inserted_at: 1_794_636_960.12,
          fragments: [
            { type: 'THINK', content: '先确认幂等性' },
            { type: 'TOOL_SEARCH', content: '搜索到 26 个网页' },
            { type: 'RESPONSE', content: '用保守推进 + 幂等 upsert。' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('createPageHistorySource() 可用性与列表', () => {
  it('页面没有 DeepSeek 的库时返回 SOURCE_UNAVAILABLE，而不是抛错', async () => {
    const source = createPageHistorySource({ dbName: createDbName() });

    const list = await source.listConversations();

    expect(list.ok).toBe(false);
    if (list.ok) throw new Error('unreachable');
    expect(list.error.code).toBe('SOURCE_UNAVAILABLE');
  });

  it('没有 indexedDB 时可用性为不可用', async () => {
    const source = createPageHistorySource({ indexedDB: null });

    const availability = await source.getAvailability();

    expect(availability.ok && availability.data.ready).toBe(false);
  });

  it('读取缓存并映射会话摘要（时间戳从秒转毫秒）', async () => {
    const dbName = createDbName();
    await seedDatabase(dbName, [record({ key: 'conv-a' })]);
    const source = createPageHistorySource({ dbName });

    const list = await source.listConversations();

    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error('unreachable');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      remoteId: 'conv-a',
      title: '中文分词方案',
      messageCount: 2,
      createdAt: 1_794_636_911_125,
      updatedAt: 1_794_637_132_733,
    });
  });

  it('跳过结构不合法的记录，不影响其他记录', async () => {
    const dbName = createDbName();
    const broken = { key: 'conv-broken', data: { chat_session: null } };
    await seedDatabase(dbName, [record({ key: 'conv-good' }), broken]);
    const source = createPageHistorySource({ dbName });

    const list = await source.listConversations();

    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error('unreachable');
    expect(list.data.map((item) => item.remoteId)).toEqual(['conv-good']);
  });
});

describe('createPageHistorySource() 消息映射', () => {
  it('角色、正文与思维链按 fragment 类型映射，工具片段被忽略', async () => {
    const dbName = createDbName();
    await seedDatabase(dbName, [record({ key: 'conv-a' })]);
    const source = createPageHistorySource({ dbName });

    const detail = await source.fetchConversation('conv-a');

    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.data.messages).toHaveLength(2);
    expect(detail.data.messages[0]).toMatchObject({
      remoteId: '1',
      role: 'user',
      content: '游标推进怎么写',
      order: 0,
    });
    expect(detail.data.messages[1]).toMatchObject({
      remoteId: '2',
      role: 'assistant',
      content: '用保守推进 + 幂等 upsert。',
      thinking: '先确认幂等性',
      order: 1,
    });
    expect(detail.data.messages[1]?.content).not.toContain('搜索到');
  });

  it('没有 RESPONSE 片段时正文为空但消息仍保留（保留顺序）', async () => {
    const dbName = createDbName();
    const seed = record({ key: 'conv-empty' });
    seed.data.chat_messages = [
      {
        message_id: 1,
        role: 'USER',
        inserted_at: 1_794_636_950,
        fragments: [{ type: 'REQUEST', content: '问题' }],
      },
      {
        message_id: 2,
        role: 'ASSISTANT',
        inserted_at: 1_794_636_960,
        fragments: [{ type: 'THINK', content: '思考中被打断' }],
      },
    ];
    await seedDatabase(dbName, [seed]);
    const source = createPageHistorySource({ dbName });

    const detail = await source.fetchConversation('conv-empty');

    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.data.messages[1]).toMatchObject({
      content: '',
      thinking: '思考中被打断',
      order: 1,
    });
  });

  it('未知会话返回 NOT_FOUND', async () => {
    const dbName = createDbName();
    await seedDatabase(dbName, [record({ key: 'conv-a' })]);
    const source = createPageHistorySource({ dbName });

    const detail = await source.fetchConversation('missing');

    expect(detail.ok).toBe(false);
    if (detail.ok) throw new Error('unreachable');
    expect(detail.error.code).toBe('NOT_FOUND');
  });

  it('列表结果被缓存，重复 fetch 不重复扫描整库', async () => {
    const dbName = createDbName();
    await seedDatabase(dbName, [record({ key: 'conv-a' })]);
    const source = createPageHistorySource({ dbName });
    await source.listConversations();

    const getAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    await source.fetchConversation('conv-a');
    await source.fetchConversation('conv-a');

    expect(getAllSpy).not.toHaveBeenCalled();
    getAllSpy.mockRestore();
  });
});
