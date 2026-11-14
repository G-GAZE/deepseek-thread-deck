import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDeckDatabase, type DeckDatabase } from '@/core/db';
import { DB_VERSION, toMessageKey, type SearchIndexSnapshotRecord } from '@/core/db/schema';
import { SEARCH_LOCK_KEY, createSearchLock } from '@/core/search/lock';
import { createProgressStorage, type IndexProgress } from '@/core/search/progress';
import { createSearchIndex, loadMiniSearchEngine } from '@/core/search/search-index';
import { MINISEARCH_VERSION, SNAPSHOT_ID, TOKENIZER_VERSION } from '@/core/search/snapshot';
import type { SearchIndex } from '@/core/search/types';
import { resolveFlags } from '@/shared/feature-flags';

import { createMemoryStorage, type MemoryStorage } from '../../helpers/memory-storage';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

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
  memory: MemoryStorage;
  index: SearchIndex;
  loaderCalls: string[];
  progressWrites: IndexProgress[];
}

interface HarnessOptions {
  now?: number;
  conversations?: number;
  lockHeldBy?: string;
  failProgressWrite?: boolean;
  brokenSnapshotJson?: boolean;
}

async function seed(db: DeckDatabase, count: number, updatedAt = NOW - HOUR): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const convId = `conv-${index}`;
    await db.conversation.add({
      id: convId,
      remoteId: convId,
      title: `会话 ${index} 分词方案`,
      projectId: null,
      tags: [],
      createdAt: updatedAt,
      updatedAt,
    });
    await db.message.add({
      id: toMessageKey(convId, 'm0'),
      convId,
      role: 'user',
      content: `第 ${index} 条正文：游标推进`,
      order: 0,
      attachmentMeta: [],
    });
  }
}

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  const opened = await openDeckDatabase(`search-persist-${randomUUID()}`);
  if (!opened.ok) throw new Error(`打开测试数据库失败: ${opened.error.code}`);
  const db = opened.data;
  cleanups.push(async () => {
    db.close();
    await db.delete();
  });

  await seed(db, options.conversations ?? 2);

  const memory = createMemoryStorage();
  if (options.lockHeldBy !== undefined) {
    memory.entries.set(SEARCH_LOCK_KEY, {
      owner: options.lockHeldBy,
      acquiredAt: NOW,
      expiresAt: NOW + 60_000,
    });
  }

  const loaderCalls: string[] = [];
  const progressWrites: IndexProgress[] = [];
  const progressStorage = createProgressStorage(memory);

  const index = createSearchIndex({
    db,
    flags: resolveFlags({}),
    lock: createSearchLock(memory, { now: () => options.now ?? NOW }),
    progress: {
      read: () => progressStorage.read(),
      write: async (progress) => {
        progressWrites.push(progress);
        if (options.failProgressWrite === true) {
          return { ok: false, error: { code: 'UNKNOWN', message: '写入失败', retryable: true } };
        }
        return progressStorage.write(progress);
      },
    },
    engineLoader: (json: string) => {
      loaderCalls.push(json);
      if (options.brokenSnapshotJson === true) throw new Error('快照损坏');
      return loadMiniSearchEngine(json);
    },
    now: () => options.now ?? NOW,
  });

  return { db, memory, index, loaderCalls, progressWrites };
}

async function readSnapshot(db: DeckDatabase): Promise<SearchIndexSnapshotRecord | undefined> {
  return db.searchIndexSnapshot.get(SNAPSHOT_ID);
}

describe('首次构建与快照写入', () => {
  it('无快照时重建索引，写入快照并上报 building→done 进度', async () => {
    const { db, index, progressWrites } = await setup({ conversations: 3 });

    const result = await index.search('游标');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
    const snapshot = await readSnapshot(db);
    expect(snapshot).toMatchObject({
      id: SNAPSHOT_ID,
      schemaVersion: DB_VERSION,
      minisearchVersion: MINISEARCH_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      docCount: 3,
    });
    expect(snapshot?.json.length ?? 0).toBeGreaterThan(0);
    expect(progressWrites[0]?.phase).toBe('building');
    expect(progressWrites.at(-1)).toMatchObject({ phase: 'done', processed: 3, total: 3 });
  });

  it('索引行不再写真实 tokens（tokens 全为空数组），*tokens 多值索引不报错', async () => {
    const { db, index } = await setup({ conversations: 2 });
    await index.search('游标');

    const rows = await db.searchIndex.toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Array.isArray(row.tokens) && row.tokens.length === 0)).toBe(true);
    await expect(db.searchIndex.where('tokens').equals('游标').count()).resolves.toBe(0);
  });
});

