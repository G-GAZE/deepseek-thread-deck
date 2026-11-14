# 设计说明：conversation-sync（任务 0001 · 阶段 4）

> 状态：**已确认**（D1–D5 已裁决，2026-11-14）。本文只覆盖 P0 只读同步，不含检索、注入、分叉。
> 决策依据：ADR-003（本地优先）、ADR-006（flag + 降级）、ADR-007（只读，不拦截请求）。

## 1. 范围与非目标

**做**：从 `RemoteSource` 读取会话与消息 → 规范化 → 写 Dexie（`conversation` / `message`）→ 返回 `SyncSummary`。

**不做**：请求拦截、网络请求、页面 DOM 写入、搜索索引写入、删除同步、附件内容恢复。

## 2. 模块与文件

```text
src/shared/local-storage.ts   # LocalStoragePort 纯端口（无浏览器依赖）
src/core/feature-flags/
├── storage.ts                # browser.storage.local 适配 + key 常量
└── store.ts                  # createFeatureFlagStore：get/set/reset，复用 resolveFlags
src/core/sync/
├── types.ts                  # RemoteSource 端口、Remote*、SyncSummary、SyncStatus、SyncOptions
├── cursor.ts                 # 同步游标读写（browser.storage.local）
└── conversation-sync.ts      # ConversationSync 实现（编排、幂等、部分失败、游标、分片取消）
src/core/driver/
└── main-world-source.ts      # MAIN world 只读占位：接口 + throw not implemented + TODO(ADR-007)
tests/fixtures/
├── generate-fixtures.ts      # 确定性生成器（seed 42，纯函数，不落盘、不入 git）
└── fixture-source.ts         # 实现 RemoteSource 的夹具，可注入指定 remoteId 失败
```

依赖方向：`conversation-sync → types + db + shared/result`；**不** import UI / Vue / driver 具体实现。

## 3. 契约

```ts
export interface RemoteConversationSummary {
  remoteId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number | null;
}

export interface RemoteConversationDetail extends RemoteConversationSummary {
  messages: Array<{
    remoteId: string;
    role: MessageRole;
    content: string;
    thinking?: string;
    order: number; // 远端原值，不重排
    attachmentMeta?: AttachmentMeta[];
  }>;
}

export type SourceAvailability = { ready: true } | { ready: false; reason: CoreErrorCode };

export interface RemoteSource {
  getAvailability(): Promise<CoreResult<SourceAvailability>>;
  listConversations(): Promise<CoreResult<RemoteConversationSummary[]>>;
  fetchConversation(remoteId: string): Promise<CoreResult<RemoteConversationDetail>>;
}

export interface SyncSummary {
  total: number;
  synced: number;
  skipped: number;
  failed: Array<{ remoteId: string; reason: string }>;
  /** 取消时「未处理」的会话数；正常完成恒为 0（必填字段）。 */
  cancelled: number;
  durationMs?: number;   // D3：便于把性能写进交付证据
}

export interface SyncStatus {
  lastSyncedAt: number | null;
  conversationCount: number;
  messageCount: number;
  selectorsReady: boolean;
}

export interface SyncOptions {
  full?: boolean;        // D4：跳过游标判定，强制全量
  signal?: AbortSignal;  // 分片可取消
  batchSize?: number;    // 默认 20 个会话/批
}

export interface ConversationSync {
  syncAll(options?: SyncOptions): Promise<CoreResult<SyncSummary>>;
  syncConversation(remoteId: string): Promise<CoreResult<SyncSummary>>;
  getStatus(): Promise<CoreResult<SyncStatus>>;
}
```

## 4. 全量 vs 增量

- **首次 / 游标缺失 / 游标版本不符 → 全量**。
- **增量**：游标存 `browser.storage.local` key `deck.sync.cursor.v1`，形如
  `{ schemaVersion: 1, lastSyncedAt: number | null, lastRunAt: number | null }`。
  判定：`summary.updatedAt > lastSyncedAt` 则同步，否则计入 `skipped`。
- **D1 游标字段**：`lastSyncedAt` 单值（= 本轮成功写入会话的 `max(updatedAt)`），不用逐会话 map。
- **游标推进的保守规则（关键修正）**：
  - `failed.length > 0` → **游标不推进**；
  - `cancelled` → **游标不推进**；
  - `synced === 0` → 不推进（避免把「全部跳过」误当成进度）。
  - 原因：失败会话的远端 `updatedAt` 不会因为失败而前进，一旦推进游标，增量查询永远不会再选中它，等于**永不自动重试**。不推进最坏只是下次重跑，由幂等 upsert 消化重复。
- **强制全量**：`syncAll({ full: true })` 忽略游标（用户「重新同步」、改版修复后使用）。
- 游标只在整轮结束后写一次（不是每批写），保证「要么整轮推进，要么原地不动」。

## 5. 幂等性

