# 设计说明：search-index 持久化（任务 0002 · 阶段 5.5）

> 状态：**待确认（D5 已按裁决修订）**。只覆盖「索引快照持久化 + 首建进度 + 重复分词修复」，不含分批预热（方案 3，P0 不做）。
> 关联：`docs/tasks/0001-search-design.md`（阶段 5 实现与实测）、`docs/tasks/0001-conversation-sync-design.md` §15（M1b 清单）。

## 1. 要解决的两个问题

| 问题 | 现状（实测） | 本方案 |
| --- | --- | --- |
| A：每次启动重建索引 | 5 万文档整轮 `rebuild()` **21,451 ms** | 持久化快照，启动 `loadJSON`（**380–467 ms**） |
| B：首次构建阻塞 | 首建无任何反馈，用户只能干等 | 「正在建立索引 N%」，关侧边栏不断、关标签页才断；就绪前走标题兜底 |

**方案 3（分批预热 / 断点续传）P0 不做**：状态机复杂度接近 sync 加锁两倍，夹具无法验证真实效果。记「P1 若 M1b 实测首次构建仍不可接受时再评估」。

## 2. schema v2：只加表，零 backfill

```ts
export interface SearchIndexSnapshotRecord {
  id: 'singleton';
  /** MiniSearch.toJSON() 的 JSON 字符串 */
  json: string;
  builtAt: number;
  docCount: number;
  /** 数据层 schema 版本（= DB_VERSION） */
  schemaVersion: number;
  /** 自动注入的 minisearch 版本，升级即失效 */
  minisearchVersion: string;
  /** 手动维护的分词器版本；改 tokenizer 逻辑必须 +1 */
  tokenizerVersion: number;
}

// MIGRATIONS 追加 v2
{ version: 2, description: '新增 searchIndexSnapshot 单例表（索引持久化）',
  stores: { ...V1_STORES, searchIndexSnapshot: 'id' } }
```

- **只新增一张表**，5 张原表结构一行不改 → 零 backfill。
- 遵守 AGENTS.md §4：走 Dexie 版本迁移，`MIGRATIONS` 只追加。

### 2.1 版本常量（D3 自动化）

| 常量 | 来源 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `DB_VERSION` | 已有常量 |
| `minisearchVersion` | **自动**：优先 `import { version } from 'minisearch/package.json'`（显式 JSON 导入，WXT/Vite 支持），失败则构建期用 `define` 从仓库根 `package.json` 注入 `__MINISEARCH_VERSION__` | **不写死 7.2.0**：`^7.2.0` 升级后必须让旧快照失效 |
| `tokenizerVersion` | 手写常量 `TOKENIZER_VERSION = 1` | 代码注释写明「**修改 tokenizer 逻辑（分词规则/归一化/兜底切分）时必须 +1**」，否则旧快照会带着旧分词结果被复用 |

## 3. 失效判定（D5 修订）

**只有下列情况才判定快照失效并 rebuild**：

1. `schemaVersion !== DB_VERSION`
2. `minisearchVersion !== 当前 minisearch 版本`
3. `tokenizerVersion !== TOKENIZER_VERSION`
4. 快照缺失、`json` 为空、`loadJSON` 抛错 / JSON 损坏
5. `max(conversation.updatedAt)` **明显倒退**（例如 `maxUpdatedAt < builtAt - 24h`，视为系统时间被改或数据被回滚）→ 保守 rebuild

**明确不再触发 rebuild 的情况**：

- **`conversation.count()` 与快照预期不一致 → 只记日志，不 rebuild**。P0 无删除 UI，count 增加（sync 新增会话）是常态；若因此 rebuild，持久化价值直接归零。
- 增量完成后 count 仍不匹配 → 只记日志（P0 只可能是数据损坏，等用户手动「重建索引」）。
- 若未来 M1b 观测到「count 持续不匹配且搜索明显缺结果」，再考虑按 `docCount` 差异做定向修复（不在 P0 范围）。

## 4. 启动有效性判定与增量

```
snapshot = get('singleton')
if (!snapshot || 失效(§3)) → 首建（带进度）
else {
  engine = loadJSON(snapshot.json)          // 380–467ms
  maxUpdatedAt = SELECT MAX(updatedAt) FROM conversation
  if (maxUpdatedAt > snapshot.builtAt) {
     changed = conversations WHERE updatedAt > snapshot.builtAt
     for (chunk of changed, 20/批) upsertConversation(convId)   // 增量 addAll
     if (全部成功) 写新快照(builtAt = now, docCount = 实际行数)
     else 保留旧快照（下次启动重试）
  }
  if (conversation.count() !== 估算值) 只记日志（§3）
}
```

