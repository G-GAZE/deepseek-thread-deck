import MiniSearch from 'minisearch';

import type { ConversationRecord, MessageRecord, SearchIndexRecord } from '@/core/db/schema';
import { DB_VERSION, toSearchIndexKey } from '@/core/db/schema';
import { err, ok, toCoreError, type CoreResult } from '@/shared/result';
import type { StorageLockPort } from '@/shared/storage-lock';

import type { IndexProgressPhase } from './progress';
import {
  MINISEARCH_VERSION,
  SNAPSHOT_ID,
  TOKENIZER_VERSION,
  createSnapshotStore,
  validateSnapshot,
  type SnapshotStore,
} from './snapshot';
import { createTokenizer, tokenizeText } from './tokenizer';
import type {
  SearchDocument,
  SearchEngine,
  SearchHit,
  SearchIndex,
  SearchIndexDeps,
  SearchOptions,
  SearchOutcome,
} from './types';

const DEFAULT_LIMIT = 20;
const MAX_SNIPPET_LENGTH = 160;
const SNIPPET_LEFT_CONTEXT = 40;
const SNIPPET_RIGHT_CONTEXT = 80;
/** 与 sync 分片一致：索引构建按 20 个会话一批。 */
const BATCH_SIZE = 20;
/** 进度写入的最小间隔，避免频繁写 storage；30s 内至少一次由批次推进保证。 */
const PROGRESS_MIN_INTERVAL_MS = 1_000;

/**
 * 本地全文检索（任务 0001 阶段 5 + 任务 0002 阶段 5.5）。
 *
 * 边界：只从 `conversation` / `message` **读**，只向 `searchIndex` / `searchIndexSnapshot` **写**；
 * 绝不修改 sync 拥有的表。
 *
 * 持久化：启动优先 `loadJSON` 命中快照；失效（版本戳 / JSON 损坏 / 时间倒退）才重建。
 * 快照只是缓存：任何失败都退回「重建 + 标题兜底」。
 */