describe('启动快照命中与失效', () => {
  it('第二次启动走 loadJSON，不重建索引', async () => {
    const first = await setup({ conversations: 2 });
    await first.index.search('游标');
    const clearSpy = vi.spyOn(first.db.searchIndex, 'clear');

    const second = createSearchIndex({
      db: first.db,
      flags: resolveFlags({}),
      lock: createSearchLock(first.memory, { now: () => NOW }),
      engineLoader: loadMiniSearchEngine,
      now: () => NOW,
    });
    const result = await second.search('游标');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('minisearchVersion 不符时失效重建，不走 loadJSON', async () => {
    const { db } = await setup({ conversations: 2 });
    await db.searchIndexSnapshot.put({
      id: SNAPSHOT_ID,
      json: '{"documentCount":0}',
      builtAt: NOW,
      docCount: 0,
      schemaVersion: DB_VERSION,
      minisearchVersion: '0.0.1-other',
      tokenizerVersion: TOKENIZER_VERSION,
    });

    const harness = await setupWithDb(db);
    const result = await harness.index.search('游标');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
    expect(harness.loaderCalls).toHaveLength(0);
    await expect(readSnapshot(db)).resolves.toMatchObject({
      minisearchVersion: MINISEARCH_VERSION,
    });
  });

  it('快照 JSON 损坏时删除快照并重建', async () => {
    const broken = await setup({ conversations: 1, brokenSnapshotJson: true });
    await broken.db.searchIndexSnapshot.put({
      id: SNAPSHOT_ID,
      json: '{broken',
      builtAt: NOW,
      docCount: 1,
      schemaVersion: DB_VERSION,
      minisearchVersion: MINISEARCH_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
    });

    await broken.index.search('游标');

    expect(broken.loaderCalls).toHaveLength(1);
    const snapshot = await readSnapshot(broken.db);
    expect(snapshot?.json).not.toBe('{broken');
  });

  it('session count 与快照不一致时不重建索引（只记日志）', async () => {
    const { db } = await setup({ conversations: 1 });
    const first = await setupWithDb(db);
    await first.index.search('游标');
    const clearSpy = vi.spyOn(db.searchIndex, 'clear');

    // 快照声称只有 0 个文档，与真实 1 个不一致
    const snapshot = await readSnapshot(db);
    if (snapshot === undefined) throw new Error('快照应已写入');
    await db.searchIndexSnapshot.put({ ...snapshot, docCount: 0 });

    const second = await setupWithDb(db);
    const result = await second.index.search('游标');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
    expect(second.loaderCalls).toHaveLength(1);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('max(updatedAt) 比 builtAt 早超过 24h 时保守重建', async () => {
    const { db } = await setup({ conversations: 1 });
    const first = await setupWithDb(db);
    await first.index.search('游标');

    await db.conversation.toCollection().modify({ updatedAt: NOW - 25 * HOUR });

    const second = await setupWithDb(db);
    await second.index.search('游标');

    expect(second.loaderCalls).toHaveLength(0);
  });

  it('启动后只对 builtAt 之后更新的会话做增量', async () => {
    const { db } = await setup({ conversations: 2 });
    const first = await setupWithDb(db);
    await first.index.search('游标');

    // 会话 1 在快照之后更新
    await db.message.add({
      id: toMessageKey('conv-1', 'm1'),
      convId: 'conv-1',
      role: 'assistant',
      content: '新增内容：幂等性',
      order: 1,
      attachmentMeta: [],
    });
    await db.conversation.update('conv-1', { updatedAt: NOW + 1000 });

    const second = await setupWithDb(db, { now: NOW + 2000 });
    const result = await second.index.search('幂等性');

    expect(result.ok && result.data.length).toBeGreaterThan(0);
    expect(second.loaderCalls).toHaveLength(1);
    const snapshot = await readSnapshot(db);
    expect(snapshot?.builtAt).toBe(NOW + 2000);
  });
});

describe('rebuild 的互斥锁与降级', () => {
  it('其他标签页持锁时 rebuild 返回 INDEX_IN_PROGRESS', async () => {
    const { index } = await setup({ conversations: 1, lockHeldBy: 'other-tab' });

    const result = await index.rebuild();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INDEX_IN_PROGRESS');
    expect(result.error.retryable).toBe(true);
  });

  it('进度写入失败不阻塞重建', async () => {
    const { index } = await setup({ conversations: 2, failProgressWrite: true });

    const result = await index.rebuild();

    expect(result.ok).toBe(true);
  });

  it('快照写入失败不阻塞重建', async () => {
    const { db, index } = await setup({ conversations: 1 });
    vi.spyOn(db.searchIndexSnapshot, 'put').mockRejectedValueOnce(new Error('quota'));

    const result = await index.rebuild();

    expect(result.ok).toBe(true);
    await expect(readSnapshot(db)).resolves.toBeUndefined();
  });
});

/** 在已存在的 db 上再建一个索引实例（模拟「下一次启动」）。 */
async function setupWithDb(db: DeckDatabase, options: HarnessOptions = {}): Promise<Harness> {
  const memory = createMemoryStorage();
  const loaderCalls: string[] = [];
  const progressWrites: IndexProgress[] = [];
  const progressStorage = createProgressStorage(memory);

  const index = createSearchIndex({
    db,
    flags: resolveFlags({}),
    lock: createSearchLock(memory, { now: () => options.now ?? NOW }),
    progress: {
      read: () => progressStorage.read(),
      write: async (progress) => {
        progressWrites.push(progress);
        return progressStorage.write(progress);
      },
    },
    engineLoader: (json: string) => {
      loaderCalls.push(json);
      return loadMiniSearchEngine(json);
    },
    now: () => options.now ?? NOW,
  });

  return { db, memory, index, loaderCalls, progressWrites };
}
