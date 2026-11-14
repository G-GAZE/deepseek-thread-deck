# 设计说明：search-index 持久化（任务 0002 · 阶段 5.5）

> 状态：**待确认**。本文只覆盖「索引快照持久化 + 首次构建进度」，不含分批预热（方案 3，P0 不做）。
> 关联：`docs/tasks/0001-search-design.md`（阶段 5 实现与实测）、`docs/tasks/0001-conversation-sync-design.md` §15（M1b 清单）。

## 1. 要解决的两个问题

| 问题 | 现状（阶段 5 实测） | 本方案 |
| --- | --- | --- |
| A：每次启动重建索引 | 5 万文档 `addAll` 需 **3,655 ms**（纯组装），整轮 `rebuild()` 含分词 + 写表需 **21,451 ms** | 持久化序列化快照，启动直接 `loadJSON`（实测 **467 ms**） |
| B：首次构建阻塞 | 首次必须扫全库建索引，期间无任何反馈 | 首次构建显示「正在建立索引 N%」，可关闭侧边栏继续用 DeepSeek；索引就绪前搜索走标题兜底 |

**方案 3（分批预热 / 断点续传）P0 不做**：需要处理断点续传、中断、预热期搜索、进度持久化，状态机复杂度接近 sync 加锁的两倍，夹具环境也无法验证真实效果。记录为「P1 若 M1b 实测首次构建仍不可接受时再评估」。

## 2. schema v2：只加表，零 backfill

```ts
// src/core/db/schema.ts
export interface SearchIndexSnapshotRecord {
  /** 固定单例主键，避免多份快照互相竞争。 */
  id: 'singleton';
  /** MiniSearch.toJSON() 的序列化结果（JSON 字符串）。 */
  json: string;
  /** 快照生成时刻（epoch ms）。 */
  builtAt: number;
  /** 快照覆盖的文档数，用于快速自检。 */
  docCount: number;
  /** 数据层 schema 版本（DB_VERSION）。 */
  schemaVersion: number;
  /** minisearch 包版本，升级后必须失效重建。 */
  minisearchVersion: string;
  /** 分词器版本，分词规则变化后必须失效重建。 */
  tokenizerVersion: string;
}

// MIGRATIONS 追加 v2
{
  version: 2,
  description: '新增 searchIndexSnapshot 单例表（索引持久化）',
  stores: { ...V1_STORES, searchIndexSnapshot: 'id' },
}
```

- **只新增 `searchIndexSnapshot` 一张表**，`V1_STORES` 里 5 张表结构一行不改 → **零 backfill**，老用户升级后 v1→v2 只是多出空表。
- 仍遵守 AGENTS.md §4：新增字段/表必须走 Dexie 版本迁移，`MIGRATIONS` 只追加。

## 3. 版本戳失效逻辑

快照可用需**同时**满足：

1. `record.schemaVersion === DB_VERSION`
2. `record.minisearchVersion === MINISEARCH_VERSION`（构建期读取 `minisearch/package.json` 注入常量）
3. `record.tokenizerVersion === TOKENIZER_VERSION`（手写常量，分词规则/分词器实现变更时 +1）
4. `record.docCount` 与该快照预期一致（内部自检，防截断/半写）

任一不满足 → **视为无快照** → 删除旧快照 → 走首次构建路径（带进度条）。
不做「尽力兼容」：错误快照比没有快照更糟（会静默漏结果）。

## 4. 启动有效性判定

```
maxUpdatedAt = SELECT MAX(updatedAt) FROM conversation
if (!snapshot || 版本戳失效) → 首次构建（带进度）
else if (maxUpdatedAt <= snapshot.builtAt) → loadJSON（实测 ~467ms）
else → loadJSON 后对「updatedAt > snapshot.builtAt」的会话逐个 upsertConversation（增量 addAll）
      → 全部成功后写新快照（builtAt = 本轮结束时刻）
```

- 用 `updatedAt` 而不是时间窗猜：与 sync 的游标语义一致。
- 增量失败（某个会话读不出来）→ 不写新快照，本次仍可用旧快照 + 已增量部分；下次启动重试。
- 会话被**删除**（P0 不删远端，但用户可能清库）→ 靠 `docCount`/`rebuild` 兜底：检测到 `conversation.count()` 与快照 docCount 差异过大时直接重建（阈值：差异 > 0 时对该差异走一次 `rebuild`，P0 简单处理即可）。

## 5. 事务边界

- **快照写入与 `conversation` / `message` 不在同一事务**：快照是**缓存**，不是事实源；跨表大事务会拉长写锁时间，且失败会连累业务数据。
- `searchIndexSnapshot` 的读写各自独立事务：
  - 写入：`db.transaction('rw', db.searchIndexSnapshot, async () => { put(record) })`
  - 读取：单次 `get('singleton')`
- 事实源始终是 `conversation` / `message` / `searchIndex`；快照丢了一致性由「版本戳 + 重建」恢复。
- 快照先写临时态再替换？P0 不需要：单 key `put` 原子，且原子替换后若发现坏数据仍可依版本戳失效重建。

## 6. 索引体积实测（不是猜）

测量方法：与实现相同的 5 万文档（500 对话 × 100 消息，含思维链、`fields: ['title','body']`、`storeFields: ['convId','messageId','title','projectId']`、同一 `Intl.Segmenter` tokenizer），`JSON.stringify(mini.toJSON())` 后取 UTF-8 字节数。

| 指标 | 实测值 |
| --- | --- |
| 文档数 | 50,000 |
| `toJSON()` 字节数 | **17,123,103 bytes ≈ 16.33 MiB** |
| 每文档平均 | **342 bytes** |
| `addAll`（组装 5 万文档） | 3,655 ms |
| `loadJSON`（同一份快照） | **467 ms**（≈ addAll 的 1/8） |
| `loadJSON` 后抽样查询 | 正常命中 |

