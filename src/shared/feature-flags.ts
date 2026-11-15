/**
 * Feature flag 注册表（ADR-006：写入类能力必须 feature flag + 降级路径）。
 *
 * 设计约束：
 * - 本文件是纯代码：无副作用、不读页面、不碰浏览器 API，因此 core 与 UI 都能用，也能直接单测。
 * - 开关的持久化由调用方注入（后续 `core/feature-flags` 存储层负责），这里只提供默认值与解析。
 * - 新增开关必须同步更新 `defaultFlagSnapshot()`，让遗漏在类型检查阶段暴露。
 */

export const FEATURE_FLAG_NAMES = ['readonlySyncEnabled', 'fullTextSearchEnabled'] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export interface FeatureFlagDefinition {
  readonly name: FeatureFlagName;
  /** 默认值。默认开启的能力必须自带降级路径。 */
  readonly defaultValue: boolean;
  readonly description: string;
  /** 决策依据，便于审计「为什么有这个开关」。 */
  readonly adr: string;
}

export const FEATURE_FLAGS: Readonly<Record<FeatureFlagName, FeatureFlagDefinition>> = {
  readonlySyncEnabled: {
    name: 'readonlySyncEnabled',
    defaultValue: true,
    description: 'P0 只读同步总开关；关闭后不读取页面数据、不写 IndexedDB，UI 显示「同步不可用」。',
    adr: 'ADR-006',
  },
  fullTextSearchEnabled: {
    name: 'fullTextSearchEnabled',
    defaultValue: true,
    description: '全文检索开关；关闭或索引初始化失败时退回标题搜索。',
    adr: 'ADR-006',
  },
};

export type FeatureFlagSnapshot = Readonly<Record<FeatureFlagName, boolean>>;

export function defaultFlagSnapshot(): FeatureFlagSnapshot {
  return {
    readonlySyncEnabled: FEATURE_FLAGS.readonlySyncEnabled.defaultValue,
    fullTextSearchEnabled: FEATURE_FLAGS.fullTextSearchEnabled.defaultValue,
  };
}

/**
 * 把存储里读到的原始值（可能来自旧版本、可能被改脏）解析成可信快照。
 * 未知键与非布尔值一律忽略，回落到默认值。
 */
export function resolveFlags(
  overrides: Readonly<Record<string, unknown>> = {},
): FeatureFlagSnapshot {
  return {
    readonlySyncEnabled: pickBoolean(overrides, 'readonlySyncEnabled'),
    fullTextSearchEnabled: pickBoolean(overrides, 'fullTextSearchEnabled'),
  };
}

export function isEnabled(snapshot: FeatureFlagSnapshot, name: FeatureFlagName): boolean {
  return snapshot[name];
}

function pickBoolean(overrides: Readonly<Record<string, unknown>>, name: FeatureFlagName): boolean {
  const value = overrides[name];
  return typeof value === 'boolean' ? value : FEATURE_FLAGS[name].defaultValue;
}
