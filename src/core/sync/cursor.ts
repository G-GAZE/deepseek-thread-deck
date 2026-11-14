import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

import { SYNC_CURSOR_SCHEMA_VERSION, type SyncCursor, type SyncCursorPort } from './types';

/** 游标存储 key，带版本号；版本不符即退回全量。 */
export const SYNC_CURSOR_KEY = 'deck.sync.cursor.v1';

export function createCursorStorage(storage: LocalStoragePort): SyncCursorPort {
  return {
    async read(): Promise<CoreResult<SyncCursor | null>> {
      try {
        const raw = await storage.read(SYNC_CURSOR_KEY);
        return ok(parseCursor(raw));
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },

    async write(cursor: SyncCursor): Promise<CoreResult<void>> {
      try {
        await storage.write(SYNC_CURSOR_KEY, cursor);
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },
  };
}

/** 任何不符合预期形状的内容都当作「没有游标」，绝不猜测。 */
function parseCursor(raw: unknown): SyncCursor | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== SYNC_CURSOR_SCHEMA_VERSION) return null;

  return {
    schemaVersion: SYNC_CURSOR_SCHEMA_VERSION,
    lastSyncedAt: asNumberOrNull(candidate.lastSyncedAt),
    lastRunAt: asNumberOrNull(candidate.lastRunAt),
  };
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
