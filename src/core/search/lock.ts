import type { LocalStoragePort } from '@/shared/local-storage';
import {
  createStorageLock as createGenericLock,
  type StorageLockPort,
} from '@/shared/storage-lock';

/**
 * 检索重建的互斥锁（`deck.search.lock`）。
 *
 * 与 `deck.sync.lock` 彼此独立：sync 与索引重建可以并行，互不阻塞。
 * 抢不到锁 → 调用方返回 `INDEX_IN_PROGRESS`。
 */

export const SEARCH_LOCK_KEY = 'deck.search.lock';

/** 真实环境 rebuild 可能超过 60s，因此取 120s；M1b 按真实耗时校准。 */
export const SEARCH_LOCK_TTL_MS = 120_000;

export interface SearchLockOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createSearchLock(
  storage: LocalStoragePort,
  options: SearchLockOptions = {},
): StorageLockPort {
  return createGenericLock(storage, {
    key: SEARCH_LOCK_KEY,
    ttlMs: options.ttlMs ?? SEARCH_LOCK_TTL_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
