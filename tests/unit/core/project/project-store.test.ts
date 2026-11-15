import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDeckDatabase, type DeckDatabase } from '@/core/db';
import { toMessageKey } from '@/core/db/schema';
import { createProjectStore } from '@/core/project/project-store';
import type { ProjectStore } from '@/core/project/types';

const NOW = 1_800_000_000_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

interface Harness {
  db: DeckDatabase;
  store: ProjectStore;
}

async function setup(conversationCount = 0): Promise<Harness> {
  const opened = await openDeckDatabase(`project-test-${randomUUID()}`);
  if (!opened.ok) throw new Error(`打开测试数据库失败: ${opened.error.code}`);
  const db = opened.data;
  cleanups.push(async () => {
    db.close();
    await db.delete();
  });

  for (let index = 0; index < conversationCount; index += 1) {
    await db.conversation.add({
      id: `conv-${index}`,
      remoteId: `conv-${index}`,
      title: `会话 ${index}`,
      projectId: null,
      tags: [],
      createdAt: NOW + index,
      updatedAt: NOW + index,
    });
  }

  return { db, store: createProjectStore({ db, now: () => NOW }) };
}

describe('createProject()', () => {
  it('创建成功并返回完整记录', async () => {
    const { store, db } = await setup();

    const result = await store.createProject({ name: '  线栈项目  ', color: '#4d6bfe' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data).toMatchObject({
      name: '线栈项目',
      color: '#4d6bfe',
      fileRefs: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.data.preset).toBeUndefined();
    expect(result.data.id.length).toBeGreaterThan(0);
    await expect(db.project.count()).resolves.toBe(1);
  });

  it('空名与纯空白名返回 INVALID_ARGUMENT', async () => {
    const { store } = await setup();

    for (const name of ['', '   ']) {
      const result = await store.createProject({ name });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('超过 60 字返回 INVALID_ARGUMENT', async () => {
    const { store } = await setup();

    const result = await store.createProject({ name: '名'.repeat(61) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('允许重名（身份是 id）', async () => {
    const { store } = await setup();

    const first = await store.createProject({ name: '同名' });
    const second = await store.createProject({ name: '同名' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.data.id).not.toBe(second.data.id);
  });
});

describe('listTree()', () => {
  it('空库返回空项目与 0 个未分类', async () => {
    const { store } = await setup();

    const result = await store.listTree();

    expect(result).toEqual({ ok: true, data: { projects: [], uncategorizedCount: 0 } });
  });

  it('返回项目与会话计数，并统计未分类', async () => {
    const { store } = await setup(3);
    const project = await store.createProject({ name: '项目 A' });
    if (!project.ok) throw new Error('unreachable');
    await store.assignConversation('conv-0', project.data.id);
    await store.assignConversation('conv-1', project.data.id);

    const result = await store.listTree();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.projects).toEqual([
      {
        id: project.data.id,
        name: '项目 A',
        color: undefined,
        conversationCount: 2,
      },
    ]);
    expect(result.data.uncategorizedCount).toBe(1);
  });

  it('项目按 createdAt 升序排列', async () => {
    const opened = await openDeckDatabase(`project-order-${randomUUID()}`);
    if (!opened.ok) throw new Error('unreachable');
    const db = opened.data;
    cleanups.push(async () => {
      db.close();
      await db.delete();
    });

    let tick = NOW;
    const store = createProjectStore({ db, now: () => (tick += 1000) });
    await store.createProject({ name: 'B' });
    await store.createProject({ name: 'A' });

    const result = await store.listTree();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.projects.map((node) => node.name)).toEqual(['B', 'A']);
  });
});

describe('renameProject()', () => {
  it('改名并刷新 updatedAt', async () => {
    const { store, db } = await setup();
    const created = await store.createProject({ name: '旧名' });
    if (!created.ok) throw new Error('unreachable');

    const result = await store.renameProject(created.data.id, '  新名  ');

    expect(result.ok).toBe(true);
    await expect(db.project.get(created.data.id)).resolves.toMatchObject({
      name: '新名',
      updatedAt: NOW,
    });
  });

  it('项目不存在返回 NOT_FOUND', async () => {
    const { store } = await setup();

    const result = await store.renameProject('missing', '新名');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('空名返回 INVALID_ARGUMENT', async () => {
    const { store } = await setup();
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    const result = await store.renameProject(created.data.id, '  ');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('assignConversation()', () => {
  it('分配到项目后列表计数随之变化', async () => {
    const { store, db } = await setup(2);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    await store.assignConversation('conv-0', created.data.id);

    await expect(db.conversation.get('conv-0')).resolves.toMatchObject({
      projectId: created.data.id,
      // 本地分类不改远端字段
      updatedAt: NOW,
    });
    const tree = await store.listTree();
    expect(tree.ok && tree.data.projects[0]?.conversationCount).toBe(1);
    expect(tree.ok && tree.data.uncategorizedCount).toBe(1);
  });

  it('传 null 退回未分类', async () => {
    const { store } = await setup(1);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    await store.assignConversation('conv-0', created.data.id);

    await store.assignConversation('conv-0', null);

    const tree = await store.listTree();
    expect(tree.ok && tree.data.projects[0]?.conversationCount).toBe(0);
    expect(tree.ok && tree.data.uncategorizedCount).toBe(1);
  });

  it('幂等：重复分配同一项目不报错也不重复计数', async () => {
    const { store } = await setup(1);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    await store.assignConversation('conv-0', created.data.id);
    const again = await store.assignConversation('conv-0', created.data.id);

    expect(again.ok).toBe(true);
    const tree = await store.listTree();
    expect(tree.ok && tree.data.projects[0]?.conversationCount).toBe(1);
  });

  it('项目不存在返回 NOT_FOUND', async () => {
    const { store } = await setup(1);

    const result = await store.assignConversation('conv-0', 'missing');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('会话不存在返回 NOT_FOUND', async () => {
    const { store } = await setup();
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    const result = await store.assignConversation('missing', created.data.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('deleteProject()', () => {
  it('删除项目时其会话回落未分类，并返回受影响 id', async () => {
    const { store, db } = await setup(3);
    const created = await store.createProject({ name: '待删项目' });
    if (!created.ok) throw new Error('unreachable');
    await store.assignConversation('conv-0', created.data.id);
    await store.assignConversation('conv-2', created.data.id);

    const result = await store.deleteProject(created.data.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect([...result.data.affectedConvIds].sort()).toEqual(['conv-0', 'conv-2']);
    await expect(db.project.get(created.data.id)).resolves.toBeUndefined();
    await expect(db.conversation.get('conv-0')).resolves.toMatchObject({ projectId: null });
    const tree = await store.listTree();
    expect(tree.ok && tree.data.uncategorizedCount).toBe(3);
  });

  it('项目不存在返回 NOT_FOUND', async () => {
    const { store } = await setup();

    const result = await store.deleteProject('missing');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('删除失败时事务回滚，会话不会被置空', async () => {
    const { store, db } = await setup(1);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    await store.assignConversation('conv-0', created.data.id);
    vi.spyOn(db.project, 'delete').mockRejectedValueOnce(new Error('写失败'));

    const result = await store.deleteProject(created.data.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
    await expect(db.conversation.get('conv-0')).resolves.toMatchObject({
      projectId: created.data.id,
    });
    await expect(db.project.get(created.data.id)).resolves.toBeDefined();
  });
});

describe('listConversations()', () => {
  it('按项目过滤并按 updatedAt 倒序', async () => {
    const { store } = await setup(3);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    await store.assignConversation('conv-0', created.data.id);
    await store.assignConversation('conv-2', created.data.id);

    const result = await store.listConversations(created.data.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.map((conversation) => conversation.id)).toEqual(['conv-2', 'conv-0']);
  });

  it('传 null 返回未分类会话', async () => {
    const { store } = await setup(2);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    await store.assignConversation('conv-1', created.data.id);

    const result = await store.listConversations(null);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.map((conversation) => conversation.id)).toEqual(['conv-0']);
  });
});

describe('校验与错误路径', () => {
  it('颜色为空串时不写入 color 字段', async () => {
    const { store } = await setup();

    const result = await store.createProject({ name: '项目', color: '   ' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.color).toBeUndefined();
  });

  it('颜色超长返回 INVALID_ARGUMENT', async () => {
    const { store } = await setup();

    const result = await store.createProject({ name: '项目', color: 'x'.repeat(33) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('createdAt 相同时按 id 稳定排序', async () => {
    const opened = await openDeckDatabase(`project-tie-${randomUUID()}`);
    if (!opened.ok) throw new Error('unreachable');
    const db = opened.data;
    cleanups.push(async () => {
      db.close();
      await db.delete();
    });
    const store = createProjectStore({ db, now: () => NOW });
    await store.createProject({ name: '甲' });
    await store.createProject({ name: '乙' });

    const result = await store.listTree();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const ids = result.data.projects.map((node) => node.id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
  });

  it('创建写失败返回 DB_WRITE_FAILED', async () => {
    const { store, db } = await setup();
    vi.spyOn(db.project, 'add').mockRejectedValueOnce(new Error('写失败'));

    const result = await store.createProject({ name: '项目' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });

  it('listTree 读失败返回 DB_READ_FAILED', async () => {
    const { store, db } = await setup();
    vi.spyOn(db.project, 'toArray').mockRejectedValueOnce(new Error('读失败'));

    const result = await store.listTree();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_READ_FAILED');
  });

  it('rename 写失败返回 DB_WRITE_FAILED', async () => {
    const { store, db } = await setup();
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    vi.spyOn(db.project, 'update').mockRejectedValueOnce(new Error('写失败'));

    const result = await store.renameProject(created.data.id, '新名');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });

  it('assign 写失败返回 DB_WRITE_FAILED', async () => {
    const { store, db } = await setup(1);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');
    vi.spyOn(db.conversation, 'update').mockRejectedValueOnce(new Error('写失败'));

    const result = await store.assignConversation('conv-0', created.data.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });

  it('listConversations 读失败返回 DB_READ_FAILED', async () => {
    const { store, db } = await setup(1);
    // 未分类分支走 filter()，故拦截 filter 而不是 toArray
    vi.spyOn(db.conversation, 'filter').mockImplementationOnce(() => {
      throw new Error('读失败');
    });

    const result = await store.listConversations(null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_READ_FAILED');
  });
});

describe('规模与一致性', () => {
  it('500 个会话的计数与未分类统计一致', async () => {
    const { store, db } = await setup(500);
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    await db.conversation
      .where('id')
      .anyOf(Array.from({ length: 120 }, (_, index) => `conv-${index}`))
      .modify({ projectId: created.data.id });

    const tree = await store.listTree();

    expect(tree.ok).toBe(true);
    if (!tree.ok) throw new Error('unreachable');
    expect(tree.data.projects[0]?.conversationCount).toBe(120);
    expect(tree.data.uncategorizedCount).toBe(380);
  });

  it('会话消息主键不受项目操作影响（隔离性）', async () => {
    const { store, db } = await setup(1);
    await db.message.add({
      id: toMessageKey('conv-0', 'm0'),
      convId: 'conv-0',
      role: 'user',
      content: '正文',
      order: 0,
      attachmentMeta: [],
    });
    const created = await store.createProject({ name: '项目' });
    if (!created.ok) throw new Error('unreachable');

    await store.assignConversation('conv-0', created.data.id);
    await store.deleteProject(created.data.id);

    await expect(db.message.count()).resolves.toBe(1);
  });
});
