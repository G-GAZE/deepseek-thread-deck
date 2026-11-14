import { describe, expect, it } from 'vitest';

import { attempt, err, isErr, isOk, ok, toCoreError, type CoreResult } from '~/shared/result';

describe('CoreResult', () => {
  it('ok() 包装成功数据', () => {
    expect(ok(42)).toEqual({ ok: true, data: 42 });
  });

  it('err() 生成带错误码与可重试标记的失败结果', () => {
    const result = err('DB_OPEN_FAILED', '数据库打开失败', true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toEqual({
      code: 'DB_OPEN_FAILED',
      message: '数据库打开失败',
      retryable: true,
    });
  });

  it('err() 默认可重试为 false', () => {
    const result = err('INVALID_ARGUMENT', '参数非法');

    if (result.ok) throw new Error('unreachable');
    expect(result.error.retryable).toBe(false);
  });

  it('isOk / isErr 可收窄类型', () => {
    const success: CoreResult<number> = ok(1);
    const failure: CoreResult<number> = err('UNKNOWN', '失败');

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isErr(failure)).toBe(true);

    if (isOk(success)) expect(success.data).toBe(1);
    if (isErr(failure)) expect(failure.error.code).toBe('UNKNOWN');
  });
});

describe('attempt()', () => {
  it('成功时透传返回值', async () => {
    const result = await attempt(
      async () => 'value',
      () => toCoreError(null, 'UNKNOWN'),
    );

    expect(result).toEqual({ ok: true, data: 'value' });
  });

  it('捕获异步异常并交给 onError 映射', async () => {
    const result = await attempt(
      async () => {
        throw new Error('boom');
      },
      (cause) => toCoreError(cause, 'DB_READ_FAILED', true),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DB_READ_FAILED');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('boom');
  });

  it('捕获同步异常', async () => {
    const result = await attempt(
      () => {
        throw new Error('sync boom');
      },
      (cause) => toCoreError(cause, 'DB_WRITE_FAILED'),
    );

    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('sync boom');
  });
});

describe('toCoreError()', () => {
  it('Error 取 message', () => {
    expect(toCoreError(new Error('x'), 'UNKNOWN').message).toBe('x');
  });

  it('非 Error 值转字符串描述', () => {
    expect(toCoreError('plain string', 'UNKNOWN').message).toBe('plain string');
    expect(toCoreError(undefined, 'UNKNOWN').message).toBe('未知错误');
  });

  it('保留错误码与可重试标记', () => {
    const error = toCoreError(new Error('x'), 'SOURCE_UNAVAILABLE', true);

    expect(error.code).toBe('SOURCE_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('类 DOMException 的普通对象取 message', () => {
    expect(toCoreError({ name: 'AbortError', message: '已中断' }, 'UNKNOWN').message).toBe(
      '已中断',
    );
  });

  it('message 为空的 Error 退回默认文案', () => {
    expect(toCoreError(new Error('   '), 'UNKNOWN').message).toBe('未知错误');
  });

  it('无 message 字段的对象退回默认文案', () => {
    expect(toCoreError({ code: 1 }, 'UNKNOWN').message).toBe('未知错误');
    expect(toCoreError({ message: 42 }, 'UNKNOWN').message).toBe('未知错误');
  });

  it('null 与空字符串退回默认文案', () => {
    expect(toCoreError(null, 'UNKNOWN').message).toBe('未知错误');
    expect(toCoreError('   ', 'UNKNOWN').message).toBe('未知错误');
  });
});
