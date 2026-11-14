import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDeckDatabase, type DeckDatabase } from '@/core/db';
import { toMessageKey } from '@/core/db/schema';
import { createSearchIndex } from '@/core/search/search-index';
import type { SearchEngine, SearchIndex } from '@/core/search/types';
import { resolveFlags, type FeatureFlagName } from '@/shared/feature-flags';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

interface SeedMessage {
  remoteId: string;
  content: string;
  thinking?: string;
}

interface SeedConversation {
  id: string;
  title: string;
  projectId?: string | null;
  messages?: SeedMessage[];
}

async function seedConversation(db: DeckDatabase, seed: SeedConversation): Promise<void> {
  await db.conversation.add({
    id: seed.id,
    remoteId: seed.id,
    title: seed.title,
    projectId: seed.projectId ?? null,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });

  const messages = seed.messages ?? [];
  if (messages.length > 0) {
    await db.message.bulkAdd(
      messages.map((message, order) => ({
        id: toMessageKey(seed.id, message.remoteId),
        convId: seed.id,
        role: order % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: message.content,
        order,
        attachmentMeta: [],
        ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
      })),
    );
  }
}

interface Harness {
  db: DeckDatabase;
  index: SearchIndex;
}

async function setup(
  seeds: SeedConversation[],
  options: {
    flags?: Partial<Record<FeatureFlagName, boolean>>;
    engineFactory?: () => SearchEngine;
  } = {},
): Promise<Harness> {
  const opened = await openDeckDatabase(`search-test-${randomUUID()}`);
  if (!opened.ok) throw new Error(`打开测试数据库失败: ${opened.error.code}`);
  const db = opened.data;
  cleanups.push(async () => {
    db.close();
    await db.delete();
  });

  for (const seed of seeds) {
    await seedConversation(db, seed);
  }

  const index = createSearchIndex({
    db,
    flags: resolveFlags(options.flags ?? {}),
    engineFactory: options.engineFactory,
  });

  return { db, index };
}

describe('rebuild()', () => {
  it('只写 searchIndex 表，不动 conversation / message', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '中文分词方案', messages: [{ remoteId: 'm1', content: '分词实现细节' }] },
    ]);
    const conversationCountBefore = await db.conversation.count();
    const messageCountBefore = await db.message.count();

    const result = await index.rebuild();

    expect(result.ok).toBe(true);
    await expect(db.searchIndex.count()).resolves.toBeGreaterThan(0);
    await expect(db.conversation.count()).resolves.toBe(conversationCountBefore);
    await expect(db.message.count()).resolves.toBe(messageCountBefore);
  });

  it('连续两次 rebuild 结果幂等', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '会话一', messages: [{ remoteId: 'm1', content: '内容一' }] },
    ]);

    await index.rebuild();
    const first = await db.searchIndex.count();
    await index.rebuild();

    await expect(db.searchIndex.count()).resolves.toBe(first);
  });

  it('空数据库 rebuild 成功', async () => {
    const { index } = await setup([]);

    await expect(index.rebuild()).resolves.toEqual({ ok: true, data: undefined });
  });
});

