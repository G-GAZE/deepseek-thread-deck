import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

/**
 * 基于 `storage.local` 单 key 的互斥锁（sync 与 search 共用同一份实现，只换 key）。
 *
 * 已知局限：`storage.local` 的「读-改-写」跨标签页不是原子的，存在极窄竞态。
 * 因此锁只作为「避免重复劳动」的优化，正确性由各自的幂等逻辑兜底
 * （sync：幂等 upsert；search：快照可重建）。
 */

export interface StorageLockRecord {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface StorageLockPort {
  /** true 表示抢到锁；false 表示他人持锁中。 */
  acquire(owner: string): Promise<CoreResult<boolean>>;
  release(owner: string): Promise<CoreResult<void>>;
}

export interface StorageLockOptions {
  key: string;
  ttlMs: number;
  now?: () => number;
}

export function createStorageLock(
  storage: LocalStoragePort,
  options: StorageLockOptions,
): StorageLockPort {
  const now = options.now ?? ((): number => Date.now());

  return {
    async acquire(owner: string): Promise<CoreResult<boolean>> {
      try {
        const current = parseLock(await storage.read(options.key));
        const timestamp = now();

        const heldByOther =
          current !== null && current.owner !== owner && current.expiresAt > timestamp;
        if (heldByOther) return ok(false);

        await storage.write(options.key, {
          owner,
          acquiredAt: timestamp,
          expiresAt: timestamp + options.ttlMs,
        });
        return ok(true);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },

    async release(owner: string): Promise<CoreResult<void>> {
      try {
        const current = parseLock(await storage.read(options.key));
        if (current !== null && current.owner === owner) {
          await storage.remove(options.key);
        }
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },
  };
}

function parseLock(raw: unknown): StorageLockRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const { owner, acquiredAt, expiresAt } = candidate;
  if (typeof owner !== 'string') return null;
  if (typeof acquiredAt !== 'number' || typeof expiresAt !== 'number') return null;
  return { owner, acquiredAt, expiresAt };
}
