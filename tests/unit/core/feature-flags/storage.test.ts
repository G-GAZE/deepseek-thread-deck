import { afterEach, describe, expect, it, vi } from 'vitest';

import { FLAGS_STORAGE_KEY, createBrowserLocalStorage } from '@/core/feature-flags/storage';

interface FakeArea {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function stubBrowser(): FakeArea {
  const area: FakeArea = {
    get: vi.fn(async () => ({ [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: false } })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  vi.stubGlobal('browser', { storage: { local: area } });
  return area;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBrowserLocalStorage()', () => {
  it('read 从 browser.storage.local 取对应 key 的值', async () => {
    const area = stubBrowser();
    const storage = createBrowserLocalStorage();

    await expect(storage.read(FLAGS_STORAGE_KEY)).resolves.toEqual({
      readonlySyncEnabled: false,
    });
    expect(area.get).toHaveBeenCalledWith(FLAGS_STORAGE_KEY);
  });

  it('write 用 { key: value } 形式写入', async () => {
    const area = stubBrowser();
    const storage = createBrowserLocalStorage();

    await storage.write(FLAGS_STORAGE_KEY, { readonlySyncEnabled: true });

    expect(area.set).toHaveBeenCalledWith({ [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: true } });
  });

  it('remove 删除对应 key', async () => {
    const area = stubBrowser();
    const storage = createBrowserLocalStorage();

    await storage.remove(FLAGS_STORAGE_KEY);

    expect(area.remove).toHaveBeenCalledWith(FLAGS_STORAGE_KEY);
  });

  it('key 带版本号，便于将来迁移', () => {
    expect(FLAGS_STORAGE_KEY).toBe('deck.flags.v1');
  });
});
