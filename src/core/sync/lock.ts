import type { LocalStoragePort } from '@/shared/local-storage';
import {
  createStorageLock as createGenericLock,
  type StorageLockPort,
} from '@/shared/storage-lock';

/**
 * sync 的互斥锁（`deck.sync.lock`）。
 * 通用逻辑在 `shared/storage-lock.ts`，search 的 rebuild 锁复用同一份实现。
 */

export type SyncLockPort = StorageLockPort;

export const SYNC_LOCK_KEY = 'deck.sync.lock';

export const SYNC_LOCK_TTL_MS = 60_000;

export interface StorageLockOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createStorageLock(
  storage: LocalStoragePort,
  options: StorageLockOptions = {},
): SyncLockPort {
  return createGenericLock(storage, {
    key: SYNC_LOCK_KEY,
    ttlMs: options.ttlMs ?? SYNC_LOCK_TTL_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