- **Conversation 主键契约（写死）**：
  - `Conversation.id` 是**独立主键**（local id），创建后**永不改变**；
  - `remoteId` 是**唯一索引**，只作为远端身份；
  - `Message.convId` 与 `Fork.parentConvId` 一律指向 `Conversation.id`（local id），**不指向 `remoteId`**；
  - 远端重同步**只更新 `title` / `createdAt` / `updatedAt`**，绝不改 `id`，也不动 `projectId` / `tags`（用户分类不能被同步覆盖）。
  - 新建时 `id = remoteId` 只是「首次创建时的取值」，之后即使远端 id 规则变化也不回头改。
- **Message**：主键 `toMessageKey(convId, remoteMessageId)`，`bulkPut` 覆盖写 → 重复同步同结果；`convId` 取上面确定的 local id。
- **order**：照远端原值保存，不重排、不补洞（不连续 / 非 0 起始均为合法输入）。
- **同批重复 remoteId**：只处理第一条，其余计入 `skipped`。
- **删除**：P0 不做远端删除同步，本地保留（已知限制）。
- **事务边界**：单会话一个 Dexie 事务（conversation + messages），失败只回滚该会话。

## 6. 执行位置与 MV3 生命周期

### 6.1 谁在读、谁在写

- **读页面数据的唯一合法位置是 content script**：`RemoteSource` 只能在 `chat.deepseek.com` 页面上下文使用（MAIN world 只读通道，ADR-007 补充说明）。
- **扩展 DB（Dexie 库 `deepseek-thread-deck`）background 与 content script 都能写**，但谁写谁负责一致性；P0 只由 content script 写，background 不持有数据副本。
- **当前选择：sync 跑在 content script**。popup 生命周期太短，background 看不到页面数据。

### 6.2 由此带来的 UX 约束

- 同步期间**必须停留在 DeepSeek 标签页**：切走不会中断，但关掉/刷新该标签页会中止（content script 上下文销毁）。
- 中止时：进行中的 Dexie 事务随上下文回滚，已提交批次保留；**游标不推进**，重启后可从上次游标继续。
- 5 万条消息量级：分片（默认 20 会话/批）+ 每批 `await` 让出事件循环 + 每批/每会话检查取消标志，避免长时间卡页面。
- 取消从两个层面表达：
  - **开始前已取消** → `err(SYNC_CANCELLED)`；
  - **进行中取消** → `ok` + `cancelled: N`（N = 未处理会话数），已处理的保留。

### 6.3 多标签页互斥锁（P0 必须）

- 用户可能同时开多个 DeepSeek 标签页，都会触发同步；不加锁会重复劳动并放大写冲突。
- 锁记录放 `browser.storage.local` 的 `deck.sync.lock`：`{ owner, acquiredAt, expiresAt }`，TTL **60s**。
- 抢不到锁 → 返回 `err(SYNC_IN_PROGRESS)`（`retryable: true`），UI 提示「已有同步在进行中」。
- 锁只在写库期间持有，**成功或失败都会释放**（`finally`），不会把用户锁死；页面崩溃留下的锁由 TTL 过期接管。
- **已知局限**：`storage.local` 的「读-改-写」跨标签页不是原子的，存在极窄竞态；因此锁只作为「避免重复劳动」的优化，数据正确性由 sync 的幂等 upsert 兜底。后续可换用 Web Locks（`navigator.locks`），端口 `SyncLockPort` 不变。

### 6.4 页面刷新 / 关闭

- content script 上下文销毁 → 未提交事务回滚，已提交批次保留。
- 游标只在整轮成功后写一次；中断 → 游标不推进 → 下次重跑，幂等 upsert 消化重复。
- 不存在「游标写一半」：游标与锁都是单 key 单对象写入，`storage.local.set` 原子。

## 7. 部分失败

- `getAvailability()` 不可用 → 整体 `err(reason)`（如 `SELECTOR_MISSING`），不读不写。
- `listConversations()` 失败 → 整体 `err(SOURCE_UNAVAILABLE)`，不写库。
- 单会话失败 → 记入 `failed[]`，继续下一个；整体仍 `ok: true`。
- 全部失败 → 仍 `ok: true` + `failed.length === total`，游标不推进，UI 提示重试。
- `readonlySyncEnabled === false` → 立即 `err(SYNC_DISABLED)`，不碰页面与 IndexedDB。

## 8. 与 search-index 的边界

- **sync 只写 `conversation` / `message`，绝不写 `searchIndex`**。
- search-index 从 DB 读数据自建索引（`rebuild` / `upsertConversation` / `removeConversation`）。
- 编排层（阶段 7）在 sync 成功后调 `search.upsertConversation(convId)`。
- **索引失败降级（固化口径）**：`search.upsertConversation()` 失败只记日志 + 置 `fullTextSearchEnabled = false`，**不把 sync 的 `ok` 改写成失败**；UI 读到该 flag 后自行降级为标题搜索。

## 9. UI 成功判定（Phase 7 按此实现）

判定顺序（先看取消，再看失败，最后才说成功）：

| 条件 | 展示 |
| --- | --- |
| `ok === false` | 按错误码显示：「同步不可用」/「适配中」/「同步已关闭」/「已有同步在进行中」+ 重试入口 |
| `ok && cancelled > 0` | 「同步已取消（已处理 `synced + failed.length` / `total - skipped`）」+ **继续**按钮 |
| `ok && failed.length > 0` | 「同步完成（N 条失败）」+ 重试入口 |
| `ok && failed.length === 0` | 「同步完成」 |

