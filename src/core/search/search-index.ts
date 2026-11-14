import MiniSearch from 'minisearch';

import type { ConversationRecord, MessageRecord, SearchIndexRecord } from '@/core/db/schema';
import { toSearchIndexKey } from '@/core/db/schema';
import { err, ok, toCoreError, type CoreResult } from '@/shared/result';

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

/**
 * 本地全文检索（任务 0001 阶段 5）。
 *
 * 边界：只从 `conversation` / `message` **读**，只向 `searchIndex` **写**；
 * 绝不修改 sync 拥有的表，两者只通过 DB 解耦。
 *
 * 降级（AGENTS.md §7）：`fullTextSearchEnabled=false` 或引擎初始化失败 → 退回标题搜索。
 */
export function createSearchIndex(deps: SearchIndexDeps): SearchIndex {
  const engineFactory = deps.engineFactory ?? (() => createMiniSearchEngine());
  let engine: SearchEngine | null = null;
  let loaded = false;
  let degraded = false;

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

  /** 引擎 + 文档就绪（必要时从 `searchIndex` 表加载，空表则按需重建）。 */
  async function ensureReady(): Promise<CoreResult<SearchEngine | null>> {
    const created = ensureEngine();
    if (!created.ok) return created;

    const current = created.data;
    if (current === null) return ok(null);
    if (loaded) return ok(current);

    try {
      let rows = await deps.db.searchIndex.toArray();
      if (rows.length === 0) {
        const rebuilt = await rebuild();
        if (!rebuilt.ok) return rebuilt;
        rows = await deps.db.searchIndex.toArray();
      }

      await refreshProjectIds();
      current.addAll(rows.map(toDocument));
      loaded = true;
      return ok(current);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_READ_FAILED', true) };
    }
  }

  async function rebuild(): Promise<CoreResult<void>> {
    // 重建意味着丢弃旧引擎，确保不会残留已删除文档。
    engine = null;
    loaded = false;

    const created = ensureEngine();
    if (!created.ok) return created;
    const current = created.data;

    try {
      const rows = await collectRows(deps);
      await deps.db.transaction('rw', deps.db.searchIndex, async () => {
        await deps.db.searchIndex.clear();
        if (rows.length > 0) await deps.db.searchIndex.bulkPut(rows);
      });

      if (current !== null) {
        await refreshProjectIds();
        current.addAll(rows.map(toDocument));
        loaded = true;
      }
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
  }

  async function upsertConversation(convId: string): Promise<CoreResult<void>> {
    const ready = await ensureReady();
    if (!ready.ok) return ready;

    try {
      const conversation = await deps.db.conversation.get(convId);
      if (conversation === undefined) {
        return err('NOT_FOUND', `会话不存在: ${convId}`);
      }

      const messages = await deps.db.message.where('convId').equals(convId).toArray();
      const rows = buildRows(conversation, messages);
      const oldIds = await deps.db.searchIndex.where('convId').equals(convId).primaryKeys();

      await deps.db.transaction('rw', deps.db.searchIndex, async () => {
        await deps.db.searchIndex.where('convId').equals(convId).delete();
        if (rows.length > 0) await deps.db.searchIndex.bulkPut(rows);
      });

      const current = ready.data;
      if (current !== null) {
        projectIds.set(convId, conversation.projectId ?? '');
        for (const id of oldIds) current.discard(String(id));
        current.addAll(rows.map(toDocument));
      }
      return ok(undefined);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'DB_WRITE_FAILED', true) };
    }
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
    // 引擎不可用（flag 关闭或初始化失败）→ 退回标题搜索。
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

async function collectRows(deps: SearchIndexDeps): Promise<SearchIndexRecord[]> {
  const conversations = await deps.db.conversation.toArray();
  const messages = await deps.db.message.toArray();

  const byConversation = new Map<string, MessageRecord[]>();
  for (const message of messages) {
    const bucket = byConversation.get(message.convId);
    if (bucket === undefined) byConversation.set(message.convId, [message]);
    else bucket.push(message);
  }

  const rows: SearchIndexRecord[] = [];
  for (const conversation of conversations) {
    rows.push(...buildRows(conversation, byConversation.get(conversation.id) ?? []));
  }
  return rows;
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
        tokens: tokenizeText(conversation.title),
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
      tokens: tokenizeText(`${conversation.title} ${body}`),
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

interface MiniSearchResultLike {
  id: string | number;
  score: number;
  convId?: unknown;
  messageId?: unknown;
  title?: unknown;
  projectId?: unknown;
}

/** MiniSearch 适配层：把第三方库隔离在这里，业务代码只依赖 `SearchEngine` 端口。 */
export function createMiniSearchEngine(
  tokenize: (text: string) => string[] = createTokenizer(),
): SearchEngine {
  const mini = new MiniSearch<SearchDocument>({
    fields: ['title', 'body'],
    storeFields: ['convId', 'messageId', 'title', 'projectId'],
    tokenize: (text: string) => tokenize(text),
    // combineWith: 'AND' —— 中文分词下要求所有词都命中，避免「旧关键词甲」把只共享
    // 「关键词」的无关文档也召回；标题加权 2 倍。
    searchOptions: { boost: { title: 2 }, prefix: true, combineWith: 'AND' },
  });

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