### 关于 `unlimitedStorage` 的结论（与你的倾向不同，请裁决）

- **如果快照放 `browser.storage.local`**：16.33 MiB 已超过 Chrome 的 10 MB 默认配额，**必须**申请 `unlimitedStorage`。
- **但本方案把快照放 IndexedDB 的新表（schema v2）**：IndexedDB 走源配额（通常为磁盘可用空间的一定比例），16.33 MiB 毫不需要额外权限。
- 因此**建议不申请 `unlimitedStorage`**，理由：manifest 权限每加一项都会增加商店审核与用户信任成本（AGENTS.md 要求权限最小化），而这里能靠存储选型完全避免。**代价**：极端磁盘压力下源存储可能被浏览器回收（Chrome 对扩展源通常不主动清），届时快照丢失 → 自动退化到「重建 + 进度条」，不影响正确性。
- 如果你仍希望申请：那只是影响配额、不涉及网络与数据访问，我可以在 PR 里单独列一条权限变更等你确认，但**本方案不需要**。

## 7. 存储失败的降级

| 场景 | 行为 |
| --- | --- |
| 快照写入失败（配额/IO） | 记日志，**不重试、不阻塞**；下次启动重建（就是当前阶段 5 的行为） |
| 快照读取失败 | 视为无快照 → 重建 + 进度条 |
| `loadJSON` 抛错（快照损坏） | 删除快照 → 重建 + 进度条；**不把异常抛给 UI**（统一 `INDEX_INIT_FAILED` → 标题兜底） |
| 全流程失败 | 搜索仍可用：`search()` 已实现「引擎不可用 → 标题搜索」兜底 |

即：**持久化只是加速器，任何失败都退回阶段 5 的已知可用路径**。

## 8. 首次构建 UX

- 进度定义：`已处理会话数 / conversation 总数`，每处理完 **20 个会话**（与 sync 批大小一致）更新一次，避免高频重渲染。
- 文案：`正在建立索引 37%（185 / 500）`，顶部细进度条；完成 → `索引就绪（5 万条消息）`，3 秒后自动消失。
- **可关闭侧边栏继续用 DeepSeek**：构建跑在 content script 的分片循环里（每批 `await` 让出事件循环），不做阻塞式同步循环。
- **就绪前搜索**：直接走标题兜底（阶段 5 已实现并测试），不排队、不报错；结果区显示「全文索引建立中，当前仅搜索标题」。
- 页面关闭/刷新：构建中断，`builtAt` 不写（快照不落盘），下次重新开始 —— 与 sync 的中断语义一致，不做断点续传（方案 3 不做）。

## 9. 增量更新触发条件与成本估算

**触发**：
1. sync 成功后，由编排层对本次 `synced` 的每个 convId 调 `upsertConversation`（阶段 5 已提供，`searchIndex` 表已同步维护）；
2. 启动时检测到 `maxUpdatedAt > snapshot.builtAt` 的会话，逐个增量；
3. 项目归属变化（P1 改项目 UI 时）→ 调同一个 `upsertConversation`。

**成本估算（按阶段 5 实测外推）**：

- 单会话（100 条消息）组装 ≈ `3,655 ms / 500 ≈ 7.3 ms`；加上分词与写表，**乐观估计 15–25 ms/会话**。
- 一次全量 sync 500 会话 → 增量索引约 **7.5–12.5 s**（分摊到 sync 分片里，不阻塞页面）。
- 启动增量：若只有少量会话变化（典型 1–10 个），成本 **< 250 ms**，可忽略。
- 快照写入：16.33 MiB `put` 单次，预计与 `loadJSON` 同量级（数百 ms），只在快照刷新时发生。

**已知负债（沿用阶段 5）**：`projectId` 未落 `searchIndex` 表，靠内存映射；**P1 引入改项目 UI 时必须把 projectId 写进 `searchIndex` 表或改为按需 join**（本次 schema v2 只加快照表，不顺手改 searchIndex 结构，避免把两件事混在一个迁移里）。

## 10. 验收与测试计划（实施阶段执行）

- schema：v2 迁移只增表、`MIGRATIONS` 连续、v1 数据在 v2 下可读（零 backfill 验证）。
- 失效：三个版本戳任一变化 → 失效重建（各一条用例）。
- 有效性：`maxUpdatedAt <= builtAt` → 只 `loadJSON`（断言未调用 `rebuild` / 未重新分词）。
- 增量：`builtAt` 之后更新的会话被 upsert，未变的会话不重建；增量失败不写新快照。
- 事务：快照写失败不影响 `searchIndex`/`conversation` 已提交数据。
- 降级：快照读写失败、`loadJSON` 抛错、存储配额失败 → 全部退回「重建 + 标题兜底」，不抛异常给 UI。
- 进度：进度回调按 20 会话粒度触发、单调递增、可取消。
- bench：真实快照文件大小与 `loadJSON` 耗时（与本文 §6 对齐），纳入 `pnpm bench`。

## 11. 待裁决

- **D1 是否仍需 `unlimitedStorage`**：我建议**不申请**（快照放 IndexedDB，16.33 MiB 无需该权限）。
- **D2 快照放 IndexedDB（schema v2）** 而非 `storage.local`：确认这个存储选型。
- **D3 版本戳常量起始值**：`schemaVersion = 2`、`minisearchVersion = 7.2.0`、`tokenizerVersion = 1`，同意吗？
- **D4 无效快照处理**：直接删除并重建（保留无效快照没有价值），同意吗？
- **D5 启动增量的会话删除检测**：P0 采用「`conversation.count()` 与快照预期不一致 → 直接 rebuild」，不逐会话比对，同意吗？