**skipped 展示层转译（固化）**：

- `skipped` 是内部计数（游标跳过 + 同批重复），**默认不展示**，避免用户看到「跳过 480 条」以为出错；
- `skipped > 0 && failed === 0 && cancelled === 0` → 只显示「同步完成」，不显示 skipped；
- 仅在调试视图（设置页/诊断面板）展示 `skipped` 原始值。
- `cancelled > 0` 时显示取消状态 + 继续按钮，且此时**不显示**「同步完成」。

## 10. 性能与基准

- `pnpm bench` = 独立配置 `vitest.bench.config.ts`，只跑 `tests/bench/**/*.bench.ts`，**不进 `pnpm test`**、不参与覆盖率。
- **指标口径（固化）**：
  - `sync.bench.ts` 看**总耗时**（全量 / 增量各一次），不看 P95；
  - `search.bench.ts` 才看**单次查询 P95**；
  - fake-indexeddb 是纯 JS 内存实现：**sync 耗时无参考意义**（仅证明逻辑不爆炸、能跑完 500/50k），**不得用 sync 假数字做性能承诺**；
  - search 的 P95 在 fake-indexeddb 下接近真实值，可作参考。
  - 以上口径同时写进对应 bench 文件头部注释。
- 阶段 4 落 `tests/bench/sync.bench.ts`；阶段 5 落 `tests/bench/search.bench.ts`（P95 < 300ms）。

### 10.1 同步耗时归因（2026-11-14，fake-indexeddb，中位数）

`pnpm bench` 中 `tests/bench/sync-attribution.bench.ts`，500 对话 / 5 万消息：

| 阶段 | 中位耗时 | 占全量 |
| --- | --- | --- |
| 夹具生成 | 28.3 ms | 1.4% |
| 数据源（list + 500 次 fetch，含 structuredClone） | 184.2 ms | 9.0% |
| 全量同步 @batch=20（生产默认） | 2043.7 ms | 100% |
| 全量同步 @batch=500 | 1894.8 ms | 92.7% |
| 单事务 bulk 写全量 | 7300.6 ms | 357% |

推导：分片 overhead（24 次让出）约 **148.8 ms / 每次 6.2 ms**；数据源占 9%；剩余约 1.7 s 是 **500 个逐会话事务 + 编排** 的成本；**单事务大写入在该实现下反而慢 5.4 s**。

结论：fake-indexeddb 的事务/批量写入特征与真实 IndexedDB 不同，**不能用这些数字决定 M1b 是否做并发或批量优化**；M1b 在真实 IndexedDB 上用同一组计时点复测后再定。**禁止把以上数字当性能承诺。**

## 11. 夹具与测试覆盖

`generate-fixtures.ts`：`generateFixtureData({ conversations, messagesPerConv, chineseRatio, withThinking, withAttachments, seed = 42 })`，纯函数 + mulberry32，**不写文件、不入 git**。

正确性单测必覆盖：空对话、单条 100KB 超长消息、含 `thinking`、含 `attachmentMeta`、中英 emoji 特殊字符混合、重复标题、`remoteId` 重复插入、`order` 不连续 / 起始非 0；另有部分失败、重跑幂等、游标增量与「失败不推进游标」、取消、flag 关闭、选择器不可用、DB 打开失败、本地 `projectId`/`tags` 不被覆盖。

## 12. 提交计划（每步单独汇报）

1. `feat(core): feature flag 持久化与开关存储`
2. `test(fixtures): 新增确定性夹具生成器与夹具数据源`
3. `feat(sync): 新增 RemoteSource 契约与 conversation-sync`
4. `chore(driver): 新增 MAIN world 只读占位`
5. `test(bench): 新增基准脚本与同步基准`

## 13. D1–D5 裁决记录（2026-11-14）

| 编号 | 结论 |
| --- | --- |
| D1 | 采用单值 `lastSyncedAt`；并按 §4「失败/取消不推进」修正 |
| D2 | 同意追加 `SYNC_DISABLED` 到 `CoreErrorCode` |
| D3 | 同意 `SyncSummary.durationMs` 为可选字段 |
| D4 | 同意 `syncAll` 增加可选 `SyncOptions`（`full` / `signal` / `batchSize`） |
| D5 | 同意分阶段落 bench：阶段 4 先 `sync.bench.ts`，阶段 5 再 `search.bench.ts` |

## 14. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-14 | `SyncSummary.cancelled` 由可选布尔改为**必填 number**（未处理会话数），新增 `SYNC_CANCELLED`（开始前取消）/ `SYNC_IN_PROGRESS`（抢锁失败）/ `FLAG_STORAGE_FAILED` 三个错误码 |
| 2026-11-14 | 补 §6 执行位置与多标签页互斥锁（`deck.sync.lock`，TTL 60s） |
| 2026-11-14 | 补 §9 skipped 展示层转译与取消态文案 |
| 2026-11-14 | 补 §10.1 同步耗时归因数据与「不可外推」结论 |
