import { describe, expect, it } from 'vitest';

import {
  INDEX_PROGRESS_KEY,
  INDEX_PROGRESS_STALE_MS,
  createProgressStorage,
  isProgressStale,
  type IndexProgress,
} from '@/core/search/progress';

import { createMemoryStorage } from '../../helpers/memory-storage';

const NOW = 1_800_000_000_000;

describe('createProgressStorage()', () => {
  it('空存储读回 null', async () => {
    const progress = createProgressStorage(createMemoryStorage());

    await expect(progress.read()).resolves.toEqual({ ok: true, data: null });
  });

  it('写入后读回同一进度', async () => {
    const storage = createMemoryStorage();
    const progress = createProgressStorage(storage);
    const value: IndexProgress = { phase: 'building', processed: 20, total: 500, updatedAt: NOW };

    await expect(progress.write(value)).resolves.toEqual({ ok: true, data: undefined });
    await expect(progress.read()).resolves.toEqual({ ok: true, data: value });
    expect(storage.entries.get(INDEX_PROGRESS_KEY)).toEqual(value);
  });

  it('脏数据读回 null，不抛异常', async () => {
    const progress = createProgressStorage(createMemoryStorage({ [INDEX_PROGRESS_KEY]: 'boom' }));

    await expect(progress.read()).resolves.toEqual({ ok: true, data: null });
  });

  it('读失败返回错误码', async () => {
    const storage = createMemoryStorage();
    storage.failNextRead(new Error('io'));
    const progress = createProgressStorage(storage);

    const result = await progress.read();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.retryable).toBe(true);
  });

  it('写失败返回错误码', async () => {
    const storage = createMemoryStorage();
    storage.failNextWrite(new Error('quota'));
    const progress = createProgressStorage(storage);

    const result = await progress.write({ phase: 'done', processed: 1, total: 1, updatedAt: NOW });

    expect(result.ok).toBe(false);
  });

  it('key 与过期阈值固定', () => {
    expect(INDEX_PROGRESS_KEY).toBe('deck.search.indexProgress.v1');
    expect(INDEX_PROGRESS_STALE_MS).toBe(120_000);
  });
});

describe('isProgressStale()', () => {
  it('building 且超过 2 分钟无刷新视为中断', () => {
    const value: IndexProgress = {
      phase: 'building',
      processed: 10,
      total: 100,
      updatedAt: NOW - 121_000,
    };

    expect(isProgressStale(value, NOW)).toBe(true);
  });

  it('2 分钟内不视为中断', () => {
    const value: IndexProgress = {
      phase: 'building',
      processed: 10,
      total: 100,
      updatedAt: NOW - 60_000,
    };

    expect(isProgressStale(value, NOW)).toBe(false);
  });

  it('done / idle 永不视为中断', () => {
    const base = { processed: 10, total: 10, updatedAt: NOW - 600_000 };

    expect(isProgressStale({ ...base, phase: 'done' }, NOW)).toBe(false);
    expect(isProgressStale({ ...base, phase: 'idle' }, NOW)).toBe(false);
  });
});
