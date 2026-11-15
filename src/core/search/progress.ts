import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

/**
 * 首建进度（阶段 5.5）。
 * 进度只是 UI 提示，读写失败都不阻塞构建，因此调用方忽略错误即可。
 */

export const INDEX_PROGRESS_KEY = 'deck.search.indexProgress.v1';

/** 超过这个时间没有刷新就视为中断（构建期间每批都会刷新，且至少每 30s 刷一次）。 */
export const INDEX_PROGRESS_STALE_MS = 120_000;

export type IndexProgressPhase = 'idle' | 'building' | 'done';

export interface IndexProgress {
  phase: IndexProgressPhase;
  processed: number;
  total: number;
  /** 每次写入都必须刷新；读取方据此判断是否中断。 */
  updatedAt: number;
}

export interface IndexProgressPort {
  read(): Promise<CoreResult<IndexProgress | null>>;
  write(progress: IndexProgress): Promise<CoreResult<void>>;
}

export function createProgressStorage(storage: LocalStoragePort): IndexProgressPort {
  return {
    async read(): Promise<CoreResult<IndexProgress | null>> {
      try {
        return ok(parseProgress(await storage.read(INDEX_PROGRESS_KEY)));
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },

    async write(progress: IndexProgress): Promise<CoreResult<void>> {
      try {
        await storage.write(INDEX_PROGRESS_KEY, progress);
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: toCoreError(cause, 'UNKNOWN', true) };
      }
    },
  };
}

export function isProgressStale(progress: IndexProgress, now: number): boolean {
  if (progress.phase !== 'building') return false;
  return now - progress.updatedAt > INDEX_PROGRESS_STALE_MS;
}

function parseProgress(raw: unknown): IndexProgress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const { phase, processed, total, updatedAt } = candidate;
  if (phase !== 'idle' && phase !== 'building' && phase !== 'done') return null;
  if (typeof processed !== 'number' || typeof total !== 'number') return null;
  if (typeof updatedAt !== 'number') return null;
  return { phase, processed, total, updatedAt };
}
