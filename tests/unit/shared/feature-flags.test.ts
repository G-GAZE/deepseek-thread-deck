import { describe, expect, it } from 'vitest';

import {
  FEATURE_FLAGS,
  defaultFlagSnapshot,
  isEnabled,
  resolveFlags,
  type FeatureFlagName,
} from '@/shared/feature-flags';

describe('feature flag 注册表', () => {
  it('包含 P0 需要的开关', () => {
    expect(Object.keys(FEATURE_FLAGS).sort()).toEqual([
      'fullTextSearchEnabled',
      'readonlySyncEnabled',
    ]);
  });

  it('只读同步默认开启，保证 P0 开箱可用', () => {
    expect(FEATURE_FLAGS.readonlySyncEnabled.defaultValue).toBe(true);
  });

  it('每个开关都有说明与 ADR 依据，便于审计', () => {
    for (const flag of Object.values(FEATURE_FLAGS)) {
      expect(flag.description.length).toBeGreaterThan(0);
      expect(flag.adr).toMatch(/^ADR-00\d$/);
    }
  });
});

describe('defaultFlagSnapshot()', () => {
  it('快照覆盖全部开关且取默认值', () => {
    const snapshot = defaultFlagSnapshot();

    for (const name of Object.keys(FEATURE_FLAGS) as FeatureFlagName[]) {
      expect(snapshot[name]).toBe(FEATURE_FLAGS[name].defaultValue);
    }
  });
});

describe('resolveFlags()', () => {
  it('覆盖值优先于默认值', () => {
    const snapshot = resolveFlags({ readonlySyncEnabled: false });

    expect(snapshot.readonlySyncEnabled).toBe(false);
    expect(snapshot.fullTextSearchEnabled).toBe(true);
  });

  it('忽略未知键，兼容旧版本残留的存储内容', () => {
    const snapshot = resolveFlags({ removedFlag: true, readonlySyncEnabled: false });

    expect(snapshot).toEqual({ readonlySyncEnabled: false, fullTextSearchEnabled: true });
  });

  it('忽略非布尔值，避免脏数据把开关打开', () => {
    const snapshot = resolveFlags({ readonlySyncEnabled: 'true', fullTextSearchEnabled: 0 });

    expect(snapshot).toEqual(defaultFlagSnapshot());
  });

  it('空输入返回默认快照', () => {
    expect(resolveFlags()).toEqual(defaultFlagSnapshot());
  });
});

describe('isEnabled()', () => {
  it('按快照读取开关', () => {
    const snapshot = resolveFlags({ readonlySyncEnabled: false });

    expect(isEnabled(snapshot, 'readonlySyncEnabled')).toBe(false);
    expect(isEnabled(snapshot, 'fullTextSearchEnabled')).toBe(true);
  });
});
