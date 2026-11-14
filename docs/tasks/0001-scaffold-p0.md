# 任务 0001：搭建扩展脚手架并完成 P0 只读同步原型

## 背景

M0/M1 起点。先建立可加载的空扩展与核心数据层，再完成只读同步、索引、侧边栏项目树、搜索与跳转。不涉及请求拦截、注入、分叉、相似提醒。

## 范围（必须完成）

1. 基于 WXT 创建 Vue3 + TypeScript 项目，接入 Pinia、UnoCSS、Dexie、MiniSearch、Vitest、Playwright。
2. 定义数据模型与 Dexie schema，含版本迁移占位。
3. 实现 `conversation-sync`：从 DeepSeek 网页本地读取对话列表与消息（只读，不拦截请求），写入 IndexedDB。
4. 实现 `search-index`：标题 + 正文索引，中文用 `Intl.Segmenter` 分词。
5. 实现 content script 侧边栏：项目树（单层项目 + 未分类）、搜索框、命中跳转。
6. 单测覆盖 sync 与 search；Playwright e2e 验证“同步 → 搜索 → 跳转”。

## 不做

- 任何请求拦截。
- 上下文注入。
- 分叉。
- 相似提醒。
- 云同步、遥测、外发请求。

## 接口契约

统一 Result：

```ts
type CoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } }
```

`conversation-sync`：

```ts
interface ConversationSync {
  syncAll(): Promise<CoreResult<SyncSummary>>
  syncConversation(remoteId: string): Promise<CoreResult<SyncSummary>>
  getStatus(): Promise<CoreResult<SyncStatus>>
}
```

`search-index`：

```ts
interface SearchIndex {
  rebuild(): Promise<CoreResult<void>>
  upsertConversation(convId: string): Promise<CoreResult<void>>
  removeConversation(convId: string): Promise<CoreResult<void>>
  search(query: string, opts?: { limit?: number; projectId?: string }): Promise<CoreResult<SearchHit[]>>
}

interface SearchHit {
  convId: string
  messageId?: string
  title: string
  snippet: string
  score: number
}
```

UI 只调用 core API；不直接访问 IndexedDB 或选择器。

## 验收用例（Done Means）

- 500 条对话、5 万条消息可完成同步。
- 搜索 P95 < 300ms（本地基准测试记录方法）。
- 网络面板确认无外传请求。
- 模拟 DOM 选择器读取失败：UI 显示“同步不可用”，不崩溃。
- 空数据库搜索不崩溃。
- 中文分词可命中示例查询。
- IndexedDB 读取失败：保留上次缓存并提示。
- e2e：同步 → 搜索 → 跳转主流程通过。
- 核心逻辑单测覆盖率 > 70%。

## 回滚

- 只读同步由 feature flag `readonlySyncEnabled` 控制，可关闭。
- 索引异常可删除并重建 IndexedDB。
- 选择器修复集中在 `src/shared/selectors.ts`；必要时移除侧边栏注入，保留只读数据层。
- 不引入外发请求，无服务端回滚需求。

## 交付证据

变更文件、测试结果与覆盖率、e2e 结果、风险点、降级行为说明、回滚方式。
