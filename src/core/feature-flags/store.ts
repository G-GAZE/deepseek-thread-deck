import {
  resolveFlags,
  type FeatureFlagName,
  type FeatureFlagSnapshot,
} from '@/shared/feature-flags';
import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

import { FLAGS_STORAGE_KEY } from './storage';

/**
 * Feature flag 存储层（ADR-006）。
 * 读取时统一经 `resolveFlags` 解析，脏数据与未知键不会污染快照。
 */
export interface FeatureFlagStore {
  get(): Promise<CoreResult<FeatureFlagSnapshot>>;
  set(name: FeatureFlagName, value: boolean): Promise<CoreResult<FeatureFlagSnapshot>>;
  reset(): Promise<CoreResult<FeatureFlagSnapshot>>;
}

export function createFeatureFlagStore(storage: LocalStoragePort): FeatureFlagStore {
  return {
    async get(): Promise<CoreResult<FeatureFlagSnapshot>> {
      const overrides = await readOverrides(storage);
      if (!overrides.ok) return overrides;
      return ok(resolveFlags(overrides.data));
    },

    async set(name, value): Promise<CoreResult<FeatureFlagSnapshot>> {
      const overrides = await readOverrides(storage);
      if (!overrides.ok) return overrides;

      const next: Record<string, unknown> = { ...overrides.data, [name]: value };
      try {
        await storage.write(FLAGS_STORAGE_KEY, next);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
      return ok(resolveFlags(next));
    },

    async reset(): Promise<CoreResult<FeatureFlagSnapshot>> {
      try {
        await storage.remove(FLAGS_STORAGE_KEY);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
      return ok(resolveFlags({}));
    },
  };
}

async function readOverrides(
  storage: LocalStoragePort,
): Promise<CoreResult<Record<string, unknown>>> {
  try {
    const raw = await storage.read(FLAGS_STORAGE_KEY);
    return ok(asPlainRecord(raw));
  } catch (cause) {
    return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
  }
}

/** 存储里可能残留任何形状的脏数据，这里只保证拿到一个普通对象。 */
function asPlainRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  return { ...(raw as Record<string, unknown>) };
}
