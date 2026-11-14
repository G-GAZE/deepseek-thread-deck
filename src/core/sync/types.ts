import type { AttachmentMeta, MessageRole } from '@/core/db/schema';
import type { DeckDatabase } from '@/core/db';
import type { FeatureFlagSnapshot } from '@/shared/feature-flags';
import type { CoreErrorCode, CoreResult } from '@/shared/result';

import type { SyncLockPort } from './lock';

/**
 * conversation-sync 的对外契约（任务 0001 阶段 4）。
 * 设计说明见 `docs/tasks/0001-conversation-sync-design.md`。
 * 本模块只读：不拦截请求、不发网络请求、不写页面 DOM。
 */

export interface RemoteMessage {
  remoteId: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  /** 远端原始顺序，不重排、不补洞。 */
  order: number;
  attachmentMeta?: AttachmentMeta[];
}

export interface RemoteConversationSummary {
  remoteId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 页面拿不到时为 null，不猜。 */
  messageCount: number | null;
}

export interface RemoteConversationDetail extends RemoteConversationSummary {
  messages: RemoteMessage[];
}

export type SourceAvailability = { ready: true } | { ready: false; reason: CoreErrorCode };

/**
 * 远端数据源端口。P0 只有两个实现：
 * - `core/driver/main-world-source.ts`：MAIN world 只读通道（占位未实现）；
 * - `tests/fixtures/fixture-source.ts`：合成夹具。
 */
export interface RemoteSource {
  getAvailability(): Promise<CoreResult<SourceAvailability>>;
  listConversations(): Promise<CoreResult<RemoteConversationSummary[]>>;
  fetchConversation(remoteId: string): Promise<CoreResult<RemoteConversationDetail>>;
}

export interface SyncFailure {
  remoteId: string;
  /** 形如 `DB_WRITE_FAILED: 磁盘已满`。 */
  reason: string;
}

export interface SyncSummary {
  total: number;
  synced: number;
  skipped: number;
  failed: SyncFailure[];
  /** 取消时「未处理」的会话数；正常完成为 0。用于 UI「已处理 N / M」。 */
  cancelled: number;
  /** D3：便于把性能写进交付证据。 */
  durationMs?: number;
}

export interface SyncStatus {
  lastSyncedAt: number | null;
  conversationCount: number;
  messageCount: number;
  selectorsReady: boolean;
}

export interface SyncOptions {
  /** 跳过游标判定，强制全量。 */
  full?: boolean;
  /** 分片可取消：每批与每个会话前检查。 */
  signal?: AbortSignal;
  /** 每批会话数，默认 20。 */
  batchSize?: number;
}

export interface ConversationSync {
  syncAll(options?: SyncOptions): Promise<CoreResult<SyncSummary>>;
  syncConversation(remoteId: string): Promise<CoreResult<SyncSummary>>;
  getStatus(): Promise<CoreResult<SyncStatus>>;
}

export const SYNC_CURSOR_SCHEMA_VERSION = 1;

export interface SyncCursor {
  schemaVersion: typeof SYNC_CURSOR_SCHEMA_VERSION;
  /** 本轮成功写入会话的最大 updatedAt；null 表示从未成功推进。 */
  lastSyncedAt: number | null;
  lastRunAt: number | null;
}

export interface SyncCursorPort {
  read(): Promise<CoreResult<SyncCursor | null>>;
  write(cursor: SyncCursor): Promise<CoreResult<void>>;
}

export interface ConversationSyncDeps {
  source: RemoteSource;
  db: DeckDatabase;
  flags: FeatureFlagSnapshot;
  cursor?: SyncCursorPort;
  /** 多标签页互斥锁；缺省表示不加锁（仅测试/单标签场景）。 */
  lock?: SyncLockPort;
  now?: () => number;
}
