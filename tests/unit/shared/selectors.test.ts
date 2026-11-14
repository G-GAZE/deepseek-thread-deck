import { describe, expect, it } from 'vitest';

import {
  SELECTORS,
  SELECTOR_NAMES,
  allSelectorsAdapted,
  isAdaptedDefinition,
  isSelectorAdapted,
  missingSelectors,
  selectorStatusLabel,
} from '@/shared/selectors';

describe('选择器骨架', () => {
  it('声明的名字与选择器表键一致', () => {
    expect(Object.keys(SELECTORS).sort()).toEqual([...SELECTOR_NAMES].sort());
  });

  it('未实测前全部为 null 且状态为 unverified（不猜真实结构）', () => {
    for (const name of SELECTOR_NAMES) {
      expect(SELECTORS[name].selector).toBeNull();
      expect(SELECTORS[name].status).toBe('unverified');
    }
  });

  it('未实测的选择器不算已适配', () => {
    for (const name of SELECTOR_NAMES) {
      expect(isSelectorAdapted(name)).toBe(false);
    }
  });

  it('missingSelectors 覆盖全部未适配项，allSelectorsAdapted 为 false', () => {
    expect(missingSelectors()).toEqual([...SELECTOR_NAMES]);
    expect(allSelectorsAdapted()).toBe(false);
  });
});

describe('isAdaptedDefinition()', () => {
  it('verified 且选择器非空才算已适配', () => {
    expect(isAdaptedDefinition({ selector: '#chat', status: 'verified' })).toBe(true);
  });

  it('状态标了 verified 但选择器仍为空，视为未适配', () => {
    expect(isAdaptedDefinition({ selector: null, status: 'verified' })).toBe(false);
  });

  it('broken 即使残留旧选择器也不算已适配', () => {
    expect(isAdaptedDefinition({ selector: '#chat', status: 'broken' })).toBe(false);
  });
});

describe('selectorStatusLabel()', () => {
  it('未适配与损坏都显示「适配中」', () => {
    expect(selectorStatusLabel('unverified')).toBe('适配中');
    expect(selectorStatusLabel('broken')).toBe('适配中');
  });

  it('已适配显示「已适配」', () => {
    expect(selectorStatusLabel('verified')).toBe('已适配');
  });
});