export function createSearchIndex(deps: SearchIndexDeps): SearchIndex {
  const now = deps.now ?? ((): number => Date.now());
  const engineFactory = deps.engineFactory ?? (() => createMiniSearchEngine());
  const engineLoader = deps.engineLoader ?? ((json: string) => loadMiniSearchEngine(json));
  const snapshots: SnapshotStore = createSnapshotStore(deps.db);

  let engine: SearchEngine | null = null;
  let loaded = false;
  let degraded = false;
  let lastProgressAt = 0;

  // convId → projectId。`searchIndex` 表按 schema 不存 projectId，
  // 因此这份映射在内存里维护，只用于检索时的项目过滤与文档字段。
  const projectIds = new Map<string, string>();

  async function refreshProjectIds(): Promise<void> {
    const conversations = await deps.db.conversation.toArray();
    projectIds.clear();
    for (const conversation of conversations) {
      projectIds.set(conversation.id, conversation.projectId ?? '');
    }
  }

  function toDocument(row: SearchIndexRecord): SearchDocument {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      convId: row.convId,
      messageId: row.messageId,
      projectId: projectIds.get(row.convId) ?? '',
    };
  }

  function isFullTextEnabled(): boolean {
    return deps.flags.fullTextSearchEnabled;
  }

  /** 只在需要时构造引擎；失败一次后固定降级，避免每次搜索都重试。 */
  function ensureEngine(): CoreResult<SearchEngine | null> {
    if (!isFullTextEnabled()) return ok(null);
    if (engine !== null) return ok(engine);
    if (degraded) return ok(null);

    try {
      engine = engineFactory();
      return ok(engine);
    } catch (cause) {
      degraded = true;
      return { ok: false, error: toCoreError(cause, 'INDEX_INIT_FAILED', true) };
    }
  }

  async function maxUpdatedAt(): Promise<number | null> {
    const latest = await deps.db.conversation.orderBy('updatedAt').last();
    return latest === undefined ? null : latest.updatedAt;
  }

  /** 引擎 + 文档就绪：优先快照，失效则重建。 */
  async function ensureReady(): Promise<CoreResult<SearchEngine | null>> {
    if (!isFullTextEnabled()) return ok(null);
    if (loaded && engine !== null) return ok(engine);
    if (degraded) return ok(null);

    const restored = await tryRestoreFromSnapshot();
    if (!restored.ok) return ok(null);
    if (restored.data !== null) return restored;

    const rebuilt = await rebuild();
    if (!rebuilt.ok) return rebuilt;
    return ok(engine);
  }

  /** 快照路径：校验 → loadJSON → 增量补齐。任一步失败都返回 ok(null) 让上层重建。 */
  async function tryRestoreFromSnapshot(): Promise<CoreResult<SearchEngine | null>> {
    const snapshot = await snapshots.read();
    if (!snapshot.ok) return ok(null);

    const record = snapshot.data;
    if (record === undefined) return ok(null);

    const validation = validateSnapshot(record, {
      dbVersion: DB_VERSION,
      minisearchVersion: MINISEARCH_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      maxUpdatedAt: await maxUpdatedAt(),
      now: now(),
    });

    if (!validation.usable) {
      await snapshots.remove();
      return ok(null);
    }

    // 快照只记录「当时索引了多少行」。同步会增量写 searchIndex 行但不刷新快照，
    // 行数对不上说明索引内容比快照新，必须重建，否则搜索会缺条目。
    const indexedRows = await deps.db.searchIndex.count();
    if (indexedRows !== record.docCount) {
      await snapshots.remove();
      return ok(null);
    }

    const json = record.json;
    const builtAt = record.builtAt;
    // 内存：json / record 都是局部变量，loadJSON 返回后即出栈释放，
    // 不在闭包里长期持有 16 MiB 的字符串（见设计说明 §7）。

    let restored: SearchEngine;
    try {
      restored = engineLoader(json);
    } catch {
      await snapshots.remove();
      return ok(null);
    }

    engine = restored;
    loaded = true;
    await refreshProjectIds();
    await applyIncremental(builtAt);
    return ok(engine);
  }

  /** 启动增量：只补 `updatedAt > builtAt` 的会话；失败则不推进快照。 */
  async function applyIncremental(builtAt: number): Promise<void> {
    if (engine === null) return;

    try {
      const changed = await deps.db.conversation.where('updatedAt').above(builtAt).primaryKeys();
      if (changed.length === 0) return;

      for (const key of changed) {
        const applied = await upsertInternal(String(key));
        if (!applied) return;
      }
      await writeSnapshot();
    } catch {
      // 增量失败不阻塞搜索：旧快照仍然可用，下次启动会重试。
    }
  }

  async function writeSnapshot(): Promise<void> {
    if (engine === null) return;

    try {
      const json = engine.serialize();
      const docCount = await deps.db.searchIndex.count();
      await snapshots.write({
        id: SNAPSHOT_ID,
        json,
        builtAt: now(),
        docCount,
        schemaVersion: DB_VERSION,
        minisearchVersion: MINISEARCH_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
      });
    } catch {
      // 快照写失败不影响业务：下次启动重建即可。
    }
  }

  async function reportProgress(
    phase: IndexProgressPhase,
    processed: number,
    total: number,
    force = false,
  ): Promise<void> {
    if (deps.progress === undefined) return;

    const timestamp = now();
    const due =
      force || processed >= total || timestamp - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS;
    if (!due) return;

    lastProgressAt = timestamp;
    // 每次写入都刷新 updatedAt；写入失败忽略，不阻塞构建。
    await deps.progress.write({ phase, processed, total, updatedAt: timestamp });
  }

  async function rebuild(): Promise<CoreResult<void>> {
    const gate = ensureEngine();
    if (!gate.ok) return gate;
    const current = gate.data;

    const lock = await acquireRebuildLock();
    if (!lock.ok) return lock;

    try {
      // 内存优化：先释放旧引擎引用，避免同时持有两份索引。
      engine = null;
      loaded = false;

      const conversations = await deps.db.conversation.toArray();
      const total = conversations.length;
      await reportProgress('building', 0, total, true);

      const messages = await deps.db.message.toArray();
      const byConversation = groupMessages(messages);

      const rows: SearchIndexRecord[] = [];
      let processed = 0;
      for (const batch of chunk(conversations, BATCH_SIZE)) {
        for (const conversation of batch) {
          rows.push(...buildRows(conversation, byConversation.get(conversation.id) ?? []));
        }
        processed += batch.length;
        await reportProgress('building', processed, total);
      }

      await writeRows(deps, rows);
      await refreshProjectIds();

      if (current !== null) {
        const fresh = engineFactory();
        fresh.addAll(rows.map(toDocument));
        engine = fresh;
        loaded = true;
      }

      await reportProgress('done', total, total, true);
      await writeSnapshot();
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    } finally {
      await lock.data.release();
    }
  }

  async function acquireRebuildLock(): Promise<CoreResult<RebuildLockHandle>> {
    const lock: StorageLockPort | undefined = deps.lock;
    if (lock === undefined) return ok({ release: async () => undefined });

    const owner = globalThis.crypto.randomUUID();
    const acquired = await lock.acquire(owner);
    if (!acquired.ok) return acquired;
    if (!acquired.data) {
      return {
        ok: false,
        error: {
          code: 'INDEX_IN_PROGRESS',
          message: '索引正在其他标签页建立（deck.search.lock），请稍后重试',
          retryable: true,
        },
      };
    }
    return ok({ release: async () => void (await lock.release(owner)) });
  }

  async function upsertConversation(convId: string): Promise<CoreResult<void>> {
    const ready = await ensureReady();
    if (!ready.ok) return ready;

    try {
      const applied = await upsertInternal(convId);
      if (!applied) return err('NOT_FOUND', `会话不存在: ${convId}`);
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  /** 增量更新单个会话（不写快照，快照由 rebuild / 启动增量统一刷新）。 */
  async function upsertInternal(convId: string): Promise<boolean> {
    const conversation = await deps.db.conversation.get(convId);
    if (conversation === undefined) return false;

    const messages = await deps.db.message.where('convId').equals(convId).toArray();
    const rows = buildRows(conversation, messages);
    const oldIds = await deps.db.searchIndex.where('convId').equals(convId).primaryKeys();

    await deps.db.transaction('rw', deps.db.searchIndex, async () => {
      await deps.db.searchIndex.where('convId').equals(convId).delete();
      if (rows.length > 0) await deps.db.searchIndex.bulkPut(rows);
    });

    if (engine !== null) {
      projectIds.set(convId, conversation.projectId ?? '');
      for (const id of oldIds) engine.discard(String(id));
      engine.addAll(rows.map(toDocument));
    }
    return true;
  }

  async function removeConversation(convId: string): Promise<CoreResult<void>> {
    const ready = await ensureReady();
    const current = ready.ok ? ready.data : null;

    try {
      const oldIds = await deps.db.searchIndex.where('convId').equals(convId).primaryKeys();
      await deps.db.searchIndex.where('convId').equals(convId).delete();

      if (current !== null) {
        for (const id of oldIds) current.discard(String(id));
      }
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function search(
    query: string,
    options: SearchOptions = {},
  ): Promise<CoreResult<SearchHit[]>> {
    const trimmed = query.trim();
    if (trimmed === '') return ok([]);

    const ready = await ensureReady();
    const current = ready.ok ? ready.data : null;
    // 引擎不可用（flag 关闭 / 初始化失败 / 别的标签页在建索引）→ 退回标题搜索。
    if (current === null) return titleSearch(deps, trimmed, options);

    try {
      const limit = resolveLimit(options);
      const filter =
        options.projectId === undefined
          ? undefined
          : (document: SearchDocument): boolean => document.projectId === String(options.projectId);

      const outcomes = current.search(trimmed, { limit, filter });
      const rows = await deps.db.searchIndex.bulkGet(outcomes.map((outcome) => outcome.id));

      const hits: SearchHit[] = [];
      outcomes.forEach((outcome: SearchOutcome, index: number) => {
        const row = rows[index];
        if (row === undefined) return;
        hits.push({
          convId: row.convId,
          ...(row.messageId === '' ? {} : { messageId: row.messageId }),
          title: row.title,
          snippet: buildSnippet(row.body, row.title, trimmed),
          score: outcome.score,
        });
      });

      return ok(hits);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
    }
  }

  return { rebuild, upsertConversation, removeConversation, search };
}

async function writeRows(deps: SearchIndexDeps, rows: readonly SearchIndexRecord[]): Promise<void> {
  await deps.db.transaction('rw', deps.db.searchIndex, async () => {
    await deps.db.searchIndex.clear();
    if (rows.length > 0) await deps.db.searchIndex.bulkPut(rows);
  });
}

function groupMessages(messages: readonly MessageRecord[]): Map<string, MessageRecord[]> {
  const byConversation = new Map<string, MessageRecord[]>();
  for (const message of messages) {
    const bucket = byConversation.get(message.convId);
    if (bucket === undefined) byConversation.set(message.convId, [message]);
    else bucket.push(message);
  }
  return byConversation;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** 标题搜索：全文检索不可用时的降级路径（只在 conversation 表上做子串匹配）。 */
async function titleSearch(
  deps: SearchIndexDeps,
  query: string,
  options: SearchOptions,
): Promise<CoreResult<SearchHit[]>> {
  try {
    const limit = resolveLimit(options);
    const candidates =
      options.projectId === undefined
        ? await deps.db.conversation.toArray()
        : await deps.db.conversation.where('projectId').equals(options.projectId).toArray();

    const needle = query.toLowerCase();
    const hits = candidates
      .filter((conversation) => conversation.title.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((conversation) => ({
        convId: conversation.id,
        title: conversation.title,
        snippet: conversation.title,
        score: 1,
      }));

    return ok(hits);
  } catch (cause) {
    return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
  }
}

/** 每条消息一行；0 消息会话补一行会话级文档，保证标题可检索。 */
function buildRows(
  conversation: ConversationRecord,
  messages: readonly MessageRecord[],
): SearchIndexRecord[] {
  if (messages.length === 0) {
    return [
      {
        id: toSearchIndexKey(conversation.id),
        convId: conversation.id,
        messageId: '',
        title: conversation.title,
        body: '',
        // v2：不再写真实分词结果（MiniSearch 内部自行分词，该字段无读取方）。
        tokens: [],
      },
    ];
  }

  return messages.map((message) => {
    const body =
      message.thinking === undefined || message.thinking === ''
        ? message.content
        : `${message.content}\n${message.thinking}`;
    return {
      id: message.id,
      convId: conversation.id,
      messageId: message.id,
      title: conversation.title,
      body,
      tokens: [],
    };
  });
}

function resolveLimit(options: SearchOptions): number {
  const limit = options.limit ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, 100));
}

function buildSnippet(body: string, title: string, query: string): string {
  const text = body === '' ? title : body;
  const lowered = text.toLowerCase();

  let position = -1;
  for (const token of tokenizeText(query)) {
    const found = lowered.indexOf(token);
    if (found >= 0) {
      position = found;
      break;
    }
  }
  if (position < 0) return truncate(text);

  const start = Math.max(0, position - SNIPPET_LEFT_CONTEXT);
  const end = Math.min(text.length, position + SNIPPET_RIGHT_CONTEXT);
  const sliced = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return truncate(`${start > 0 ? '…' : ''}${sliced}${end < text.length ? '…' : ''}`);
}

function truncate(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text;
  return `${text.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

interface RebuildLockHandle {
  release: () => Promise<void>;
}

interface MiniSearchResultLike {
  id: string | number;
  score: number;
  convId?: unknown;
  messageId?: unknown;
  title?: unknown;
  projectId?: unknown;
}

function miniSearchOptions(tokenize: (text: string) => string[]) {
  return {
    fields: ['title', 'body'],
    storeFields: ['convId', 'messageId', 'title', 'projectId'],
    tokenize: (text: string) => tokenize(text),
    // combineWith: 'AND' —— 中文分词下要求所有词都命中，避免「旧关键词甲」把只共享
    // 「关键词」的无关文档也召回；标题加权 2 倍。
    searchOptions: { boost: { title: 2 }, prefix: true, combineWith: 'AND' as const },
  };
}

/** MiniSearch 适配层：把第三方库隔离在这里，业务代码只依赖 `SearchEngine` 端口。 */
export function createMiniSearchEngine(
  tokenize: (text: string) => string[] = createTokenizer(),
): SearchEngine {
  const mini = new MiniSearch<SearchDocument>(miniSearchOptions(tokenize));
  return wrapEngine(mini);
}

/** 从快照 JSON 恢复引擎（阶段 5.5 启动快路径）。 */
export function loadMiniSearchEngine(
  json: string,
  tokenize: (text: string) => string[] = createTokenizer(),
): SearchEngine {
  const mini = MiniSearch.loadJSON<SearchDocument>(json, miniSearchOptions(tokenize));
  return wrapEngine(mini);
}

function wrapEngine(mini: MiniSearch<SearchDocument>): SearchEngine {
  return {
    addAll(docs) {
      for (const document of docs) {
        if (mini.has(document.id)) mini.discard(document.id);
      }
      mini.addAll([...docs]);
    },

    discard(id) {
      if (mini.has(id)) mini.discard(id);
    },

    serialize() {
      return JSON.stringify(mini.toJSON());
    },

    search(query, options) {
      const filter =
        options.filter === undefined
          ? undefined
          : (result: MiniSearchResultLike): boolean =>
              options.filter?.(toFilterDocument(result)) ?? true;

      const results = mini.search(query, {
        ...(filter === undefined ? {} : { filter }),
      }) as unknown as MiniSearchResultLike[];

      // MiniSearch 的 search() 本身没有 limit 选项，这里显式截断。
      return results
        .slice(0, options.limit)
        .map((result) => ({ id: String(result.id), score: result.score }));
    },
  };
}

function toFilterDocument(result: MiniSearchResultLike): SearchDocument {
  return {
    id: String(result.id),
    title: String(result.title ?? ''),
    body: '',
    convId: String(result.convId ?? ''),
    messageId: String(result.messageId ?? ''),
    projectId: String(result.projectId ?? ''),
  };
}
