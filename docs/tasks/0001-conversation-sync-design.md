# 设计说明：conversation-sync（任务 0001 · 阶段 4）

> 状态：**待确认**（确认后再写测试）。本文只覆盖 P0 只读同步，不含检索、注入、分叉。
> 决策依据：ADR-003（本地优先）、ADR-006（flag + 降级）、ADR-007（只读，不拦截请求）。

## 1. 范围与非目标

**做**：从 `RemoteSource` 读取会话与消息 → 规范化 → 写 Dexie（`conversation` / `message`）→ 返回 `SyncSummary`。

**不做**：请求拦截、网络请求、页面 DOM 写入、搜索索引写入、删除同步、附件内容恢复。

## 2. 模块与文件

```text
src/core/sync/
├── types.ts              # RemoteSource 端口、RemoteConversation/Message、SyncSummary、SyncStatus
└── conversation-sync.ts  # ConversationSync 实现（编排、幂等、部分失败、游标）
src/core/feature-flags/
├── storage.ts            # browser.storage.local 适配（FlagStoragePort）
└── store.ts              # createFeatureFlagStore：get/set/reset，复用 resolveFlags
src/core/driver/
└── main-world-source.ts  # MAIN world 只读占位：接口 + throw not implemented + TODO(ADR-007)
tests/fixtures/
├── generate-fixtures.ts  # 确定性生成器（seed 42，纯函数，不落盘、不入 git）
└── fixture-source.ts     # 实现 RemoteSource 的夹具，可注入指定 remoteId 失败
```

依赖方向：`conversation-sync → types + db + shared/result`；**不** import UI / Vue / driver 具体实现。`RemoteSource` 由调用方注入（content script 侧后续接 `main-world-source`）。

## 3. 契约

```ts
export interface RemoteConversationSummary {
  remoteId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number | null; // 页面不可知时给 null，不猜
}

export interface RemoteConversationDetail extends RemoteConversationSummary {
  messages: Array<{
    remoteId: string;
    role: MessageRole;
    content: string;
    thinking?: string;
    order: number;                 // 远端原值，不重排
    attachmentMeta?: AttachmentMeta[];
  }>;
}

export type SourceAvailability =
  | { ready: true }
  | { ready: false; reason: CoreErrorCode };   // 如 SELECTOR_MISSING

export interface RemoteSource {
  getAvailability(): Promise<CoreResult<SourceAvailability>>;
  listConversations(): Promise<CoreResult<RemoteConversationSummary[]>>;
  fetchConversation(remoteId: string): Promise<CoreResult<RemoteConversationDetail>>;
}

export interface SyncSummary {
  total: number;
  synced: number;
  skipped: number;
  failed: Array<{ remoteId: string; reason: string }>;   // reason = `${code}: ${message}`
}

export interface SyncStatus {
  lastSyncedAt: number | null;
  conversationCount: number;
  messageCount: number;
  selectorsReady: boolean;
}

export interface ConversationSync {
  syncAll(options?: { full?: boolean }): Promise<CoreResult<SyncSummary>>;
  syncConversation(remoteId: string): Promise<CoreResult<SyncSummary>>;
  getStatus(): Promise<CoreResult<SyncStatus>>;
}
```

## 4. 全量 vs 增量

- **首次 / 游标缺失 / 游标版本不符 → 全量**。
- **增量**：游标存 `browser.storage.local` key `deck.sync.cursor.v1`，形如
  `{ schemaVersion: 1, lastSyncedAt: number | null, lastRunAt: number | null }`。
  判定：`summary.updatedAt > lastSyncedAt` 则同步，否则计入 `skipped`。
- **游标字段（待裁决 D1）**：建议 `lastSyncedAt`（= 本轮成功写入会话的 `max(updatedAt)`，全部失败时不推进），而不是逐会话 map —— 简单、可自愈（重跑全量即可修复）。
- **强制全量**：`syncAll({ full: true })` 跳过游标判定（用户手动「重新同步」、改版修复后使用）。
- 游标只在 `synced > 0` 时推进，避免部分失败后跳过未同步项。

## 5. 幂等性

