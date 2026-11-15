import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeckDatabase } from '@/core/db';
import type { ProjectStore } from '@/core/project/types';
import type { SearchIndex } from '@/core/search/types';
import type { IndexProgressPort } from '@/core/search/progress';
import type { ConversationSync } from '@/core/sync/types';
import { defaultFlagSnapshot } from '@/shared/feature-flags';
import { err, ok } from '@/shared/result';

import { resetDeckServices, setBootstrapError, setDeckServices } from '@/ui/services/deck-services';
import { describeCoreError, useSidebarStore } from '@/ui/stores/sidebar';

const NOW = 1_800_000_000_000;

interface Fakes {
  projects: {
    listTree: ReturnType<typeof vi.fn>;
    listConversations: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn>;
    renameProject: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
    assignConversation: ReturnType<typeof vi.fn>;
  };
  search: { search: ReturnType<typeof vi.fn>; upsertConversation: ReturnType<typeof vi.fn> };
  progress: { read: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
}

function installServices(overrides: { sync?: ConversationSync | null } = {}): Fakes {
  const projects: Fakes['projects'] = {
    listTree: vi.fn(async () =>
      ok({
        projects: [{ id: 'p1', name: '项目一', conversationCount: 2 }],
        uncategorizedCount: 3,
      }),
    ),
    listConversations: vi.fn(async () => ok([])),
    createProject: vi.fn(async (input: { name: string }) =>
      ok({ id: 'p-new', name: input.name, fileRefs: [], createdAt: NOW, updatedAt: NOW }),
    ),
    renameProject: vi.fn(async () => ok(undefined)),
    deleteProject: vi.fn(async () => ok({ affectedConvIds: ['c1', 'c2'] })),
    assignConversation: vi.fn(async () => ok(undefined)),
  };
  const search: Fakes['search'] = {
    search: vi.fn(async () => ok([])),
    upsertConversation: vi.fn(async () => ok(undefined)),
  };
  const progress: Fakes['progress'] = {
    read: vi.fn(async () => ok({ phase: 'done', processed: 5, total: 5, updatedAt: NOW })),
  };
  const close = vi.fn();

  setDeckServices({
    db: {} as unknown as DeckDatabase,
    flags: defaultFlagSnapshot(),
    projects: projects as unknown as ProjectStore,
    search: search as unknown as SearchIndex,
    progress: progress as unknown as IndexProgressPort,
    sync: overrides.sync ?? null,
    close,
  });

  return { projects, search, progress, close };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetDeckServices();
});

describe('init()', () => {
  it('成功时拉取项目树、会话与进度', async () => {
    const fakes = installServices();
    const store = useSidebarStore();

    await store.init();

    expect(store.status).toBe('ready');
    expect(store.projects).toHaveLength(1);
    expect(store.uncategorizedCount).toBe(3);
    expect(store.progress).toMatchObject({ phase: 'done', processed: 5, total: 5 });
    expect(fakes.projects.listConversations).toHaveBeenCalledWith(null);
  });

  it('没有可用服务时进入错误态并显示引导文案', async () => {
    setBootstrapError('数据库打开失败');
    const store = useSidebarStore();

    await store.init();

    expect(store.status).toBe('error');
    expect(store.errorMessage).toBe('数据库打开失败');
  });

  it('依赖返回错误时映射成用户可读文案', async () => {
    const fakes = installServices();
    fakes.projects.listTree.mockResolvedValueOnce(err('DB_READ_FAILED', 'boom'));
    const store = useSidebarStore();

    await store.init();

    expect(store.errorMessage).toBe('读取本地数据失败，请重试');
  });

  it('没有 sync 服务时 syncAvailable 为 false', async () => {
    installServices();
    const store = useSidebarStore();

    await store.init();

    expect(store.syncAvailable).toBe(false);
  });
});

