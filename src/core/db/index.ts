import Dexie, { type Table } from 'dexie';

import { toCoreError, type CoreResult } from '@/shared/result';

import {
  DB_NAME,
  MIGRATIONS,
  type ConversationRecord,
  type ForkRecord,
  type MessageRecord,
  type ProjectRecord,
  type SearchIndexRecord,
} from './schema';

/**
 * Dexie 实例。表结构全部来自 `schema.ts` 的迁移表，这里不重复声明索引，
 * 避免出现第二份事实源。
 */
export class DeckDatabase extends Dexie {
  declare project: Table<ProjectRecord, string>;
  declare conversation: Table<ConversationRecord, string>;
  declare message: Table<MessageRecord, string>;
  declare fork: Table<ForkRecord, string>;
  declare searchIndex: Table<SearchIndexRecord, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    for (const migration of MIGRATIONS) {
      this.version(migration.version).stores({ ...migration.stores });
    }
  }
}

export function createDeckDatabase(name: string = DB_NAME): DeckDatabase {
  return new DeckDatabase(name);
}

/**
 * 打开数据库。失败时不抛异常，返回 `DB_OPEN_FAILED`，
 * 由 `core/degradation` 决定 UI 降级文案（AGENTS.md §7）。
 */
export async function openDeckDatabase(name: string = DB_NAME): Promise<CoreResult<DeckDatabase>> {
  const db = createDeckDatabase(name);
  try {
    await db.open();
    return { ok: true, data: db };
  } catch (cause) {
    closeQuietly(db);
    return { ok: false, error: toCoreError(cause, 'DB_OPEN_FAILED', true) };
  }
}

function closeQuietly(db: DeckDatabase): void {
  try {
    db.close();
  } catch {
    // 打开失败的实例可能无法关闭，这里只做尽力而为的清理。
  }
}
