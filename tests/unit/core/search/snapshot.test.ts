import { describe, expect, it } from 'vitest';

import type { SearchIndexSnapshotRecord } from '@/core/db/schema';
import {
  SNAPSHOT_ID,
  TOKENIZER_VERSION,
  validateSnapshot,
  type SnapshotContext,
} from '@/core/search/snapshot';

const NOW = 1_800_000_000_000;

function record(overrides: Partial<SearchIndexSnapshotRecord> = {}): SearchIndexSnapshotRecord {
  return {
    id: SNAPSHOT_ID,
    json: '{"documentCount":1}',
    builtAt: NOW - 60_000,
    docCount: 1,
    schemaVersion: 2,
    minisearchVersion: '7.2.0',
    tokenizerVersion: TOKENIZER_VERSION,
    ...overrides,
  };
}

function context(overrides: Partial<SnapshotContext> = {}): SnapshotContext {
  return {
    dbVersion: 2,
    minisearchVersion: '7.2.0',
    tokenizerVersion: TOKENIZER_VERSION,
    maxUpdatedAt: NOW - 120_000,
    now: NOW,
    ...overrides,
  };
}

describe('validateSnapshot()', () => {
  it('版本一致且数据不新于快照时可用', () => {
    expect(validateSnapshot(record(), context())).toEqual({ usable: true });
  });

  it('快照缺失不可用', () => {
    expect(validateSnapshot(undefined, context())).toEqual({
      usable: false,
      reason: 'missing',
    });
  });

  it('schemaVersion 不符不可用', () => {
    expect(validateSnapshot(record({ schemaVersion: 1 }), context())).toEqual({
      usable: false,
      reason: 'schema-version',
    });
  });

  it('minisearchVersion 不符不可用（升级包后必须失效）', () => {
    expect(validateSnapshot(record({ minisearchVersion: '7.1.0' }), context())).toEqual({
      usable: false,
      reason: 'minisearch-version',
    });
  });

  it('tokenizerVersion 不符不可用', () => {
    expect(validateSnapshot(record({ tokenizerVersion: 0 }), context())).toEqual({
      usable: false,
      reason: 'tokenizer-version',
    });
  });

  it('json 为空不可用', () => {
    expect(validateSnapshot(record({ json: '' }), context())).toEqual({
      usable: false,
      reason: 'empty-json',
    });
  });

  it('maxUpdatedAt 明显倒退（超过 24h）判定不可用', () => {
    const skewed = context({ maxUpdatedAt: NOW - 60_000 - 25 * 60 * 60 * 1000 });

    expect(validateSnapshot(record(), skewed)).toEqual({ usable: false, reason: 'clock-skew' });
  });

  it('小幅时钟漂移（23h 内）不算倒退', () => {
    const drifted = context({ maxUpdatedAt: NOW - 60_000 - 23 * 60 * 60 * 1000 });

    expect(validateSnapshot(record(), drifted)).toEqual({ usable: true });
  });

  it('数据库没有会话时不做倒退判定', () => {
    expect(validateSnapshot(record(), context({ maxUpdatedAt: null }))).toEqual({
      usable: true,
    });
  });
});
