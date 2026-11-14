# 设计说明：search-index（任务 0001 · 阶段 5）

> 状态：**实现中**。只覆盖 P0 本地全文检索，不含相似提醒、向量检索、外发请求。

## 1. 边界

- **只读 DB**：`search-index` 从 `conversation` / `message` 读取，**只写 `searchIndex` 表**，绝不写 sync 拥有的 `conversation` / `message`。
- 与 sync 通过 DB 解耦：sync 完成后由编排层调用 `upsertConversation(convId)`，二者互不 import。
- 无外发请求；索引可随时 `rebuild()` 重建。

## 2. 契约

```ts
interface SearchIndex {
  rebuild(): Promise<CoreResult<void>>;
  upsertConversation(convId: string): Promise<CoreResult<void>>;
  removeConversation(convId: string): Promise<CoreResult<void>>;
  search(query: string, opts?: { limit?: number; projectId?: string }): Promise<CoreResult<SearchHit[]>>;
}

interface SearchHit {
  convId: string;
  messageId?: string;   // 会话级命中（0 消息会话）时缺省
  title: string;
  snippet: string;
  score: number;
}
```

## 3. 索引模型

- 文档粒度：**每条消息一个文档**（id = `toMessageKey(convId, messageId)`），字段
  `title`（会话标题，boost 2）、`body`（消息正文 + 思维链）、`convId`、`messageId`、`projectId`。
- **0 消息会话**额外补一条会话级文档（id = `toSearchIndexKey(convId)`），保证标题可命中。
- `searchIndex` 表存文档行（`id/convId/messageId/title/body/tokens`）作为「已索引内容」的事实源；
  MiniSearch 内存索引在 `rebuild()` / `upsertConversation()` 后增量维护。

## 4. 分词

- 中文：`Intl.Segmenter('zh', { granularity: 'word' })`，取 `isWordLike` 片段。
- 归一化：小写、去首尾空白；标点与空白天然被 segmenter 切掉。
- 无 `Intl.Segmenter` 时退回「按非字母数字切开」，保证不抛错、可降级。
- 建索引与查询使用**同一个 tokenizer**，避免两侧切分不一致导致查不到。

## 5. 降级

| 场景 | 行为 |
| --- | --- |
| `fullTextSearchEnabled = false` | 直接走标题搜索（Dexie 过滤），不建 MiniSearch |
| MiniSearch 构造/加载失败 | 返回 `INDEX_INIT_FAILED`，内部标记降级，`search()` 改走标题搜索，不抛异常 |
| 空查询 / 空库 | `ok([])`，不报错 |
| `searchIndex` 表为空 | 自动按需重建一次（惰性初始化） |

## 6. 性能口径

- 阶段 5 独立 `tests/bench/search.bench.ts`，量**单次查询 P50/P95/Max**（多次迭代，先 warmup）。
- 目标：P95 **< 300ms**（任务书验收）。fake-indexeddb 下该数字接近真实值，可作参考；
  但索引构建成本仍受 fake 环境影响，需在 M1b 真实环境复测（见同步设计说明 §15）。
- 基准**不做硬断言**，超阈值打 `WARN`。

## 7. 测试覆盖

分词：中文词、英文大小写、中英混排、emoji/标点、空串、长文本。
索引：rebuild 只写 searchIndex、标题命中、正文中文命中、思维链命中、0 消息会话标题命中、
limit、projectId 过滤、空库/空查询、upsert 增量（其他会话不受影响）、upsert 不存在会话、
remove 后不再命中、重建幂等、flag 关闭退标题搜索、初始化失败退标题搜索、snippet 截断、按分数降序。
