import { describe, expect, it } from 'vitest';

import { createMainWorldSource } from '@/core/driver/main-world-source';

describe('createMainWorldSource() 占位', () => {
  it('未实现时抛出明确错误，避免调用方误以为可用', () => {
    expect(() => createMainWorldSource()).toThrow(
      'not implemented: waiting for real page structure',
    );
  });
});
