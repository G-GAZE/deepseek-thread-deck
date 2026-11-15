import { describe, expect, it } from 'vitest';

import { SYNC_CURSOR_KEY, createCursorStorage } from '@/core/sync/cursor';

import { createMemoryStorage } from '../../helpers/memory-storage';

describe('createCursorStorage().read()', () => {
  it('空存储返回 null（视为全量）', async () => {
    const storage = createCursorStorage(createMemoryStorage());

    await expect(storage.read()).resolves.toEqual({ ok: true, data: null });
  });

  it('读取已保存的游标', async () => {
    const memory = createMemoryStorage({
      [SYNC_CURSOR_KEY]: { schemaVersion: 1, lastSyncedAt: 123, lastRunAt: 456 },
    });
    const storage = createCursorStorage(memory);

    await expect(storage.read()).resolves.toEqual({
      ok: true,
      data: { schemaVersion: 1, lastSyncedAt: 123, lastRunAt: 456 },
    });
  });

  it('版本不符时返回 null，退回全量', async () => {
    const memory = createMemoryStorage({
      [SYNC_CURSOR_KEY]: { schemaVersion: 99, lastSyncedAt: 123, lastRunAt: 456 },
    });
    const storage = createCursorStorage(memory);

    await expect(storage.read()).resolves.toEqual({ ok: true, data: null });
  });

  it('字段脏数据按 null 处理，不抛异常', async () => {
    const memory = createMemoryStorage({
      [SYNC_CURSOR_KEY]: { schemaVersion: 1, lastSyncedAt: 'yesterday', lastRunAt: {} },
    });
    const storage = createCursorStorage(memory);

    await expect(storage.read()).resolves.toEqual({
      ok: true,
      data: { schemaVersion: 1, lastSyncedAt: null, lastRunAt: null },
    });
  });

  it('非对象内容返回 null', async () => {
    const storage = createCursorStorage(createMemoryStorage({ [SYNC_CURSOR_KEY]: 'broken' }));

    await expect(storage.read()).resolves.toEqual({ ok: true, data: null });
  });

  it('读失败返回错误码', async () => {
    const memory = createMemoryStorage();
    memory.failNextRead(new Error('io error'));
    const storage = createCursorStorage(memory);

    const result = await storage.read();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('io error');
  });
});

describe('createCursorStorage().write()', () => {
  it('写入后可读回同一游标', async () => {
    const memory = createMemoryStorage();
    const storage = createCursorStorage(memory);
    const cursor = { schemaVersion: 1 as const, lastSyncedAt: 999, lastRunAt: 1000 };

    await expect(storage.write(cursor)).resolves.toEqual({ ok: true, data: undefined });
    await expect(storage.read()).resolves.toEqual({ ok: true, data: cursor });
  });

  it('写失败返回错误码', async () => {
    const memory = createMemoryStorage();
    memory.failNextWrite(new Error('quota exceeded'));
    const storage = createCursorStorage(memory);

    const result = await storage.write({ schemaVersion: 1, lastSyncedAt: null, lastRunAt: null });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('quota exceeded');
  });

  it('存储 key 带版本号', () => {
    expect(SYNC_CURSOR_KEY).toBe('deck.sync.cursor.v1');
  });
});
