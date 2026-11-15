import type { ConversationRecord, ProjectRecord } from '@/core/db/schema';
import { err, ok, toCoreError, type CoreResult } from '@/shared/result';

import {
  PROJECT_COLOR_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type CreateProjectInput,
  type DeleteProjectResult,
  type ProjectNode,
  type ProjectStore,
  type ProjectStoreDeps,
  type ProjectTree,
} from './types';

/**
 * 单层项目存储（任务 0001 阶段 6）。
 *
 * 边界：
 * - 只写本地自有表：`project` 与 `conversation.projectId`；
 * - **不改 `conversation.updatedAt`**：那是远端字段（sync 游标 / 索引增量都依赖它），
 *   本地分类变更通过编排层调用 `search.upsertConversation()` 刷新，重启后由索引层重读会话表；
 * - 不 import search / ui / driver，保持 core 内部解耦。
 */
export function createProjectStore(deps: ProjectStoreDeps): ProjectStore {
  const now = deps.now ?? ((): number => Date.now());

  async function listTree(): Promise<CoreResult<ProjectTree>> {
    try {
      const projects = await deps.db.project.toArray();
      projects.sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );

      const nodes: ProjectNode[] = [];
      for (const project of projects) {
        const conversationCount = await deps.db.conversation
          .where('projectId')
          .equals(project.id)
          .count();
        nodes.push({
          id: project.id,
          name: project.name,
          ...(project.color === undefined ? {} : { color: project.color }),
          conversationCount,
        });
      }

      const uncategorizedCount = await deps.db.conversation
        .filter((conversation) => conversation.projectId === null)
        .count();

      return ok({ projects: nodes, uncategorizedCount });
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
    }
  }

  async function createProject(input: CreateProjectInput): Promise<CoreResult<ProjectRecord>> {
    const name = normalizeName(input.name);
    if (name === null) return invalidName();

    const color = normalizeColor(input.color);
    if (color === INVALID_COLOR) return invalidColor();

    const timestamp = now();
    const record: ProjectRecord = {
      id: globalThis.crypto.randomUUID(),
      name,
      fileRefs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(color === undefined ? {} : { color }),
    };

    try {
      await deps.db.project.add(record);
      return ok(record);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function renameProject(id: string, name: string): Promise<CoreResult<void>> {
    const normalized = normalizeName(name);
    if (normalized === null) return invalidName();

    try {
      const existing = await deps.db.project.get(id);
      if (existing === undefined) return notFound(`项目不存在: ${id}`);

      await deps.db.project.update(id, { name: normalized, updatedAt: now() });
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function deleteProject(id: string): Promise<CoreResult<DeleteProjectResult>> {
    try {
      const existing = await deps.db.project.get(id);
      if (existing === undefined) return notFound(`项目不存在: ${id}`);

      const affectedConvIds = (
        await deps.db.conversation.where('projectId').equals(id).primaryKeys()
      ).map(String);

      // 同一事务内「会话回落未分类 + 删除项目」：要么都成功，要么都不生效。
      await deps.db.transaction('rw', deps.db.project, deps.db.conversation, async () => {
        await deps.db.conversation.where('projectId').equals(id).modify({ projectId: null });
        await deps.db.project.delete(id);
      });

      return ok({ affectedConvIds });
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function assignConversation(
    convId: string,
    projectId: string | null,
  ): Promise<CoreResult<void>> {
    try {
      const conversation = await deps.db.conversation.get(convId);
      if (conversation === undefined) return notFound(`会话不存在: ${convId}`);

      if (projectId !== null) {
        const project = await deps.db.project.get(projectId);
        if (project === undefined) return notFound(`项目不存在: ${projectId}`);
      }

      if (conversation.projectId === projectId) return ok(undefined);

      await deps.db.conversation.update(convId, { projectId });
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function listConversations(
    projectId: string | null,
  ): Promise<CoreResult<ConversationRecord[]>> {
    try {
      const rows =
        projectId === null
          ? await deps.db.conversation
              .filter((conversation) => conversation.projectId === null)
              .toArray()
          : await deps.db.conversation.where('projectId').equals(projectId).toArray();

      rows.sort(
        (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
      return ok(rows);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
    }
  }

  return {
    listTree,
    createProject,
    renameProject,
    deleteProject,
    assignConversation,
    listConversations,
  };
}

const INVALID_COLOR = Symbol('invalid-color');

function normalizeName(raw: string): string | null {
  const name = raw.trim();
  if (name === '' || name.length > PROJECT_NAME_MAX_LENGTH) return null;
  return name;
}

function normalizeColor(raw: string | undefined): string | undefined | typeof INVALID_COLOR {
  if (raw === undefined) return undefined;
  const color = raw.trim();
  if (color === '') return undefined;
  if (color.length > PROJECT_COLOR_MAX_LENGTH) return INVALID_COLOR;
  return color;
}

function invalidName<T = never>(): CoreResult<T> {
  return err('INVALID_ARGUMENT', `项目名需为 1–${PROJECT_NAME_MAX_LENGTH} 个字符`);
}

function invalidColor<T = never>(): CoreResult<T> {
  return err('INVALID_ARGUMENT', `颜色值不得超过 ${PROJECT_COLOR_MAX_LENGTH} 个字符`);
}

function notFound<T = never>(message: string): CoreResult<T> {
  return err('NOT_FOUND', message);
}
