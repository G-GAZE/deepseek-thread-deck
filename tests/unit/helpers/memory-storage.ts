import type { LocalStoragePort } from '@/shared/local-storage';

/** 内存版键值存储，供单测替代 browser.storage.local。 */
export interface MemoryStorage extends LocalStoragePort {
  readonly entries: Map<string, unknown>;
  readonly writes: Array<{ key: string; value: unknown }>;
  failNextRead(reason?: Error): void;
  failNextWrite(reason?: Error): void;
  failNextRemove(reason?: Error): void;
}

export function createMemoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const entries = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<{ key: string; value: unknown }> = [];
  let readError: Error | undefined;
  let writeError: Error | undefined;
  let removeError: Error | undefined;

  return {
    entries,
    writes,
    failNextRead(reason = new Error('storage read failed')) {
      readError = reason;
    },
    failNextWrite(reason = new Error('storage write failed')) {
      writeError = reason;
    },
    failNextRemove(reason = new Error('storage remove failed')) {
      removeError = reason;
    },
    async read(key: string): Promise<unknown> {
      if (readError !== undefined) {
        const error = readError;
        readError = undefined;
        throw error;
      }
      return entries.get(key);
    },
    async write(key: string, value: unknown): Promise<void> {
      if (writeError !== undefined) {
        const error = writeError;
        writeError = undefined;
        throw error;
      }
      entries.set(key, value);
      writes.push({ key, value });
    },
    async remove(key: string): Promise<void> {
      if (removeError !== undefined) {
        const error = removeError;
        removeError = undefined;
        throw error;
      }
      entries.delete(key);
    },
  };
}