describe('search() 命中', () => {
  it('命中会话标题', async () => {
    const { index } = await setup([
      { id: 'c1', title: '中文分词方案', messages: [{ remoteId: 'm1', content: '无关内容' }] },
    ]);

    const result = await index.search('分词方案');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]?.convId).toBe('c1');
    expect(result.data[0]?.title).toBe('中文分词方案');
  });

  it('命中正文中文词，并给出对应 messageId 与含关键词的摘要', async () => {
    const { index } = await setup([
      {
        id: 'c1',
        title: '同步设计',
        messages: [
          { remoteId: 'm1', content: '游标推进要保守，避免失败后永不重试' },
          { remoteId: 'm2', content: '索引重建与数据写入解耦' },
        ],
      },
    ]);

    const result = await index.search('游标');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const hit = result.data[0];
    expect(hit?.convId).toBe('c1');
    expect(hit?.messageId).toBe('c1:m1');
    expect(hit?.snippet).toContain('游标');
  });

  it('思维链内容也能被检索到（PRD 要求正文 + 思维链）', async () => {
    const { index } = await setup([
      {
        id: 'c1',
        title: '无关标题',
        messages: [{ remoteId: 'm1', content: '普通回答', thinking: '这里推导了幂等性' }],
      },
    ]);

    const result = await index.search('幂等性');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
  });

  it('0 消息会话的标题仍可命中（会话级文档）', async () => {
    const { index } = await setup([{ id: 'c1', title: '空会话标题也检索', messages: [] }]);

    const result = await index.search('空会话标题');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data[0]?.convId).toBe('c1');
    expect(result.data[0]?.messageId).toBeUndefined();
  });

  it('结果按分数降序排列', async () => {
    const { index } = await setup([
      { id: 'c1', title: '检索优化', messages: [{ remoteId: 'm1', content: '检索优化检索优化' }] },
      { id: 'c2', title: '检索', messages: [{ remoteId: 'm2', content: '随便写点检索' }] },
    ]);

    const result = await index.search('检索');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const scores = result.data.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('limit 生效', async () => {
    const { index } = await setup([
      { id: 'c1', title: '检索 A', messages: [{ remoteId: 'm1', content: '检索' }] },
      { id: 'c2', title: '检索 B', messages: [{ remoteId: 'm2', content: '检索' }] },
      { id: 'c3', title: '检索 C', messages: [{ remoteId: 'm3', content: '检索' }] },
    ]);

    const result = await index.search('检索', { limit: 2 });

    expect(result.ok && result.data).toHaveLength(2);
  });

  it('按 projectId 过滤', async () => {
    const { index } = await setup([
      {
        id: 'c1',
        title: '项目一话题',
        projectId: 'p1',
        messages: [{ remoteId: 'm1', content: '共同关键词' }],
      },
      {
        id: 'c2',
        title: '项目二话题',
        projectId: 'p2',
        messages: [{ remoteId: 'm2', content: '共同关键词' }],
      },
    ]);

    const result = await index.search('共同关键词', { projectId: 'p1' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.every((hit) => hit.convId === 'c1')).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('长正文命中时摘要被截断且仍含关键词', async () => {
    const long = `${'填充'.repeat(200)}关键片段${'尾部'.repeat(200)}`;
    const { index } = await setup([
      { id: 'c1', title: '长文', messages: [{ remoteId: 'm1', content: long }] },
    ]);

    const result = await index.search('关键片段');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const snippet = result.data[0]?.snippet ?? '';
    expect(snippet).toContain('关键片段');
    expect(snippet.length).toBeLessThanOrEqual(160);
  });
});

describe('search() 边界', () => {
  it('空库搜索返回空数组', async () => {
    const { index } = await setup([]);

    await expect(index.search('任何词')).resolves.toEqual({ ok: true, data: [] });
  });

  it('空查询与纯空白查询返回空数组，不报错', async () => {
    const { index } = await setup([
      { id: 'c1', title: '有内容', messages: [{ remoteId: 'm1', content: '内容' }] },
    ]);

    await expect(index.search('')).resolves.toEqual({ ok: true, data: [] });
    await expect(index.search('   ')).resolves.toEqual({ ok: true, data: [] });
  });

  it('未显式 rebuild 时也能自动建立索引后搜索', async () => {
    const { index } = await setup([
      { id: 'c1', title: '惰性初始化', messages: [{ remoteId: 'm1', content: '自动建索引' }] },
    ]);

    const result = await index.search('惰性初始化');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
  });
});

describe('upsertConversation()', () => {
  it('只更新目标会话的索引，其他会话不受影响', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '会话一', messages: [{ remoteId: 'm1', content: '旧关键词甲' }] },
      { id: 'c2', title: '会话二', messages: [{ remoteId: 'm2', content: '关键词乙' }] },
    ]);
    await index.rebuild();

    await db.message.update('c1:m1', { content: '新关键词丙' });
    const result = await index.upsertConversation('c1');

    expect(result.ok).toBe(true);
    const oldHit = await index.search('旧关键词甲');
    const newHit = await index.search('新关键词丙');
    const otherHit = await index.search('关键词乙');
    expect(oldHit.ok && oldHit.data).toHaveLength(0);
    expect(newHit.ok && newHit.data.length).toBeGreaterThan(0);
    expect(otherHit.ok && otherHit.data.length).toBeGreaterThan(0);
  });

  it('会话不存在时返回 NOT_FOUND', async () => {
    const { index } = await setup([]);

    const result = await index.upsertConversation('missing');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('removeConversation()', () => {
  it('删除后不再命中，重复删除幂等', async () => {
    const { index } = await setup([
      { id: 'c1', title: '将被删除', messages: [{ remoteId: 'm1', content: '唯一关键词' }] },
    ]);
    await index.rebuild();

    await index.removeConversation('c1');
    const afterRemove = await index.search('唯一关键词');

    expect(afterRemove.ok && afterRemove.data).toHaveLength(0);
    await expect(index.removeConversation('c1')).resolves.toEqual({ ok: true, data: undefined });
  });
});

describe('降级与健壮性', () => {
  function brokenEngine(): never {
    throw new Error('miniSearch 构造失败');
  }

  it('首次 search 就遇到引擎初始化失败时，直接退标题搜索', async () => {
    const { index } = await setup(
      [{ id: 'c1', title: '标题兜底可用', messages: [{ remoteId: 'm1', content: '正文' }] }],
      { engineFactory: brokenEngine },
    );

    const result = await index.search('标题兜底可用');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data[0]?.convId).toBe('c1');
  });

  it('引擎初始化失败时 upsertConversation 返回错误而不是静默继续', async () => {
    const { index } = await setup(
      [{ id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] }],
      { engineFactory: brokenEngine },
    );

    const result = await index.upsertConversation('c1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INDEX_INIT_FAILED');
  });

  it('flag 关闭时 rebuild 仍写索引行但不建引擎', async () => {
    const { db, index } = await setup(
      [{ id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] }],
      { flags: { fullTextSearchEnabled: false } },
    );

    const rebuilt = await index.rebuild();

    expect(rebuilt.ok).toBe(true);
    await expect(db.searchIndex.count()).resolves.toBe(1);
  });

  it('flag 关闭时 upsert 与 remove 都不建引擎且不报错', async () => {
    const { index } = await setup(
      [{ id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] }],
      { flags: { fullTextSearchEnabled: false } },
    );
    await index.rebuild();

    await expect(index.upsertConversation('c1')).resolves.toEqual({ ok: true, data: undefined });
    await expect(index.removeConversation('c1')).resolves.toEqual({ ok: true, data: undefined });
  });

  it('降级时标题搜索也支持 projectId 过滤', async () => {
    const { index } = await setup(
      [
        { id: 'c1', title: '项目一的标题', projectId: 'p1', messages: [] },
        { id: 'c2', title: '项目一的另一个标题', projectId: 'p2', messages: [] },
      ],
      { flags: { fullTextSearchEnabled: false } },
    );

    const result = await index.search('项目一', { projectId: 'p1' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.convId).toBe('c1');
  });

  it('陈旧的 searchIndex 行（会话已不存在）不会让搜索崩溃', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '正常会话', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    await index.rebuild();
    await db.searchIndex.add({
      id: 'ghost:__conversation__',
      convId: 'ghost',
      messageId: '',
      title: '幽灵索引行',
      body: '',
      tokens: ['幽灵'],
    });

    const fresh = createSearchIndex({ db, flags: resolveFlags({}) });
    const result = await fresh.search('幽灵索引行');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data[0]?.convId).toBe('ghost');
  });

  it('引擎里有文档但索引行已被删除时，跳过该命中而不是抛错', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '会被删行', messages: [{ remoteId: 'm1', content: '唯一关键词' }] },
    ]);
    await index.rebuild();
    await db.searchIndex.delete('c1:m1');

    const result = await index.search('唯一关键词');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data).toHaveLength(0);
  });

  it('读取索引表失败时退标题搜索', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '读索引失败仍可搜标题', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    vi.spyOn(db.searchIndex, 'toArray').mockRejectedValueOnce(new Error('index io'));

    const result = await index.search('读索引失败仍可搜标题');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data[0]?.convId).toBe('c1');
  });

  it('rebuild 写索引表失败时返回 DB_WRITE_FAILED', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    vi.spyOn(db.searchIndex, 'bulkPut').mockRejectedValueOnce(new Error('写放大'));

    const result = await index.rebuild();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });

  it('upsert 写索引表失败时返回 DB_WRITE_FAILED', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    await index.rebuild();
    vi.spyOn(db.searchIndex, 'bulkPut').mockRejectedValueOnce(new Error('写放大'));

    const result = await index.upsertConversation('c1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });

  it('search 读取命中行失败时返回 DB_READ_FAILED', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '关键词' }] },
    ]);
    await index.rebuild();
    vi.spyOn(db.searchIndex, 'bulkGet').mockRejectedValueOnce(new Error('读失败'));

    const result = await index.search('关键词');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_READ_FAILED');
  });

  it('降级路径的标题搜索读库失败时返回 DB_READ_FAILED', async () => {
    const { db, index } = await setup(
      [{ id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] }],
      { flags: { fullTextSearchEnabled: false } },
    );
    vi.spyOn(db.conversation, 'toArray').mockRejectedValueOnce(new Error('读失败'));

    const result = await index.search('标题');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_READ_FAILED');
  });

  it('惰性初始化时 rebuild 失败，search 退回标题搜索而不是报错', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '回退仍可用', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    vi.spyOn(db.searchIndex, 'bulkPut').mockRejectedValueOnce(new Error('写放大'));

    const result = await index.search('回退仍可用');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data[0]?.convId).toBe('c1');
  });

  it('引擎初始化失败时 removeConversation 不崩溃', async () => {
    const { index } = await setup([], { engineFactory: brokenEngine });

    await expect(index.removeConversation('c1')).resolves.toEqual({ ok: true, data: undefined });
  });

  it('removeConversation 写失败时返回 DB_WRITE_FAILED', async () => {
    const { db, index } = await setup([
      { id: 'c1', title: '标题', messages: [{ remoteId: 'm1', content: '正文' }] },
    ]);
    await index.rebuild();
    vi.spyOn(db.searchIndex, 'where').mockImplementationOnce(() => {
      throw new Error('查询构造失败');
    });

    const result = await index.removeConversation('c1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_WRITE_FAILED');
  });
});

