/**
 * 核心层对外契约：显式 Result。
 *
 * 约定（AGENTS.md §1、docs/tasks/0001-scaffold-p0.md 接口契约）：
 * - 核心层不把底层异常抛给 UI，一律转换成 `CoreResult`。
 * - `code` 为稳定错误码，UI 用它决定降级文案；`message` 面向开发者，不作为唯一用户文案。
 * - `retryable` 表示同一操作可原样重试（例如 IndexedDB 打开失败）。
 */

export type CoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'DB_OPEN_FAILED'
  | 'DB_READ_FAILED'
  | 'DB_WRITE_FAILED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_PARSE_FAILED'
  | 'SELECTOR_MISSING'
  | 'INDEX_INIT_FAILED'
  | 'SYNC_DISABLED'
  | 'SYNC_CANCELLED'
  | 'SYNC_IN_PROGRESS'
  | 'INDEX_IN_PROGRESS'
  | 'FLAG_STORAGE_FAILED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export interface CoreError {
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface CoreOk<T> {
  readonly ok: true;
  readonly data: T;
}

export interface CoreErr {
  readonly ok: false;
  readonly error: CoreError;
}

export type CoreResult<T> = CoreOk<T> | CoreErr;

export function ok<T>(data: T): CoreResult<T> {
  return { ok: true, data };
}

export function err<T = never>(
  code: CoreErrorCode,
  message: string,
  retryable = false,
): CoreResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

export function isOk<T>(result: CoreResult<T>): result is CoreOk<T> {
  return result.ok;
}

export function isErr<T>(result: CoreResult<T>): result is CoreErr {
  return !result.ok;
}

/**
 * 执行可能抛错的逻辑并归一为 `CoreResult`。
 * `onError` 负责决定错误码与是否可重试。
 */
export async function attempt<T>(
  run: () => T | Promise<T>,
  onError: (cause: unknown) => CoreError,
): Promise<CoreResult<T>> {
  try {
    return ok(await run());
  } catch (cause) {
    return { ok: false, error: onError(cause) };
  }
}

export function toCoreError(cause: unknown, code: CoreErrorCode, retryable = false): CoreError {
  return { code, retryable, message: describeCause(cause) };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message;
  if (typeof cause === 'string' && cause.trim() !== '') return cause;
  if (typeof cause === 'object' && cause !== null) {
    const message = readMessageProperty(cause);
    if (message !== undefined) return message;
  }
  return '未知错误';
}

function readMessageProperty(value: object): string | undefined {
  const candidate = (value as { message?: unknown }).message;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined;
}