- 用 `updatedAt` 判定，与 sync 游标语义一致。
- 增量失败**不写新快照**，避免把「部分更新」固化成新基线。

## 5. 事务边界

- 快照是**缓存**不是事实源；写入/读取各自独立事务，**不与 `conversation` / `message` 同事务**。
- 事实源仍是 `conversation` / `message` / `searchIndex`；快照损坏由 §3 失效 + 重建恢复。
- 快照 `put` 单 key 原子替换，无需临时态。

## 6. 索引体积实测

| 指标 | 实测 |
| --- | --- |
| 文档数 | 50,000 |
| `toJSON()` | **17,123,103 bytes ≈ 16.33 MiB** |
| 每文档 | **342 bytes** |
| `addAll`（组装 5 万文档） | 3,188–3,655 ms |
| **`loadJSON`** | **380–467 ms** |

**`unlimitedStorage` 结论（D1）**：16.33 MiB 超 `storage.local` 的 10 MB 默认配额，**若放 storage.local 就必须申请**；本方案放 **IndexedDB 新表**走源配额，**不需要该权限** → **不申请**（权限最小化），代价是极端磁盘压力下可能被回收，届时自动退回「重建 + 进度」。
**M1b 验证（新增第 9 条）**：关闭浏览器 → 重开 **≥3 次**，确认命中 `loadJSON` 而非 rebuild；若快照被系统频繁回收，等于每次重建，持久化方案即失效。

## 7. 内存占用评估（新增，③）

实测（Node 20/24，`--expose-gc`，50k 文档）：

| 路径 | 堆增量 |
| --- | --- |
| `addAll`（构建） | **+98.3 MiB** |
| `loadJSON` | **+195.9 MiB**（其中持有 16.33 MiB 的 JSON 字符串；V8 中 UTF-16 约 32 MiB，其余是解析中间对象） |
| `loadJSON` rss 增量 | +153.3 MiB |

判断：

- 稳态索引常驻 ≈ **100 MiB**，与 `addAll` 持平；**瞬时峰值 ≈ 196 MiB** 主要来自 JSON 字符串 + 解析中间垃圾。
- 数字**超过 100 MiB 阈值** → 触发「是否需要降级方案」的评估，但**本阶段不实现**：
  - 候选 A：按项目分片加载（只加载当前项目索引，其余走标题搜索）；
  - 候选 B：只加载最近 N（如 100）个会话的消息级索引，其余会话只索引标题。
- Node 堆 ≠ Chrome content script 堆，**必须 M1b 实测**（见 §14 第 11 条）；实施时先做两个低风险优化：
  1. `loadJSON` 前确保不持有第二份索引；
  2. 解析成功后立即释放 `json` 字符串引用。

## 8. 重复分词与写表成本（新增，①，与 5.5 一起修）

实测拆解（50k 文档）：

| 项 | 耗时 |
| --- | --- |
| 为 `tokens` 字段分词（重复的那一份） | **1,183 ms** |
| MiniSearch `addAll`（含其内部分词） | 3,188 ms |
| `bulkPut` 50k 行（真实 tokens） | **11,411 ms** |
| `bulkPut` 50k 行（空 tokens） | **5,865 ms** |

结论与动作：

1. `rebuild()` 的 21,451 ms ≈ 读表 + **两份分词** + 写 5 万行；其中**去掉 `tokens` 计算可省约 6.7 s（≈31%）**。
2. **`SearchIndexRecord.tokens` 目前没有任何读取方**（MiniSearch 用构造时的 `tokenize` 自行分词；标题兜底走 `conversation.title`），属「只写不读」字段 → **不再计算真实 tokens，写空数组 `[]`**，保留字段以兼容 v1 结构（避免为一个没人读的字段开 v3 迁移）。
3. 目标：`rebuild()` 逼近「`addAll` + 写表」量级（预计 ~9–11 s）；实施时用 bench 记录修复前后对比，达不到就在交付里说明差额来源。
4. MiniSearch 构造已传我们自己的 `tokenize`（单一实现），不再额外包装。

## 9. 首建 UX 与生命周期语义（新增，②）

