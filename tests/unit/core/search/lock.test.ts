import { describe, expect, it } from 'vitest';

import { SEARCH_LOCK_KEY, SEARCH_LOCK_TTL_MS, createSearchLock } from '@/core/search/lock';

import { createMemoryStorage } from '../../helpers/memory-storage';

const NOW = 1_800_000_000_000;

describe('检索重建互斥锁', () => {
  it('key 为 deck.search.lock，与 sync 锁互相独立', () => {
    expect(SEARCH_LOCK_KEY).toBe('deck.search.lock');
    expect(SEARCH_LOCK_TTL_MS).toBe(120_000);
  });

  it('无人持锁时可获取，写入持锁记录', async () => {
    const storage = createMemoryStorage();
    const lock = createSearchLock(storage, { now: () => NOW });

    await expect(lock.acquire('tab-a')).resolves.toEqual({ ok: true, data: true });
    expect(storage.entries.get(SEARCH_LOCK_KEY)).toEqual({
      owner: 'tab-a',
      acquiredAt: NOW,
      expiresAt: NOW + SEARCH_LOCK_TTL_MS,
    });
  });

  it('他人持锁时抢锁失败，不会覆盖对方记录', async () => {
    const storage = createMemoryStorage({
      [SEARCH_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW, expiresAt: NOW + 60_000 },
    });
    const lock = createSearchLock(storage, { now: () => NOW });

    await expect(lock.acquire('tab-b')).resolves.toEqual({ ok: true, data: false });
    expect(storage.entries.get(SEARCH_LOCK_KEY)).toMatchObject({ owner: 'tab-a' });
  });

  it('锁过期后可接管', async () => {
    const storage = createMemoryStorage({
      [SEARCH_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW - 200_000, expiresAt: NOW - 1 },
    });
    const lock = createSearchLock(storage, { now: () => NOW });

    await expect(lock.acquire('tab-b')).resolves.toEqual({ ok: true, data: true });
  });

  it('释放只删自己的锁', async () => {
    const storage = createMemoryStorage();
    const lock = createSearchLock(storage, { now: () => NOW });
    await lock.acquire('tab-a');

    await lock.release('tab-b');
    expect(storage.entries.has(SEARCH_LOCK_KEY)).toBe(true);

    await lock.release('tab-a');
    expect(storage.entries.has(SEARCH_LOCK_KEY)).toBe(false);
  });
});
