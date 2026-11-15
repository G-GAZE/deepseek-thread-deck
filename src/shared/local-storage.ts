/**
 * 键值存储端口（纯接口，不依赖浏览器 API）。
 *
 * 真实实现见 `core/feature-flags/storage.ts`（browser.storage.local），
 * 测试用内存实现替代，因此本文件可以直接被 core / 单测引用。
 */
export interface LocalStoragePort {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
