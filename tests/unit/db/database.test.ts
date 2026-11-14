import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeckDatabase, openDeckDatabase } from '@/core/db';
import {
  DB_VERSION,
  toMessageKey,
  type ConversationRecord,
  type MessageRecord,
  type ProjectRecord,
} from '@/core/db/schema';

const opened: DeckDatabase[] = [];

async function openTestDb(): Promise<DeckDatabase> {
  const result = await openDeckDatabase(`deck-test-${crypto.randomUUID()}`);
  if (!result.ok) throw new Error(`打开测试数据库失败: ${result.error.code}`);
  opened.push(result.data);
  return result.data;
}

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-1',
    remoteId: 'remote-1',
    title: 'Dexie 迁移怎么写',
    projectId: null,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function message(
  convId: string,
  order: number,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: toMessageKey(convId, `m-${order}`),
    convId,
    role: order % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${order} 条`,
    order,
    attachmentMeta: [],
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (opened.length > 0) {
    const db = opened.pop();
    if (db === undefined) continue;
    db.close();
    await db.delete();
  }
});

describe('openDeckDatabase()', () => {
  it('打开后建出全部表，版本与 schema 一致', async () => {
    const db = await openTestDb();

    expect(db.tables.map((table) => table.name).sort()).toEqual(
      ['conversation', 'fork', 'message', 'project', 'searchIndex'].sort(),
    );
    expect(db.verno).toBe(DB_VERSION);
  });

  it('数据库打开失败时返回 DB_OPEN_FAILED 而不是抛异常', async () => {
    vi.spyOn(DeckDatabase.prototype, 'open').mockRejectedValueOnce(new Error('boom'));

    const result = await openDeckDatabase(`deck-test-${crypto.randomUUID()}`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_OPEN_FAILED');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('boom');
  });
});

describe('表读写', () => {
  it('project / conversation / message 可写入并读回', async () => {
    const db = await openTestDb();
    const project: ProjectRecord = {
      id: 'p-1',
      name: 'DeepSeek 线栈',
      color: '#4d6bfe',
      fileRefs: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    await db.project.add(project);
    await db.conversation.add(conversation({ projectId: project.id }));
    await db.message.bulkAdd([message('conv-1', 0), message('conv-1', 1)]);

    await expect(db.project.get('p-1')).resolves.toEqual(project);
    await expect(db.conversation.get('conv-1')).resolves.toMatchObject({
      projectId: 'p-1',
    });
    await expect(db.message.count()).resolves.toBe(2);
  });

  it('remoteId 唯一索引拦住重复同步', async () => {
    const db = await openTestDb();
    await db.conversation.add(conversation());
    const duplicate = conversation({ id: 'conv-2' });

    await expect(db.conversation.add(duplicate)).rejects.toMatchObject({
      name: 'ConstraintError',
    });
  });

  it('[convId+order] 复合索引按会话隔离且按 order 升序', async () => {
    const db = await openTestDb();
    await db.message.bulkAdd([
      message('conv-1', 2),
      message('conv-1', 0),
      message('conv-1', 1),
      message('conv-2', 0),
    ]);

    const rows = await db.message
      .where('[convId+order]')
      .between(['conv-1', 0], ['conv-1', Number.MAX_SAFE_INTEGER])
      .toArray();

    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.convId === 'conv-1')).toBe(true);
  });

  it('tags 多值索引可按标签命中', async () => {
    const db = await openTestDb();
    await db.conversation.bulkAdd([
      conversation({ id: 'conv-1', remoteId: 'remote-1', tags: ['dexie', '检索'] }),
      conversation({ id: 'conv-2', remoteId: 'remote-2', tags: ['ui'] }),
    ]);

    const rows = await db.conversation.where('tags').equals('dexie').toArray();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('conv-1');
  });
});