describe('项目操作', () => {
  it('selectProject 切换后拉取该项目会话', async () => {
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();

    await store.selectProject('p1');

    expect(store.selectedProjectId).toBe('p1');
    expect(fakes.projects.listConversations).toHaveBeenLastCalledWith('p1');
  });

  it('createProject 成功后刷新树并选中新项目', async () => {
    const fakes = installServices();
    fakes.projects.createProject.mockResolvedValueOnce(
      ok({ id: 'p2', name: '新项目', fileRefs: [], createdAt: NOW, updatedAt: NOW }),
    );
    const store = useSidebarStore();
    await store.init();

    const created = await store.createProject('新项目');

    expect(created).toBe(true);
    expect(store.selectedProjectId).toBe('p2');
    expect(fakes.projects.listTree).toHaveBeenCalledTimes(2);
  });

  it('createProject 失败返回 false 并给出错误文案', async () => {
    const fakes = installServices();
    fakes.projects.createProject.mockResolvedValueOnce(err('INVALID_ARGUMENT', '名字太长'));
    const store = useSidebarStore();
    await store.init();

    const created = await store.createProject('');

    expect(created).toBe(false);
    expect(store.errorMessage).toBe('输入不合法，请检查项目名');
  });

  it('renameProject 成功与失败分别返回 true/false', async () => {
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();

    expect(await store.renameProject('p1', '新名字')).toBe(true);
    fakes.projects.renameProject.mockResolvedValueOnce(err('NOT_FOUND', '没了'));
    expect(await store.renameProject('p1', '新名字')).toBe(false);
    expect(store.errorMessage).toBe('目标不存在，可能已被删除');
  });

  it('deleteProject 后刷新检索并重置选中项', async () => {
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();
    await store.selectProject('p1');

    const deleted = await store.deleteProject('p1');

    expect(deleted).toBe(true);
    expect(fakes.search.upsertConversation).toHaveBeenCalledTimes(2);
    expect(store.selectedProjectId).toBeNull();
  });

  it('assignConversation 后刷新检索索引与列表', async () => {
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();

    const assigned = await store.assignConversation('c1', 'p1');

    expect(assigned).toBe(true);
    expect(fakes.projects.assignConversation).toHaveBeenCalledWith('c1', 'p1');
    expect(fakes.search.upsertConversation).toHaveBeenCalledWith('c1');
  });
});

describe('search()', () => {
  it('输入后 200ms 才发起查询（防抖）', async () => {
    vi.useFakeTimers();
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();

    store.scheduleSearch('游标');
    expect(fakes.search.search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(199);
    expect(fakes.search.search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.search.search).toHaveBeenCalledWith('游标', { limit: 20 });
  });

  it('清空输入立即清空结果，不发起查询', async () => {
    vi.useFakeTimers();
    const fakes = installServices();
    const store = useSidebarStore();
    await store.init();
    store.scheduleSearch('游标');
    await vi.advanceTimersByTimeAsync(200);

    store.scheduleSearch('   ');

    expect(store.results).toEqual([]);
    expect(fakes.search.search).toHaveBeenCalledTimes(1);
  });

  it('查询失败时清空结果并给出错误文案', async () => {
    const fakes = installServices();
    fakes.search.search.mockResolvedValueOnce(err('DB_READ_FAILED', 'boom'));
    const store = useSidebarStore();
    await store.init();

    store.scheduleSearch('游标');
    await store.runSearch();

    expect(store.results).toEqual([]);
    expect(store.errorMessage).toBe('读取本地数据失败，请重试');
  });

  it('命中后展示结果', async () => {
    const fakes = installServices();
    fakes.search.search.mockResolvedValueOnce(
      ok([{ convId: 'c1', title: '标题', snippet: '摘要', score: 1 }]),
    );
    const store = useSidebarStore();
    await store.init();

    store.scheduleSearch('游标');
    await store.runSearch();

    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.convId).toBe('c1');
  });
});

describe('复制会话 id 与折叠', () => {
  it('复制成功提示已复制并带上 id', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    installServices();
    const store = useSidebarStore();
    await store.init();

    await store.copyConversationId('c1');

    expect(writeText).toHaveBeenCalledWith('c1');
    expect(store.copiedConvId).toBe('c1');
    expect(store.searchHint).toContain('c1');
  });

  it('剪贴板不可用时提示手动复制', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    installServices();
    const store = useSidebarStore();
    await store.init();

    await store.copyConversationId('c1');

    expect(store.copiedConvId).toBeNull();
    expect(store.searchHint).toContain('请手动复制');
  });

  it('toggleCollapsed 切换折叠状态', () => {
    installServices();
    const store = useSidebarStore();

    store.toggleCollapsed();
    expect(store.collapsed).toBe(true);
    store.toggleCollapsed();
    expect(store.collapsed).toBe(false);
  });
});

describe('describeCoreError()', () => {
  it('已知错误码返回固定文案，未知码回落到 message', () => {
    expect(describeCoreError({ code: 'INDEX_IN_PROGRESS', message: 'x', retryable: true })).toBe(
      '索引正在其他标签页建立，请稍后重试',
    );
    expect(describeCoreError({ code: 'UNKNOWN', message: '原始信息', retryable: false })).toBe(
      '原始信息',
    );
  });
});