describe('降级', () => {
  it('fullTextSearchEnabled=false 时退回标题搜索：标题命中、正文不命中', async () => {
    const { index } = await setup(
      [
        {
          id: 'c1',
          title: '标题里有分词',
          messages: [{ remoteId: 'm1', content: '正文另有说法' }],
        },
      ],
      { flags: { fullTextSearchEnabled: false } },
    );

    const titleHit = await index.search('标题里有分词');
    const bodyHit = await index.search('正文另有说法');

    expect(titleHit.ok && titleHit.data.length).toBeGreaterThan(0);
    expect(bodyHit.ok && bodyHit.data).toHaveLength(0);
  });

  it('索引初始化失败时返回 INDEX_INIT_FAILED，且搜索仍可退标题搜索', async () => {
    const { index } = await setup(
      [{ id: 'c1', title: '标题仍然可搜', messages: [{ remoteId: 'm1', content: '正文' }] }],
      {
        engineFactory: () => {
          throw new Error('miniSearch 构造失败');
        },
      },
    );

    const rebuilt = await index.rebuild();
    const searched = await index.search('标题仍然可搜');

    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) throw new Error('unreachable');
    expect(rebuilt.error.code).toBe('INDEX_INIT_FAILED');
    expect(searched.ok).toBe(true);
    if (!searched.ok) throw new Error('unreachable');
    expect(searched.data[0]?.convId).toBe('c1');
  });
});
