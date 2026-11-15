import type { MessageRole, AttachmentMeta } from '@/core/db/schema';
import { err, ok, toCoreError, type CoreResult } from '@/shared/result';

import type {
  RemoteConversationDetail,
  RemoteConversationSummary,
  RemoteMessage,
  RemoteSource,
  SourceAvailability,
} from './types';

/**
 * 只读页面数据源：直接读 DeepSeek 网页版自己的 IndexedDB 缓存。
 *
 * 依据（2026-11-15 真实页面采集）：
 * - 库：`deepseek-chat`（v1），对象仓：`history-message`（out-of-line key）；
 * - 记录：`{ data: { chat_session, chat_messages }, key, version, ... }`；
 * - `chat_session`：`id` / `title` / `inserted_at` / `updated_at`（**秒**，浮点）；
 * - `chat_messages[]`：`message_id` / `role`（USER|ASSISTANT）/ `fragments[]`；
 *   - `fragment.type === 'REQUEST'` → 用户正文
 *   - `fragment.type === 'RESPONSE'` → 助手正文
 *   - `fragment.type === 'THINK'` → 思维链
 *   - `TOOL_SEARCH` / `TOOL_OPEN` 等工具片段忽略（不进 P0 数据模型）
 *
 * 约束（ADR-007）：只读，不写页面库、不发网络请求、不碰 token。
 * 页面结构/缓存格式属于可失效契约：失败统一返回 Result，由 UI 显示「适配中」。
 */

const DEFAULT_DB_NAME = 'deepseek-chat';
const DEFAULT_STORE_NAME = 'history-message';

const ROLE_MAP: Record<string, MessageRole> = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
};

export interface PageHistorySourceOptions {
  /** 便于测试注入；传 null 模拟不支持 IndexedDB。 */
  indexedDB?: IDBFactory | null;
  dbName?: string;
  storeName?: string;
}

interface ParsedConversation {
  summary: RemoteConversationSummary;
  messages: RemoteMessage[];
}

interface RawFragmentLike {
  type?: unknown;
  content?: unknown;
}

interface RawMessageLike {
  message_id?: unknown;
  role?: unknown;
  inserted_at?: unknown;
  fragments?: unknown;
}

interface RawRecordLike {
  key?: unknown;
  data?: {
    chat_session?: {
      id?: unknown;
      title?: unknown;
      inserted_at?: unknown;
      updated_at?: unknown;
    } | null;
    chat_messages?: unknown;
  } | null;
}

export function createPageHistorySource(options: PageHistorySourceOptions = {}): RemoteSource {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const storeName = options.storeName ?? DEFAULT_STORE_NAME;

  let cache: ParsedConversation[] | null = null;

  async function getAvailability(): Promise<CoreResult<SourceAvailability>> {
    // 每轮同步开始都重新读一次页面缓存，避免用旧数据。
    cache = null;

    if (factory === undefined || factory === null) {
      return ok({ ready: false, reason: 'SOURCE_UNAVAILABLE' });
    }

    try {
      if (typeof factory.databases === 'function') {
        const databases = await factory.databases();
        const exists = databases.some((entry) => entry.name === dbName);
        if (!exists) return ok({ ready: false, reason: 'SOURCE_UNAVAILABLE' });
      }
      return ok({ ready: true });
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'SOURCE_UNAVAILABLE', true) };
    }
  }

  async function loadAll(): Promise<CoreResult<ParsedConversation[]>> {
    if (cache !== null) return ok(cache);
    if (factory === undefined || factory === null) {
      return err('SOURCE_UNAVAILABLE', '页面不支持 IndexedDB');
    }

    try {
      const records = await readAllRecords(factory, dbName, storeName);
      const parsed: ParsedConversation[] = [];
      for (const record of records) {
        const conversation = parseRecord(record);
        if (conversation !== null) parsed.push(conversation);
      }
      parsed.sort((left, right) => right.summary.updatedAt - left.summary.updatedAt);
      cache = parsed;
      return ok(parsed);
    } catch (cause) {
      return { ok: false, error: toCoreError(cause, 'SOURCE_UNAVAILABLE', true) };
    }
  }

  async function listConversations(): Promise<CoreResult<RemoteConversationSummary[]>> {
    const loaded = await loadAll();
    if (!loaded.ok) return loaded;
    return ok(loaded.data.map((item) => item.summary));
  }

  async function fetchConversation(
    remoteId: string,
  ): Promise<CoreResult<RemoteConversationDetail>> {
    const loaded = await loadAll();
    if (!loaded.ok) return loaded;

    const found = loaded.data.find((item) => item.summary.remoteId === remoteId);
    if (found === undefined) return err('NOT_FOUND', `页面缓存中不存在会话: ${remoteId}`);

    return ok({
      ...found.summary,
      messages: found.messages.map((message) => ({ ...message })),
    });
  }

  return { getAvailability, listConversations, fetchConversation };
}

function readAllRecords(
  factory: IDBFactory,
  dbName: string,
  storeName: string,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    // 不带版本号打开：只读现有库，绝不触发建库/升级。
    const request = factory.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          reject(new Error(`页面缓存缺少对象仓: ${storeName}`));
          return;
        }
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        const getAll = store.getAll();
        getAll.onerror = () => {
          db.close();
          reject(getAll.error);
        };
        getAll.onsuccess = () => {
          db.close();
          resolve(getAll.result as unknown[]);
        };
      } catch (cause) {
        db.close();
        reject(cause);
      }
    };
  });
}

function parseRecord(record: unknown): ParsedConversation | null {
  if (typeof record !== 'object' || record === null) return null;
  const raw = record as RawRecordLike;
  const session = raw.data?.chat_session;
  if (session === undefined || session === null) return null;

  const remoteId = asString(session.id) ?? asString(raw.key);
  if (remoteId === null || remoteId === '') return null;

  const title = asString(session.title) ?? '（无标题）';
  const createdAt = toMillis(session.inserted_at);
  const updatedAt = toMillis(session.updated_at) || createdAt;
  const rawMessages = Array.isArray(raw.data?.chat_messages) ? raw.data.chat_messages : [];
  const messages = rawMessages
    .map((message, index) => parseMessage(message, index))
    .filter((message): message is RemoteMessage => message !== null);

  return {
    summary: {
      remoteId,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
    },
    messages,
  };
}

function parseMessage(value: unknown, order: number): RemoteMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as RawMessageLike;

  const remoteId = asString(raw.message_id) ?? String(order);
  const role = ROLE_MAP[asString(raw.role) ?? ''] ?? 'user';
  const fragments = Array.isArray(raw.fragments) ? raw.fragments : [];

  const request = joinFragments(fragments, 'REQUEST');
  const response = joinFragments(fragments, 'RESPONSE');
  const thinking = joinFragments(fragments, 'THINK');

  const content = role === 'user' ? request || response : response || request;
  const message: RemoteMessage = { remoteId, role, content, order };
  if (thinking !== '') message.thinking = thinking;
  return message;
}

function joinFragments(fragments: unknown[], type: string): string {
  return fragments
    .filter((fragment): fragment is RawFragmentLike => {
      return typeof fragment === 'object' && fragment !== null;
    })
    .filter((fragment) => fragment.type === type)
    .map((fragment) => asString(fragment.content) ?? '')
    .filter((content) => content !== '')
    .join('\n');
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** DeepSeek 的时间戳是「秒（浮点）」，本项目统一用毫秒；兼容已经是毫秒的异常值。 */
function toMillis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value > 1e12 ? value : value * 1000);
}

export type { AttachmentMeta };