- **Conversation**：以 `remoteId`（schema 唯一索引）为身份。已存在则**保留本地 `id` / `projectId` / `tags`**（用户数据不得被同步覆盖），只更新 `title` / `createdAt` / `updatedAt`。不存在则 `id = remoteId` 新建。
- **Message**：主键 `toMessageKey(convId, remoteMessageId)`（schema 已定），用 `bulkPut` 覆盖写 → 重复同步同结果。
- **order**：照远端原值保存，**不重排、不补洞**（不连续 / 非 0 起始均为合法输入）。
- **同批重复 remoteId**：只处理第一条，其余计入 `skipped`（脏数据不导致整体失败）。
- **删除**：P0 **不做远端删除同步**，本地保留（已知限制，写入文档与 UI 说明）。
- **事务边界**：单会话一个 Dexie 事务（conversation + messages），失败只回滚该会话。

## 6. 部分失败

- `getAvailability()` 不可用 → 整体 `err(SELECTOR_MISSING)`，不读不写，UI 显示「适配中」。
- `listConversations()` 失败 → 整体 `err(SOURCE_UNAVAILABLE)`，不写库。
- 单会话 `fetchConversation()` 或写库失败 → 记入 `failed[]`，**继续下一个**；整体仍返回 `ok: true`（`failed` 非空即「部分失败」）。
- 全部会话失败 → 仍 `ok: true` + `failed.length === total`（UI 提示「同步不可用」并提供重试），游标不推进。
- `readonlySyncEnabled === false` → 立即 `err(SYNC_DISABLED)`，不碰页面与 IndexedDB。
- 新增错误码：`SYNC_DISABLED`（待裁决 D2，属 shared 契约的追加）。

## 7. 与 search-index 的边界

- **sync 只写 `conversation` / `message`，绝不写 `searchIndex`**。
- search-index 从 DB 读数据自建索引，提供 `rebuild()` / `upsertConversation()` / `removeConversation()`。
- 编排层（阶段 7 UI）在 sync 成功后调用 `search.upsertConversation(convId)`；两者通过 DB 解耦，索引损坏可 `rebuild()` 而不影响数据。
- 因此 sync 的测试不需要 search 存在，search 的测试不需要 RemoteSource。

## 8. 性能与基准

- `pnpm bench` = `vitest run --config vitest.bench.config.ts`，只跑 `tests/bench/**/*.bench.ts`，**不进 `pnpm test`**，不参与覆盖率。
- 指标自算 P50/P95/Max（N 次迭代，先 warmup 2 次），打印表格；**不做硬断言**避免 CI 抖动，只在超过任务书阈值（同步 / 搜索 300ms）时打 `WARN`。
- 阶段 4 落 `tests/bench/sync.bench.ts`（500 对话 / 5 万消息全量 + 增量）；阶段 5 落 `tests/bench/search.bench.ts`（P95 < 300ms）。
- 注意：数据落在 fake-indexeddb（纯 JS 内存实现），**数值偏保守**，需在报告中注明「非真实 IndexedDB 基准」。

## 9. 夹具与测试覆盖

`generate-fixtures.ts`：`generateFixtureData({ conversations, messagesPerConv, chineseRatio, withThinking, withAttachments, seed = 42 })`，纯函数 + mulberry32 等确定性 PRNG，**不写文件**。

正确性单测必覆盖：空对话、单条 100KB 超长消息、含 `thinking`、含 `attachmentMeta`、中英 emoji 特殊字符混合、重复标题、`remoteId` 重复插入、`order` 不连续 / 起始非 0；另有部分失败、重跑幂等、游标增量跳过、flag 关闭、选择器不可用、DB 打开失败。

## 10. 提交计划（每步单独汇报）

1. `feat(core): feature flag 持久化与开关存储`（storage + store + 测试，flag 真实可关）
2. `test(fixtures): 新增确定性夹具生成器与夹具数据源`
3. `feat(sync): 新增 RemoteSource 契约与 conversation-sync`（测试先行）
4. `chore(driver): 新增 MAIN world 只读占位`
5. `test(bench): 新增基准脚本与同步基准`

## 11. 待裁决

- **D1 游标字段**：用 `lastSyncedAt` 单值（建议）还是逐会话 `Map<remoteId, updatedAt>`？后者更精确但存储更大。
- **D2 新增错误码 `SYNC_DISABLED`**：同意追加到 `CoreErrorCode` 吗？
- **D3 `SyncSummary` 是否加 `durationMs`**：便于把性能写进交付证据，可选字段。
- **D4 `syncAll({ full })` 选项**：任务书契约无此参数，加可选参数是否可接受？
- **D5 基准落点**：`search.bench.ts` 依赖阶段 5 的检索实现，阶段 4 先落 `sync.bench.ts`，可以吗？
