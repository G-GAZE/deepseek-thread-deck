import type { DeckDatabase } from '@/core/db';
import type { ConversationRecord, ProjectRecord } from '@/core/db/schema';
import type { CoreResult } from '@/shared/result';

/** 项目名长度上限（trim 后）；与 UI 输入框保持一致。 */
export const PROJECT_NAME_MAX_LENGTH = 60;

/** 颜色值按字符串保存，限制长度避免脏数据；不强制 hex 格式。 */
export const PROJECT_COLOR_MAX_LENGTH = 32;

export interface ProjectNode {
  id: string;
  name: string;
  color?: string;
  conversationCount: number;
}

export interface ProjectTree {
  projects: ProjectNode[];
  /** projectId === null 的会话数。 */
  uncategorizedCount: number;
}

export interface CreateProjectInput {
  name: string;
  color?: string;
}

export interface DeleteProjectResult {
  /** 被置为未分类的会话 id，供编排层刷新检索索引。 */
  affectedConvIds: string[];
}

/**
 * 单层项目（P0）：无父子层级、无手动排序字段，未分类 = `projectId === null`。
 * 只操作本地自有表（`project` / `conversation.projectId`），不碰页面与 driver。
 */
export interface ProjectStore {
  listTree(): Promise<CoreResult<ProjectTree>>;
  createProject(input: CreateProjectInput): Promise<CoreResult<ProjectRecord>>;
  renameProject(id: string, name: string): Promise<CoreResult<void>>;
  deleteProject(id: string): Promise<CoreResult<DeleteProjectResult>>;
  assignConversation(convId: string, projectId: string | null): Promise<CoreResult<void>>;
  listConversations(projectId: string | null): Promise<CoreResult<ConversationRecord[]>>;
}

export interface ProjectStoreDeps {
  db: DeckDatabase;
  now?: () => number;
}
