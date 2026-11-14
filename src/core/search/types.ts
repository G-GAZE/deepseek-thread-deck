import type { DeckDatabase } from '@/core/db';
import type { FeatureFlagSnapshot } from '@/shared/feature-flags';
import type { CoreResult } from '@/shared/result';
import type { StorageLockPort } from '@/shared/storage-lock';

import type { IndexProgressPort } from './progress';

/**
 * search-index 的对外契约（任务 0001 阶段 5）。
 * 设计说明见 `docs/tasks/0001-search-design.md`。
 */

export interface SearchOptions {
  limit?: number;
  projectId?: string;
}

export interface SearchHit {
  convId: string;
  /** 会话级命中（0 消息会话）时为 undefined。 */
  messageId?: string;
  title: string;
  snippet: string;
  score: number;
}

export interface SearchIndex {
  rebuild(): Promise<CoreResult<void>>;
  upsertConversation(convId: string): Promise<CoreResult<void>>;
  removeConversation(convId: string): Promise<CoreResult<void>>;
  search(query: string, opts?: SearchOptions): Promise<CoreResult<SearchHit[]>>;
}

/** 送进检索引擎的文档。`projectId` 用空串表示未分类，便于存储在引擎里。 */
export interface SearchDocument {
  id: string;
  title: string;
  body: string;
  convId: string;
  messageId: string;
  projectId: string;
}

export interface SearchOutcome {
  id: string;
  score: number;
}

/**
 * 检索引擎端口。默认实现是 MiniSearch（`createMiniSearchEngine`）；
 * 抽成端口是为了能单测「初始化失败 → 退回标题搜索」，也便于将来替换实现。
 */
export interface SearchEngine {
  addAll(docs: readonly SearchDocument[]): void;
  discard(id: string): void;
  search(
    query: string,
    options: { limit: number; filter?: (doc: SearchDocument) => boolean },
  ): SearchOutcome[];
  /** 序列化为快照 JSON（`MiniSearch.toJSON()` 的结果）。 */
  serialize(): string;
}

export interface SearchIndexDeps {
  db: DeckDatabase;
  flags: FeatureFlagSnapshot;
  engineFactory?: () => SearchEngine;
  /** 从快照 JSON 恢复引擎；缺省用 MiniSearch.loadJSON。 */
  engineLoader?: (json: string) => SearchEngine;
  /** rebuild 的互斥锁（`deck.search.lock`）。 */
  lock?: StorageLockPort;
  /** 首建进度上报；读写失败都不阻塞构建。 */
  progress?: IndexProgressPort;
  now?: () => number;
}
