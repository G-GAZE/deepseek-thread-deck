import { describe, expect, it } from 'vitest';

import { SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, createStorageLock } from '@/core/sync/lock';

import { createMemoryStorage } from '../../helpers/memory-storage';

const NOW = 1_700_000_000_000;

function createLock(storage = createMemoryStorage(), now = NOW) {
  return { storage, lock: createStorageLock(storage, { now: () => now }) };
}

describe('createStorageLock().acquire()', () => {
  it('无人持锁时抢锁成功并写入锁记录', async () => {
    const { storage, lock } = createLock();

    const result = await lock.acquire('tab-a');

    expect(result).toEqual({ ok: true, data: true });
    expect(storage.entries.get(SYNC_LOCK_KEY)).toEqual({
      owner: 'tab-a',
      acquiredAt: NOW,
      expiresAt: NOW + SYNC_LOCK_TTL_MS,
    });
  });

  it('他人持锁且未过期时抢锁失败', async () => {
    const storage = createMemoryStorage({
      [SYNC_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW, expiresAt: NOW + 30_000 },
    });
    const { lock } = createLock(storage);

    await expect(lock.acquire('tab-b')).resolves.toEqual({ ok: true, data: false });
  });

  it('锁已过期时可接管，避免页面崩溃后永久锁死', async () => {
    const storage = createMemoryStorage({
      [SYNC_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW - 120_000, expiresAt: NOW - 1 },
    });
    const { lock } = createLock(storage);

    await expect(lock.acquire('tab-b')).resolves.toEqual({ ok: true, data: true });
    expect(storage.entries.get(SYNC_LOCK_KEY)).toMatchObject({ owner: 'tab-b' });
  });

  it('同一 owner 可重入（幂等重试）', async () => {
    const storage = createMemoryStorage({
      [SYNC_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW, expiresAt: NOW + 30_000 },
    });
    const { lock } = createLock(storage);

    await expect(lock.acquire('tab-a')).resolves.toEqual({ ok: true, data: true });
  });

  it('锁记录损坏时视为无锁并可正常获取', async () => {
    const storage = createMemoryStorage({ [SYNC_LOCK_KEY]: 'garbage' });
    const { lock } = createLock(storage);

    await expect(lock.acquire('tab-a')).resolves.toEqual({ ok: true, data: true });
  });

  it('读失败返回可重试错误，不会误判为抢锁成功', async () => {
    const storage = createMemoryStorage();
    storage.failNextRead(new Error('storage io'));
    const { lock } = createLock(storage);

    const result = await lock.acquire('tab-a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('UNKNOWN');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('storage io');
  });

  it('写失败返回错误', async () => {
    const storage = createMemoryStorage();
    storage.failNextWrite(new Error('quota'));
    const { lock } = createLock(storage);

    const result = await lock.acquire('tab-a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('quota');
  });
});

describe('createStorageLock().release()', () => {
  it('持锁者释放后删除锁记录', async () => {
    const { storage, lock } = createLock();
    await lock.acquire('tab-a');

    await expect(lock.release('tab-a')).resolves.toEqual({ ok: true, data: undefined });
    expect(storage.entries.has(SYNC_LOCK_KEY)).toBe(false);
  });

  it('非持锁者释放不会误删他人的锁', async () => {
    const storage = createMemoryStorage({
      [SYNC_LOCK_KEY]: { owner: 'tab-a', acquiredAt: NOW, expiresAt: NOW + 30_000 },
    });
    const { lock } = createLock(storage);

    await lock.release('tab-b');

    expect(storage.entries.get(SYNC_LOCK_KEY)).toMatchObject({ owner: 'tab-a' });
  });

  it('没有锁时释放是安全的空操作', async () => {
    const { lock } = createLock();

    await expect(lock.release('tab-a')).resolves.toEqual({ ok: true, data: undefined });
  });

  it('删除失败返回错误', async () => {
    const { storage, lock } = createLock();
    await lock.acquire('tab-a');
    storage.failNextRemove(new Error('remove blocked'));

    const result = await lock.release('tab-a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('remove blocked');
  });
});

describe('锁的 key 与 TTL', () => {
  it('key 为 deck.sync.lock，TTL 为 60s', () => {
    expect(SYNC_LOCK_KEY).toBe('deck.sync.lock');
    expect(SYNC_LOCK_TTL_MS).toBe(60_000);
  });
});
