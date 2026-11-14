import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

/**
 * 多标签页同步互斥锁。
 *
 * 背景：sync 跑在 content script，多个 DeepSeek 标签页会同时触发同步。
 * P0 用 `browser.storage.local` 的单 key 记录持锁者（`deck.sync.lock`）+ TTL：
 * - 抢不到锁 → 调用方返回 `SYNC_IN_PROGRESS`；
 * - TTL 60s，页面崩溃/被杀后不会永久锁死；
 * - 已知局限：`storage.local` 的「读-改-写」跨标签页不是原子的，存在极窄竞态。
 *   因此锁只作为「避免重复劳动」的优化，正确性仍由 sync 的幂等 upsert 兜底。
 *   后续可用 Web Locks API（`navigator.locks`）替换实现，端口不变。
 */

export const SYNC_LOCK_KEY = 'deck.sync.lock';

export const SYNC_LOCK_TTL_MS = 60_000;

export interface SyncLockRecord {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface SyncLockPort {
  /** true 表示抢到锁；false 表示他人持锁中。 */
  acquire(owner: string): Promise<CoreResult<boolean>>;
  release(owner: string): Promise<CoreResult<void>>;
}

export interface StorageLockOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createStorageLock(
  storage: LocalStoragePort,
  options: StorageLockOptions = {},
): SyncLockPort {
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? SYNC_LOCK_TTL_MS;

  return {
    async acquire(owner: string): Promise<CoreResult<boolean>> {
      try {
        const current = parseLock(await storage.read(SYNC_LOCK_KEY));
        const timestamp = now();

        const heldByOther =
          current !== null && current.owner !== owner && current.expiresAt > timestamp;
        if (heldByOther) return ok(false);

        await storage.write(SYNC_LOCK_KEY, {
          owner,
          acquiredAt: timestamp,
          expiresAt: timestamp + ttlMs,
        });
        return ok(true);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },

    async release(owner: string): Promise<CoreResult<void>> {
      try {
        const current = parseLock(await storage.read(SYNC_LOCK_KEY));
        if (current !== null && current.owner === owner) {
          await storage.remove(SYNC_LOCK_KEY);
        }
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },
  };
}

function parseLock(raw: unknown): SyncLockRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const { owner, acquiredAt, expiresAt } = candidate;
  if (typeof owner !== 'string') return null;
  if (typeof acquiredAt !== 'number' || typeof expiresAt !== 'number') return null;
  return { owner, acquiredAt, expiresAt };
}
