import { defineStore } from 'pinia';
import { ref } from 'vue';

import type { ConversationRecord } from '@/core/db/schema';
import type { ProjectNode } from '@/core/project/types';
import type { IndexProgress } from '@/core/search/progress';
import type { SearchHit } from '@/core/search/types';
import type { CoreError } from '@/shared/result';

import { getBootstrapError, getDeckServices, hasDeckServices } from '../services/deck-services';

const SEARCH_DEBOUNCE_MS = 200;

export type SidebarStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 侧边栏视图状态。只调用 core 暴露的 API，不直接接触 IndexedDB。
 * 错误统一映射成用户可读文案（core 的 CoreError 不直接展示给用户）。
 */
export const useSidebarStore = defineStore('deck-sidebar', () => {
  const status = ref<SidebarStatus>('idle');
  const errorMessage = ref<string | null>(null);
  const collapsed = ref(false);

  const projects = ref<ProjectNode[]>([]);
  const uncategorizedCount = ref(0);
  const selectedProjectId = ref<string | null>(null);
  const conversations = ref<ConversationRecord[]>([]);

  const query = ref('');
  const results = ref<SearchHit[]>([]);
  const searching = ref(false);
  const searchHint = ref<string | null>(null);

  const progress = ref<IndexProgress | null>(null);
  const fullTextEnabled = ref(true);
  const syncAvailable = ref(false);
  const syncing = ref(false);
  const syncMessage = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function init(): Promise<void> {
    status.value = 'loading';
    errorMessage.value = null;

    if (!hasDeckServices()) {
      status.value = 'error';
      errorMessage.value = getBootstrapError() ?? '本地数据不可用，请刷新页面重试';
      return;
    }

    try {
      const services = getDeckServices();
      fullTextEnabled.value = services.flags.fullTextSearchEnabled;
      syncAvailable.value = services.sync !== null;
      await refreshTree();
      await refreshConversations();
      await refreshProgress();
      status.value = 'ready';
    } catch (cause) {
      status.value = 'error';
      errorMessage.value = describeCause(cause);
    }
  }

  /** 面板上的「刷新」：重新拉取项目树、会话与索引进度（同步完成/外部写入后使用）。 */
  async function refreshAll(): Promise<void> {
    if (!hasDeckServices()) return;
    await refreshTree();
    await refreshConversations();
    await refreshProgress();
  }

  async function refreshTree(): Promise<void> {
    const result = getDeckServices().projects.listTree();
    const tree = await result;
    if (!tree.ok) {
      setError(tree.error);
      return;
    }
    projects.value = tree.data.projects;
    uncategorizedCount.value = tree.data.uncategorizedCount;
  }

  async function refreshConversations(): Promise<void> {
    const result = await getDeckServices().projects.listConversations(selectedProjectId.value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    conversations.value = result.data;
  }

  async function selectProject(projectId: string | null): Promise<void> {
    selectedProjectId.value = projectId;
    await refreshConversations();
  }

  async function createProject(name: string): Promise<boolean> {
    const result = await getDeckServices().projects.createProject({ name });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    await refreshTree();
    selectedProjectId.value = result.data.id;
    await refreshConversations();
    return true;
  }

  async function renameProject(projectId: string, name: string): Promise<boolean> {
    const result = await getDeckServices().projects.renameProject(projectId, name);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    await refreshTree();
    return true;
  }

  async function deleteProject(projectId: string): Promise<boolean> {
    const result = await getDeckServices().projects.deleteProject(projectId);
    if (!result.ok) {
      setError(result.error);
      return false;
    }

    // 项目删除后会话回落未分类；交给检索层刷新（失败不阻塞 UI）。
    for (const convId of result.data.affectedConvIds) {
      await getDeckServices().search.upsertConversation(convId);
    }

    if (selectedProjectId.value === projectId) selectedProjectId.value = null;
    await refreshTree();
    await refreshConversations();
    return true;
  }

  async function assignConversation(convId: string, projectId: string | null): Promise<boolean> {
    const result = await getDeckServices().projects.assignConversation(convId, projectId);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    await getDeckServices().search.upsertConversation(convId);
    await refreshTree();
    await refreshConversations();
    return true;
  }

  /** 供组件做 200ms 防抖；返回值用于判断本次是否已经发起查询。 */
  function scheduleSearch(nextQuery: string): void {
    query.value = nextQuery;
    if (debounceTimer !== null) clearTimeout(debounceTimer);

    if (nextQuery.trim() === '') {
      results.value = [];
      searching.value = false;
      return;
    }

    debounceTimer = setTimeout(() => {
      void runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(): Promise<void> {
    // 面板已卸载/服务已释放时不再查询，避免防抖定时器触发未捕获异常。
    if (!hasDeckServices()) return;

    const trimmed = query.value.trim();
    if (trimmed === '') {
      results.value = [];
      return;
    }

    searching.value = true;
    const result = await getDeckServices().search.search(trimmed, { limit: 20 });
    searching.value = false;

    if (!result.ok) {
      results.value = [];
      setError(result.error);
      return;
    }

    results.value = result.data;
    searchHint.value = fullTextEnabled.value ? null : '全文检索已关闭，当前仅搜索标题';
  }

  /** 只读同步：从页面 IndexedDB 缓存同步到本地库，成功后刷新面板。 */
  async function syncNow(): Promise<void> {
    if (!hasDeckServices()) return;
    const services = getDeckServices();
    if (services.sync === null) {
      syncMessage.value = '同步不可用：等待页面适配';
      return;
    }

    syncing.value = true;
    syncMessage.value = null;
    const result = await services.sync.syncAll();
    syncing.value = false;

    if (!result.ok) {
      setError(result.error);
      syncMessage.value = describeCoreError(result.error);
      return;
    }

    const { synced, failed, cancelled, skipped, total, syncedRemoteIds } = result.data;

    // 同步只写业务表；检索索引必须由编排层按会话增量刷新，
    // 否则「同步完再搜」会一直为空（快照的 updatedAt 增量覆盖不到旧会话）。
    let indexFailed = false;
    for (const convId of syncedRemoteIds) {
      const indexed = await services.search.upsertConversation(convId);
      if (!indexed.ok) {
        indexFailed = true;
        break;
      }
    }
    if (indexFailed) await services.search.rebuild();

    if (cancelled > 0) {
      syncMessage.value = `同步已取消（已处理 ${synced + failed.length} / ${total - skipped}）`;
    } else if (failed.length > 0) {
      syncMessage.value = `同步完成（${failed.length} 条失败）`;
    } else {
      syncMessage.value = `同步完成（${synced} 条）`;
    }
    await refreshAll();
  }

  async function refreshProgress(): Promise<void> {
    if (!hasDeckServices()) return;

    const result = await getDeckServices().progress.read();
    progress.value = result.ok ? result.data : null;
    if (progress.value?.phase === 'building') {
      searchHint.value = '全文索引建立中，当前仅搜索标题';
    }
  }

  /** 命中跳转第一版：直接打开会话 URL（消息级定位待 selectors）。 */
  async function openConversation(convId: string): Promise<void> {
    const url = conversationUrl(convId);
    const target = globalThis.window;

    if (target === undefined || typeof target.location?.assign !== 'function') {
      searchHint.value = `无法跳转，会话 id：${convId}`;
      return;
    }

    searchHint.value = '正在打开会话…';
    target.location.assign(url);
  }

  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value;
  }

  function dispose(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function setError(error: CoreError): void {
    errorMessage.value = describeCoreError(error);
  }

  return {
    status,
    errorMessage,
    collapsed,
    projects,
    uncategorizedCount,
    selectedProjectId,
    conversations,
    query,
    results,
    searching,
    searchHint,
    progress,
    fullTextEnabled,
    syncAvailable,
    syncing,
    syncMessage,
    init,
    refreshAll,
    refreshTree,
    refreshConversations,
    selectProject,
    createProject,
    renameProject,
    deleteProject,
    assignConversation,
    scheduleSearch,
    runSearch,
    syncNow,
    refreshProgress,
    openConversation,
    toggleCollapsed,
    dispose,
  };
});

/** 会话跳转 URL 规则：`/a/chat/s/<会话 id>`（2026-11-15 真实页面采集）。 */
export function conversationUrl(convId: string): string {
  return `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(convId)}`;
}

const ERROR_MESSAGES: Partial<Record<CoreError['code'], string>> = {
  DB_OPEN_FAILED: '本地数据库打开失败，同步与检索暂不可用',
  DB_READ_FAILED: '读取本地数据失败，请重试',
  DB_WRITE_FAILED: '写入本地数据失败，请重试',
  INVALID_ARGUMENT: '输入不合法，请检查项目名',
  NOT_FOUND: '目标不存在，可能已被删除',
  INDEX_INIT_FAILED: '全文索引初始化失败，已退回标题搜索',
  INDEX_IN_PROGRESS: '索引正在其他标签页建立，请稍后重试',
  SYNC_DISABLED: '只读同步已关闭',
  SYNC_IN_PROGRESS: '已有同步在进行中',
  SELECTOR_MISSING: '页面尚未适配，暂不可同步',
  SOURCE_UNAVAILABLE: '页面数据不可用，请稍后重试',
  FLAG_STORAGE_FAILED: '读取设置失败，已使用默认值',
};

export function describeCoreError(error: CoreError): string {
  return ERROR_MESSAGES[error.code] ?? error.message;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return '初始化失败，请刷新页面重试';
}