- **构建跑在 content script，不在 background SW**：与 sync 执行位置一致；不引入 `alarms`。
- **关闭侧边栏不中断**：构建循环在 content script 里分片执行，侧边栏只是视图。
- **关闭 / 刷新标签页才中断**：context 销毁即停止；已写入的 `searchIndex` 行保留，**不写快照**，下次启动重新构建（无断点续传）。
- **进度持久化**：进度写 `browser.storage.local` 的 `deck.search.indexProgress.v1`：
  `{ phase: 'building' | 'done' | 'idle', processed: number, total: number, updatedAt: number }`
  重开侧边栏读该 key，直接显示当前进度；`updatedAt` 超过 5 分钟仍为 `building` → 视为中断，显示「索引未完成，将重新建立」。
- **进度粒度**：每 20 个会话更新一次（与 sync 批大小一致），文案 `正在建立索引 37%（185 / 500）`。
- **就绪前搜索**：直接走标题兜底，结果区提示「全文索引建立中，当前仅搜索标题」；不排队、不报错。

## 10. 存储失败降级

| 场景 | 行为 |
| --- | --- |
| 快照写入失败（配额/IO） | 记日志，不重试、不阻塞；下次启动重建 |
| 快照读取失败 | 视为无快照 → 重建 + 进度 |
| `loadJSON` 抛错 | 删除快照 → 重建 + 进度；错误归一为 `INDEX_INIT_FAILED`，UI 走标题兜底 |
| 全流程失败 | 仍有标题搜索兜底（阶段 5 已实现并测试） |

**持久化只是加速器，任何失败都退回阶段 5 的已知可用路径。**

## 11. 增量触发与成本估算

**触发**：sync 成功后按 `synced` 的 convId 调 `upsertConversation`；启动时对 `updatedAt > builtAt` 的会话增量；P1 改项目归属时同一入口。

**成本**：
- 单会话（100 条消息）≈ **7–25 ms**（分词 + 写表；去掉 tokens 后偏低端）。
- 全量 500 会话 ≈ **3.5–12.5 s**，分摊在 sync 分片内。
- 启动增量典型 1–10 会话 → **< 250 ms**。
- 快照写入：16.33 MiB 单次 `put`，与 `loadJSON` 同量级（数百 ms）。

**已知负债（沿用阶段 5）**：`projectId` 未落 `searchIndex` 表，靠内存映射；**P1 改项目 UI 时必须写表或改按需 join**（本次 v2 只加快照表，避免混迁移）。

## 12. 验收与测试计划

- schema：v2 只增表、迁移连续、v1 数据在 v2 下可读（零 backfill）。
- 失效：三个版本戳任一变化 → 重建；`maxUpdatedAt` 倒退 >24h → 重建；**count 不一致 → 不重建（有专门用例）**。
- 有效性：`maxUpdatedAt <= builtAt` → 只 `loadJSON`（断言未触发 rebuild / 未重复分词）。
- 增量：只对 `updatedAt > builtAt` 的会话 upsert；增量失败不写新快照。
- 事务：快照写失败不影响已提交的业务数据。
- 降级：快照读写失败 / `loadJSON` 抛错 / 配额失败 → 全部退回「重建 + 标题兜底」，不抛异常。
- 进度：20 会话粒度、单调递增、中断后可识别。
- 分词修复：rebuild 前后 bench 对比（目标省 ~6.7s）；断言不再写真实 tokens。
- bench：快照体积、`loadJSON` 耗时、rebuild 修复前后、内存（heap/rss）四项进 `pnpm bench`。

## 13. 裁决记录

| 编号 | 结论 |
| --- | --- |
| D1 | **不申请 `unlimitedStorage`**；新增 M1b 第 9 条（关机重开 ≥3 次验证快照不被回收） |
| D2 | 快照存 IndexedDB（schema v2），同意 |
| D3 | `minisearchVersion` **自动注入**（JSON 导入或构建期 define）；`tokenizerVersion` 手写并加注释 |
| D4 | 无效快照直接删除并重建，同意 |
| D5 | **修订**：count 不一致不触发 rebuild（只记日志）；仅版本戳不符 / JSON 损坏 / `maxUpdatedAt` 明显倒退才 rebuild |

## 14. M1b 清单（与 `docs/tasks/0001-conversation-sync-design.md` §15 同步）

9. **快照持久性**：关闭浏览器 → 重开 **≥3 次**，确认 `loadJSON` 命中而非 rebuild；频繁回收则该方案失效。
10. **`loadJSON` 真实耗时**：fake 下 380–467 ms，真实可能 1–2 s；**超过 1 s 需要加载进度提示**。
11. **内存占用实测**：> 100 MiB 触发降级方案评估（按项目分片 / 只加载最近 N 会话）。
