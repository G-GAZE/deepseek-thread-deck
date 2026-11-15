import { openDeckDatabase, type DeckDatabase } from '@/core/db';
import { createBrowserLocalStorage } from '@/core/feature-flags/storage';
import { createFeatureFlagStore } from '@/core/feature-flags/store';
import { createProjectStore } from '@/core/project/project-store';
import type { ProjectStore } from '@/core/project/types';
import { createSearchLock } from '@/core/search/lock';
import { createProgressStorage, type IndexProgressPort } from '@/core/search/progress';
import { createSearchIndex } from '@/core/search/search-index';
import type { SearchIndex } from '@/core/search/types';
import { createConversationSync } from '@/core/sync/conversation-sync';
import { createCursorStorage } from '@/core/sync/cursor';
import { createStorageLock } from '@/core/sync/lock';
import { createPageHistorySource } from '@/core/sync/page-history-source';
import type { ConversationSync } from '@/core/sync/types';
import { defaultFlagSnapshot, type FeatureFlagSnapshot } from '@/shared/feature-flags';
import type { LocalStoragePort } from '@/shared/local-storage';
import { ok, type CoreResult } from '@/shared/result';

/**
 * UI 的组合根：在这里把 core 暴露的 API 装配成 UI 可直接用的服务。
 *
 * 分层（AGENTS.md §1）：UI 不直接碰 IndexedDB/driver —— 这里只调用 core API
 * （`openDeckDatabase` / `create*Store`）；ESLint 仍禁止 UI import `dexie` 与 `@/core/driver/*`。
 */
export interface DeckServices {
  db: DeckDatabase;
  flags: FeatureFlagSnapshot;
  projects: ProjectStore;
  search: SearchIndex;
  progress: IndexProgressPort;
  /** 真实 RemoteSource（MAIN world 只读通道）尚未实现，P0 为 null → UI 禁用同步并提示「等待页面适配」。 */
  sync: ConversationSync | null;
  close(): void;
}

let current: DeckServices | null = null;
let bootstrapError: string | null = null;

export function setBootstrapError(message: string): void {
  bootstrapError = message;
}

export function getBootstrapError(): string | null {
  return bootstrapError;
}

export function setDeckServices(services: DeckServices): void {
  current = services;
  bootstrapError = null;
}

export function getDeckServices(): DeckServices {
  if (current === null) throw new Error('DeckServices 尚未初始化');
  return current;
}

export function resetDeckServices(): void {
  current?.close();
  current = null;
  bootstrapError = null;
}

export function hasDeckServices(): boolean {
  return current !== null;
}

export async function createDeckServices(): Promise<CoreResult<DeckServices>> {
  const opened = await openDeckDatabase();
  if (!opened.ok) return opened;

  const db = opened.data;
  const storage: LocalStoragePort = createBrowserLocalStorage();

  const flagsResult = await createFeatureFlagStore(storage).get();
  // flag 读失败退回默认值（默认开启全文检索），不阻塞 UI。
  const flags = flagsResult.ok ? flagsResult.data : defaultFlagSnapshot();

  const progress = createProgressStorage(storage);
  const search = createSearchIndex({
    db,
    flags,
    lock: createSearchLock(storage),
    progress,
  });
  const projects = createProjectStore({ db });
  // 真实只读数据源：读页面自己的 IndexedDB 缓存（deepseek-chat / history-message）。
  const sync = createConversationSync({
    source: createPageHistorySource(),
    db,
    flags,
    cursor: createCursorStorage(storage),
    lock: createStorageLock(storage),
  });

  return ok({
    db,
    flags,
    projects,
    search,
    progress,
    sync,
    close: () => {
      db.close();
    },
  });
}
