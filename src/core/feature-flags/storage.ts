import type { LocalStoragePort } from '@/shared/local-storage';

/** 开关存储 key，带版本号便于将来迁移。 */
export const FLAGS_STORAGE_KEY = 'deck.flags.v1';

/**
 * `browser.storage.local` 适配。这是唯一接触浏览器存储 API 的地方，
 * 其余代码只依赖 `LocalStoragePort`，因此可单测、可在 content script / popup 复用。
 */
export function createBrowserLocalStorage(): LocalStoragePort {
  return {
    async read(key: string): Promise<unknown> {
      const snapshot = await browser.storage.local.get(key);
      return snapshot[key];
    },
    async write(key: string, value: unknown): Promise<void> {
      await browser.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await browser.storage.local.remove(key);
    },
  };
}
