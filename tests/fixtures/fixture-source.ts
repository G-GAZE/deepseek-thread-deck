import type { RemoteConversationDetail, RemoteSource, SourceAvailability } from '@/core/sync/types';
import type { CoreErrorCode, CoreResult } from '@/shared/result';
import { err, ok } from '@/shared/result';

import type { FixtureConversation } from './generate-fixtures';

export interface FixtureSourceOptions {
  conversations: FixtureConversation[];
  /** 可用性为 false 时的错误码 */
  unavailableReason?: CoreErrorCode;
  /** listConversations 直接失败 */
  failList?: CoreErrorCode;
  /** 指定 remoteId 的 fetchConversation 失败 */
  failFetch?: Record<string, CoreErrorCode>;
  /** 每次 fetchConversation 前的钩子，用于测试中途取消 */
  onFetch?: (remoteId: string) => void;
}

export interface FixtureSource extends RemoteSource {
  readonly fetchCalls: string[];
  readonly listCalls: () => number;
  setUnavailable(reason: CoreErrorCode | null): void;
  setFailList(reason: CoreErrorCode | null): void;
  failFetchFor(remoteId: string, reason: CoreErrorCode | null): void;
  updateConversation(
    remoteId: string,
    patch: Partial<Pick<FixtureConversation, 'title' | 'updatedAt'>>,
  ): void;
  replaceConversations(conversations: FixtureConversation[]): void;
}

/**
 * 实现 `RemoteSource` 的夹具数据源。
 * 支持按 remoteId 注入失败，用于覆盖「部分失败」与「失败不推进游标」。
 */
export function createFixtureSource(options: FixtureSourceOptions): FixtureSource {
  let conversations = [...options.conversations];
  let unavailableReason = options.unavailableReason ?? null;
  let failList = options.failList ?? null;
  const failFetch = new Map<string, CoreErrorCode>(Object.entries(options.failFetch ?? {}));
  const fetchCalls: string[] = [];
  let listCalls = 0;

  return {
    fetchCalls,
    listCalls: () => listCalls,

    setUnavailable(reason: CoreErrorCode | null): void {
      unavailableReason = reason;
    },

    setFailList(reason: CoreErrorCode | null): void {
      failList = reason;
    },

    failFetchFor(remoteId: string, reason: CoreErrorCode | null): void {
      if (reason === null) failFetch.delete(remoteId);
      else failFetch.set(remoteId, reason);
    },

    updateConversation(remoteId, patch): void {
      conversations = conversations.map((conversation) =>
        conversation.remoteId === remoteId ? { ...conversation, ...patch } : conversation,
      );
    },

    replaceConversations(next): void {
      conversations = [...next];
    },

    async getAvailability(): Promise<CoreResult<SourceAvailability>> {
      if (unavailableReason !== null) {
        return ok({ ready: false, reason: unavailableReason });
      }
      return ok({ ready: true });
    },

    async listConversations(): Promise<CoreResult<RemoteConversationDetail[]>> {
      listCalls += 1;
      if (failList !== null) {
        return err(failList, '模拟 listConversations 失败');
      }
      return ok(conversations.map((conversation) => structuredClone(conversation)));
    },

    async fetchConversation(remoteId: string): Promise<CoreResult<RemoteConversationDetail>> {
      fetchCalls.push(remoteId);
      options.onFetch?.(remoteId);
      const failure = failFetch.get(remoteId);
      if (failure !== undefined) {
        return err(failure, `模拟 ${remoteId} 读取失败`);
      }
      const found = conversations.find((conversation) => conversation.remoteId === remoteId);
      if (found === undefined) {
        return err('NOT_FOUND', `夹具中不存在 ${remoteId}`);
      }
      return ok(structuredClone(found));
    },
  };
}
