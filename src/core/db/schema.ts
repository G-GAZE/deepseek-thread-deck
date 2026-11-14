/**
 * 数据层唯一事实源（AGENTS.md §4）。
 *
 * 规则：
 * - 字段定义以本文件为准，`docs/prd.md` / `docs/architecture.md` 只做产品侧说明。
 * - 新增字段或索引必须递增 `DB_VERSION`，并在 `MIGRATIONS` 追加一条迁移；
 *   不允许无迁移直接改 schema。
 * - 时间戳统一用 epoch 毫秒（number），便于建索引与排序。
 */

export const DB_NAME = 'deepseek-thread-deck';

/** 当前 schema 版本，必须等于 MIGRATIONS 中最大的 version。 */
export const DB_VERSION = 1;

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type ForkStatus = 'pending' | 'replaying' | 'done' | 'failed';

/** 附件仅存元数据；分叉重放不可恢复附件内容（ADR-005）。 */
export interface AttachmentMeta {
  name: string;
  mimeType?: string;
  size?: number;
  kind?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  color?: string;
  /** P1 上下文注入用的系统提示词预设；P0 只存不读。 */
  preset?: string;
  fileRefs: string[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  /** DeepSeek 侧会话 id，唯一。 */
  remoteId: string;
  title: string;
  /** null 表示未分类。 */
  projectId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  /** 全局主键，由 `toMessageKey(convId, remoteMessageId)` 生成。 */
  id: string;
  convId: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  /** 会话内顺序，从 0 开始。 */
  order: number;
  attachmentMeta: AttachmentMeta[];
}

export interface ForkRecord {
  id: string;
  parentConvId: string;
  parentMessageId: string;
  newConvId: string | null;
  status: ForkStatus;
  createdAt: number;
}

export interface SearchIndexRecord {
  /** 主键，由 `toSearchIndexKey(convId, messageId)` 生成。 */
  id: string;
  convId: string;
  /** 对话级索引行使用空字符串，保证 `[convId+messageId]` 复合索引始终可建。 */
  messageId: string;
  title: string;
  body: string;
  tokens: string[];
}

export interface DeckDatabaseSchema {
  project: ProjectRecord;
  conversation: ConversationRecord;
  message: MessageRecord;
  fork: ForkRecord;
  searchIndex: SearchIndexRecord;
}

export type StoreName = keyof DeckDatabaseSchema;

export const STORE_NAMES = [
  'project',
  'conversation',
  'message',
  'fork',
  'searchIndex',
] as const satisfies readonly StoreName[];

export interface DbMigration {
  readonly version: number;
  readonly description: string;
  /** Dexie 的 stores 声明串，键为表名。 */
  readonly stores: Readonly<Record<StoreName, string>>;
}

const V1_STORES: Readonly<Record<StoreName, string>> = {
  project: 'id, name, createdAt, updatedAt',
  conversation: 'id, &remoteId, projectId, createdAt, updatedAt, *tags',
  message: 'id, convId, [convId+order], order',
  fork: 'id, parentConvId, newConvId, status, createdAt',
  searchIndex: 'id, convId, messageId, [convId+messageId], *tokens',
};

/**
 * 迁移表，只追加不修改。
 * 新增 v2 时：把 DB_VERSION 改为 2，并在数组末尾追加 `{ version: 2, ... }`。
 */
export const MIGRATIONS: readonly DbMigration[] = [
  {
    version: 1,
    description: 'P0 基础表：项目、对话、消息、分叉、检索索引',
    stores: V1_STORES,
  },
];

export function schemaForVersion(version: number): Readonly<Record<StoreName, string>> | undefined {
  return MIGRATIONS.find((migration) => migration.version === version)?.stores;
}

export function toMessageKey(convId: string, remoteMessageId: string): string {
  return `${convId}:${remoteMessageId}`;
}

export function toSearchIndexKey(convId: string, messageId = ''): string {
  return messageId === '' ? `${convId}:__conversation__` : `${convId}:${messageId}`;
}
