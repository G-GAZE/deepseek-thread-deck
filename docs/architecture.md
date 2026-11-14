# 架构说明 — DeepSeek Thread Deck

## 1. 分层

```text
UI 层（Vue3）：侧边栏项目树、搜索面板、预设编辑、分叉按钮、相似提醒
核心层（与 UI 无关，可单测）：project-store / conversation-sync / search-index
  preset-injector / fork-engine / similarity-detector / driver-adapter / degradation-manager
适配层：DeepSeek 页面 DOM 选择器、IndexedDB 读取、driver 封装
浏览器层：Background Service Worker / Content Script / Storage
```

## 2. 依赖规则

- `src/core/**` 不 import Vue、Pinia、UI 组件。
- `src/ui/**` 不直接访问 IndexedDB、DOM 选择器、driver；只调用 core API。
- `src/shared/selectors.ts` 是页面选择器唯一出口。
- 写入类能力统一经 `driver-adapter`，失败统一经 `degradation-manager`。
- 核心层对外返回显式 Result，不把底层异常直接抛给 UI。

## 3. 关键数据流

### 只读同步（P0）

Content Script 读取 DeepSeek 页面本地数据 → `conversation-sync` 规范化 → Dexie 写入 `Conversation/Message` → `search-index` 更新索引 → UI 读取 core 查询结果。

### 搜索

UI 调 `search-index.search(query)` → MiniSearch + `Intl.Segmenter` 分词 → 返回命中 → UI 跳回原对话。索引初始化失败时退回标题搜索。

### 上下文注入（P1）

UI 选择项目 → `preset-injector` 渲染模板变量 → `driver-adapter` 写入新对话；失败降级为复制到剪贴板。

### 客户端分叉（P2）

UI 在消息处触发 → `fork-engine` 读取父会话该轮之前消息 → 创建新会话并按序重放 → 原会话不变；附件缺失提示；失败保留草稿与重试入口。

## 4. 选择器与改版

所有 DOM 选择器集中在 `src/shared/selectors.ts`。DeepSeek 改版时只修此文件；读取失败时 UI 显示“同步不可用/适配中”，不阻塞只读功能。

## 5. 存储

IndexedDB + Dexie。schema 与迁移在 `src/core/db/`。新增字段必须写版本迁移。默认无遥测、无外传网络请求。
