import type { DeckDatabase } from '@/core/db';
import type { SearchIndexSnapshotRecord } from '@/core/db/schema';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

/**
 * 索引快照的校验与存取（阶段 5.5）。
 * 快照是缓存不是事实源：任何异常都退回「重建」，绝不把坏快照当有效数据。
 */

export const SNAPSHOT_ID = 'singleton';

/**
 * 分词器版本。**修改 tokenizer 逻辑（分词规则、归一化、兜底切分）时必须 +1**，
 * 否则旧快照会带着旧分词结果被复用。
 */
export const TOKENIZER_VERSION = 1;

/** 构建期由 vite.define 注入（wxt.config.ts / vitest 配置），不在运行时 import package.json。 */
export const MINISEARCH_VERSION = __MINISEARCH_VERSION__;

/** `maxUpdatedAt` 比 `builtAt` 早超过这个量才判定为时间倒退（避免误伤时钟漂移）。 */
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type SnapshotInvalidReason =
  | 'missing'
  | 'schema-version'
  | 'minisearch-version'
  | 'tokenizer-version'
  | 'empty-json'
  | 'clock-skew';

export type SnapshotValidation =
  { usable: true } | { usable: false; reason: SnapshotInvalidReason };

export interface SnapshotContext {
  dbVersion: number;
  minisearchVersion: string;
  tokenizerVersion: number;
  /** 数据库里所有会话的最大 updatedAt；无会话时为 null。 */
  maxUpdatedAt: number | null;
  now: number;
}

export function validateSnapshot(
  record: SearchIndexSnapshotRecord | undefined,
  context: SnapshotContext,
): SnapshotValidation {
  if (record === undefined) return { usable: false, reason: 'missing' };
  if (record.schemaVersion !== context.dbVersion) {
    return { usable: false, reason: 'schema-version' };
  }
  if (record.minisearchVersion !== context.minisearchVersion) {
    return { usable: false, reason: 'minisearch-version' };
  }
  if (record.tokenizerVersion !== context.tokenizerVersion) {
    return { usable: false, reason: 'tokenizer-version' };
  }
  if (record.json === '') return { usable: false, reason: 'empty-json' };

  // 时间明显倒退：maxUpdatedAt 比 builtAt 早超过 24h（系统时间被改 / 数据回滚）。
  if (
    context.maxUpdatedAt !== null &&
    record.builtAt - context.maxUpdatedAt > CLOCK_SKEW_TOLERANCE_MS
  ) {
    return { usable: false, reason: 'clock-skew' };
  }

  return { usable: true };
}

export interface SnapshotStore {
  read(): Promise<CoreResult<SearchIndexSnapshotRecord | undefined>>;
  write(record: SearchIndexSnapshotRecord): Promise<CoreResult<void>>;
  remove(): Promise<CoreResult<void>>;
}

export function createSnapshotStore(db: DeckDatabase): SnapshotStore {
  return {
    async read(): Promise<CoreResult<SearchIndexSnapshotRecord | undefined>> {
      try {
        return ok(await db.searchIndexSnapshot.get(SNAPSHOT_ID));
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
      }
    },

    async write(record: SearchIndexSnapshotRecord): Promise<CoreResult<void>> {
      try {
        await db.searchIndexSnapshot.put(record);
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
      }
    },

    async remove(): Promise<CoreResult<void>> {
      try {
        await db.searchIndexSnapshot.delete(SNAPSHOT_ID);
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
      }
    },
  };
}
