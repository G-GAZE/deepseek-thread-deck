import { describe, expect, it } from 'vitest';

import { FLAGS_STORAGE_KEY } from '@/core/feature-flags/storage';
import { createFeatureFlagStore } from '@/core/feature-flags/store';
import { createMemoryStorage } from '../../helpers/memory-storage';

describe('FeatureFlagStore.get()', () => {
  it('空存储返回默认快照', async () => {
    const store = createFeatureFlagStore(createMemoryStorage());

    const result = await store.get();

    expect(result).toEqual({
      ok: true,
      data: { readonlySyncEnabled: true, fullTextSearchEnabled: true },
    });
  });

  it('读取已保存的覆盖值', async () => {
    const store = createFeatureFlagStore(
      createMemoryStorage({ [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: false } }),
    );

    const result = await store.get();

    expect(result.ok && result.data.readonlySyncEnabled).toBe(false);
    expect(result.ok && result.data.fullTextSearchEnabled).toBe(true);
  });

  it('脏数据（字符串布尔、未知键）被忽略并回落默认', async () => {
    const store = createFeatureFlagStore(
      createMemoryStorage({
        [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: 'false', retiredFlag: true },
      }),
    );

    const result = await store.get();

    expect(result).toEqual({
      ok: true,
      data: { readonlySyncEnabled: true, fullTextSearchEnabled: true },
    });
  });

  it('读失败返回错误码而不是抛异常', async () => {
    const memory = createMemoryStorage();
    memory.failNextRead(new Error('quota'));
    const store = createFeatureFlagStore(memory);

    const result = await store.get();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('FLAG_STORAGE_FAILED');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('quota');
  });
});

describe('FeatureFlagStore.set()', () => {
  it('关闭 readonlySyncEnabled 后能真实读回 false', async () => {
    const memory = createMemoryStorage();
    const store = createFeatureFlagStore(memory);

    const written = await store.set('readonlySyncEnabled', false);
    const readBack = await store.get();

    expect(written.ok && written.data.readonlySyncEnabled).toBe(false);
    expect(readBack.ok && readBack.data.readonlySyncEnabled).toBe(false);
    expect(memory.entries.get(FLAGS_STORAGE_KEY)).toEqual({ readonlySyncEnabled: false });
  });

  it('修改一个开关不影响其他开关', async () => {
    const memory = createMemoryStorage();
    const store = createFeatureFlagStore(memory);
    await store.set('fullTextSearchEnabled', false);

    const result = await store.set('readonlySyncEnabled', false);

    expect(result.ok && result.data).toEqual({
      readonlySyncEnabled: false,
      fullTextSearchEnabled: false,
    });
  });

  it('写失败返回错误且不留下半写状态', async () => {
    const memory = createMemoryStorage();
    const store = createFeatureFlagStore(memory);
    memory.failNextWrite(new Error('disk full'));

    const result = await store.set('readonlySyncEnabled', false);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('FLAG_STORAGE_FAILED');
    expect(result.error.message).toBe('disk full');
    expect(memory.entries.has(FLAGS_STORAGE_KEY)).toBe(false);
  });

  it('读失败时 set 直接报错，不盲目覆盖已有配置', async () => {
    const memory = createMemoryStorage({ [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: false } });
    const store = createFeatureFlagStore(memory);
    memory.failNextRead(new Error('read blocked'));

    const result = await store.set('fullTextSearchEnabled', false);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('read blocked');
    expect(memory.writes).toHaveLength(0);
    expect(memory.entries.get(FLAGS_STORAGE_KEY)).toEqual({ readonlySyncEnabled: false });
  });
});

describe('FeatureFlagStore.reset()', () => {
  it('清空覆盖值并回到默认快照', async () => {
    const memory = createMemoryStorage({
      [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: false },
    });
    const store = createFeatureFlagStore(memory);

    const result = await store.reset();

    expect(result).toEqual({
      ok: true,
      data: { readonlySyncEnabled: true, fullTextSearchEnabled: true },
    });
    expect(memory.entries.has(FLAGS_STORAGE_KEY)).toBe(false);
  });

  it('删除失败返回错误而不是假装重置成功', async () => {
    const memory = createMemoryStorage({
      [FLAGS_STORAGE_KEY]: { readonlySyncEnabled: false },
    });
    const store = createFeatureFlagStore(memory);
    memory.failNextRemove(new Error('remove blocked'));

    const result = await store.reset();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('FLAG_STORAGE_FAILED');
    expect(result.error.message).toBe('remove blocked');
    expect(memory.entries.has(FLAGS_STORAGE_KEY)).toBe(true);
  });
});
