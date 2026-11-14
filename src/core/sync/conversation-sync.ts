import type { MessageRecord } from '@/core/db/schema';
import { toMessageKey } from '@/core/db/schema';
import { ok, toCoreError, type CoreResult } from '@/shared/result';

import {
  SYNC_CURSOR_SCHEMA_VERSION,
  type ConversationSync,
  type ConversationSyncDeps,
  type RemoteConversationDetail,
  type RemoteConversationSummary,
  type RemoteMessage,
  type SyncCursor,
  type SyncFailure,
  type SyncOptions,
  type SyncStatus,
  type SyncSummary,
} from './types';

const DEFAULT_BATCH_SIZE = 20;

/**
 * 只读同步实现（ADR-007）。
 *
 * 关键约束（见设计说明）：
 * - 只写 `conversation` / `message`，绝不写 `searchIndex`；
 * - 单会话一个事务，失败只回滚该会话；
 * - 游标保守推进：`cancelled` 或存在 `failed` 时一律不推进，避免失败会话永不重试；
 * - 分片 + 取消：每批与每个会话前检查 `signal`。
 */
export function createConversationSync(deps: ConversationSyncDeps): ConversationSync {
  const now = deps.now ?? ((): number => Date.now());

  async function syncAll(options: SyncOptions = {}): Promise<CoreResult<SyncSummary>> {
    const gate = await ensureReady();
    if (!gate.ok) return gate;

    const listed = await deps.source.listConversations();
    if (!listed.ok) return listed;

    const startedAt = now();
    const cursor = await readCursor(options);
    const { candidates, duplicateCount } = dedupe(listed.data);
    const targets = selectTargets(candidates, options, cursor);
    const skippedByCursor = candidates.length - targets.length;

    const failed: SyncFailure[] = [];
    const syncedUpdatedAt: number[] = [];
    let synced = 0;
    let cancelled = false;

    for (const batch of chunk(targets, resolveBatchSize(options))) {
      if (isAborted(options.signal)) {
        cancelled = true;
        break;
      }

      for (const summary of batch) {
        if (isAborted(options.signal)) {
          cancelled = true;
          break;
        }
        const outcome = await syncOne(summary);
        if (outcome.ok) {
          synced += 1;
          syncedUpdatedAt.push(summary.updatedAt);
        } else {
          failed.push(outcome.failure);
        }
      }

      if (cancelled) break;
      // 让出事件循环，避免大批量同步长时间卡住页面。
      await yieldToEventLoop();
    }

    const summary: SyncSummary = {
      total: listed.data.length,
      synced,
      skipped: duplicateCount + skippedByCursor,
      failed,
      durationMs: now() - startedAt,
    };
    if (cancelled) summary.cancelled = true;

    if (!cancelled && failed.length === 0 && synced > 0) {
      await advanceCursor(Math.max(...syncedUpdatedAt), startedAt);
    }

    return ok(summary);
  }

  async function syncConversation(remoteId: string): Promise<CoreResult<SyncSummary>> {
    const gate = await ensureReady();
    if (!gate.ok) return gate;

    const startedAt = now();
    const detail = await deps.source.fetchConversation(remoteId);
    if (!detail.ok) return detail;

    if (detail.data.remoteId !== remoteId) {
      return {
        ok: false,
        error: toCoreError(
          new Error('远端返回的会话 id 与请求不一致'),
          'SOURCE_PARSE_FAILED',
          true,
        ),
      };
    }

    try {
      await persistConversation(detail.data);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }

    return ok({
      total: 1,
      synced: 1,
      skipped: 0,
      failed: [],
      durationMs: now() - startedAt,
    });
  }

  async function getStatus(): Promise<CoreResult<SyncStatus>> {
    const availability = await deps.source.getAvailability();

    try {
      const conversationCount = await deps.db.conversation.count();
      const messageCount = await deps.db.message.count();
      const cursorResult = deps.cursor === undefined ? ok(null) : await deps.cursor.read();

      return ok({
        lastSyncedAt: cursorResult.ok ? (cursorResult.data?.lastSyncedAt ?? null) : null,
        conversationCount,
        messageCount,
        selectorsReady: availability.ok && availability.data.ready,
      });
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
    }
  }

  async function ensureReady(): Promise<CoreResult<null>> {
    if (!deps.flags.readonlySyncEnabled) {
      return {
        ok: false,
        error: {
          code: 'SYNC_DISABLED',
          message: '只读同步已关闭（feature flag readonlySyncEnabled = false）',
          retryable: false,
        },
      };
    }

    const availability = await deps.source.getAvailability();
    if (!availability.ok) return availability;
    if (!availability.data.ready) {
      return {
        ok: false,
        error: {
          code: availability.data.reason,
          message: '页面选择器不可用，同步降级为「适配中」',
          retryable: true,
        },
      };
    }

    return ok(null);
  }

  async function readCursor(options: SyncOptions): Promise<SyncCursor | null> {
    if (options.full === true || deps.cursor === undefined) return null;
    const result = await deps.cursor.read();
    // 游标读失败不阻塞同步：退化为全量，靠幂等 upsert 消化重复。
    return result.ok ? result.data : null;
  }

  function selectTargets(
    candidates: readonly RemoteConversationSummary[],
    options: SyncOptions,
    cursor: SyncCursor | null,
  ): RemoteConversationSummary[] {
    if (options.full === true) return [...candidates];

    const baseline = cursor?.lastSyncedAt ?? null;
    if (baseline === null) return [...candidates];

    return candidates.filter((summary) => summary.updatedAt > baseline);
  }

  async function syncOne(
    summary: RemoteConversationSummary,
  ): Promise<{ ok: true } | { ok: false; failure: SyncFailure }> {
    const detail = await deps.source.fetchConversation(summary.remoteId);
    if (!detail.ok) {
      return { ok: false, failure: failureOf(summary.remoteId, detail.error) };
    }

    if (detail.data.remoteId !== summary.remoteId) {
      return {
        ok: false,
        failure: failureOf(
          summary.remoteId,
          toCoreError(new Error('远端返回的会话 id 与请求不一致'), 'SOURCE_PARSE_FAILED', true),
        ),
      };
    }

    try {
      await persistConversation(detail.data);
      return { ok: true };
    } catch (cause) {
      return {
        ok: false,
        failure: failureOf(summary.remoteId, toCoreError(cause, 'DB_WRITE_FAILED', true)),
      };
    }
  }

  async function persistConversation(detail: RemoteConversationDetail): Promise<void> {
    await deps.db.transaction('rw', deps.db.conversation, deps.db.message, async () => {
      const existing = await deps.db.conversation.where('remoteId').equals(detail.remoteId).first();

      // Conversation.id 是独立主键，创建后永不改变；remoteId 只做唯一索引。
      const convId = existing?.id ?? detail.remoteId;

      if (existing === undefined) {
        await deps.db.conversation.add({
          id: convId,
          remoteId: detail.remoteId,
          title: detail.title,
          projectId: null,
          tags: [],
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        });
      } else {
        // 只更新远端字段，绝不动本地 projectId / tags / id。
        await deps.db.conversation.update(convId, {
          title: detail.title,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        });
      }

      const rows = detail.messages.map((message) => toMessageRow(convId, message));
      if (rows.length > 0) {
        await deps.db.message.bulkPut(rows);
      }
    });
  }

  async function advanceCursor(lastSyncedAt: number, lastRunAt: number): Promise<void> {
    if (deps.cursor === undefined) return;
    await deps.cursor.write({
      schemaVersion: SYNC_CURSOR_SCHEMA_VERSION,
      lastSyncedAt,
      lastRunAt,
    });
  }

  return { syncAll, syncConversation, getStatus };
}

function toMessageRow(convId: string, message: RemoteMessage): MessageRecord {
  const row: MessageRecord = {
    id: toMessageKey(convId, message.remoteId),
    convId,
    role: message.role,
    content: message.content,
    order: message.order,
    attachmentMeta: message.attachmentMeta ?? [],
  };
  if (message.thinking !== undefined) row.thinking = message.thinking;
  return row;
}

function failureOf(remoteId: string, error: { code: string; message: string }): SyncFailure {
  return { remoteId, reason: `${error.code}: ${error.message}` };
}

function dedupe(conversations: readonly RemoteConversationSummary[]): {
  candidates: RemoteConversationSummary[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const candidates: RemoteConversationSummary[] = [];
  let duplicateCount = 0;

  for (const conversation of conversations) {
    if (seen.has(conversation.remoteId)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(conversation.remoteId);
    candidates.push(conversation);
  }

  return { candidates, duplicateCount };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function resolveBatchSize(options: SyncOptions): number {
  return Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
