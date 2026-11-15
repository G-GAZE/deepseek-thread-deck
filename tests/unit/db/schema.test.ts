import { describe, expect, it } from 'vitest';

import {
  DB_NAME,
  DB_VERSION,
  MIGRATIONS,
  STORE_NAMES,
  schemaForVersion,
  toMessageKey,
  toSearchIndexKey,
} from '@/core/db/schema';

describe('db schema 声明', () => {
  it('声明 6 张表（v2 增加索引快照表）', () => {
    expect(STORE_NAMES).toEqual([
      'project',
      'conversation',
      'message',
      'fork',
      'searchIndex',
      'searchIndexSnapshot',
    ]);
  });

  it('数据库名与项目一致', () => {
    expect(DB_NAME).toBe('deepseek-thread-deck');
  });

  it('迁移版本从 1 连续递增到 DB_VERSION', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      Array.from({ length: DB_VERSION }, (_, index) => index + 1),
    );
    expect(MIGRATIONS.at(-1)?.version).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(2);
  });

  it('v1 覆盖核心 5 张表', () => {
    const v1 = MIGRATIONS.find((migration) => migration.version === 1);

    expect(Object.keys(v1?.stores ?? {}).sort()).toEqual(
      ['conversation', 'fork', 'message', 'project', 'searchIndex'].sort(),
    );
  });

  it('v2 只新增 searchIndexSnapshot，已有表结构完全不变（零 backfill）', () => {
    const v1 = MIGRATIONS.find((migration) => migration.version === 1)?.stores;
    const v2 = MIGRATIONS.find((migration) => migration.version === 2)?.stores;

    expect(v2?.searchIndexSnapshot).toBe('id');
    for (const [name, definition] of Object.entries(v1 ?? {})) {
      expect(v2?.[name as keyof typeof v2]).toBe(definition);
    }
  });

  it('最新迁移覆盖全部表，避免漏建表', () => {
    const latest = MIGRATIONS.at(-1);

    expect(Object.keys(latest?.stores ?? {}).sort()).toEqual([...STORE_NAMES].sort());
  });
});

describe('db schema 索引', () => {
  it('conversation 以 remoteId 建唯一索引', () => {
    expect(schemaForVersion(DB_VERSION)?.conversation).toContain('&remoteId');
  });

  it('message 建 convId + order 复合索引，支持按会话顺序读取', () => {
    expect(schemaForVersion(DB_VERSION)?.message).toContain('[convId+order]');
  });

  it('searchIndex 对 tokens 建多值索引，支持按词反查', () => {
    expect(schemaForVersion(DB_VERSION)?.searchIndex).toContain('*tokens');
  });

  it('未知版本返回 undefined', () => {
    expect(schemaForVersion(DB_VERSION + 1)).toBeUndefined();
  });
});

describe('主键生成', () => {
  it('message 主键带上会话前缀，跨会话不冲突', () => {
    expect(toMessageKey('c1', 'm1')).toBe('c1:m1');
    expect(toMessageKey('c1', 'm1')).not.toBe(toMessageKey('c2', 'm1'));
  });

  it('对话级索引行使用固定占位，保证复合索引可建', () => {
    expect(toSearchIndexKey('c1')).toBe('c1:__conversation__');
    expect(toSearchIndexKey('c1', 'm1')).toBe('c1:m1');
  });
});
