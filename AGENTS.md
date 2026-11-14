# AGENTS.md — deepseek-thread-deck

> 本文件是 Agent 每次开工必读的操作手册。项目背景、决策理由、路线图在 `docs/`，不要从本文件推断当前任务范围。

## 0. 项目一句话

本地优先、MIT 开源的 DeepSeek 网页版对话管理层浏览器扩展（Chrome/Edge MV3 为主，Firefox WebExtensions 兼容）。把 DeepSeek 网页版的时间流对话列表升级为以项目/话题为中心、可检索、可复用上下文、可客户端分叉的工作台。

## 1. 硬约束（违反即拒稿，不得自行推翻）

- ADR-001：不做 DeepSeek 开放 API，不要求 API Key，不产生 API 费用。
- ADR-002：形态为浏览器扩展，不做独立客户端。
- ADR-003：本地优先。默认无遥测、无外传网络请求；导出/备份由用户主动触发。
- ADR-005：分叉采用客户端重放模拟；附件不可完整恢复，必须在 UI 明示。
- ADR-006：写入类能力必须 feature flag + 降级路径。
- ADR-007：P0 只读安全模式不拦截请求，仅读 IndexedDB 与本地存储。
- ADR-008：MIT 开源；页面 DOM 选择器统一放 `src/shared/selectors.ts`。
- 核心层 `src/core/**` 不得 import 任何 Vue 代码。
- UI 层不得直接访问 IndexedDB 或 driver，只能调用 core 暴露的 API。
- `src/core/**` 禁止 `any` 逃逸；对外错误统一使用显式 Result/错误码，不把底层异常直接抛给 UI。
- 页面 DOM 选择器不得散落在业务代码中，必须集中管理。
- 任何外发网络请求、manifest 权限变更、新增运行时依赖，必须先经人工确认。
- 禁止在 content script 中使用 `eval`；禁止把 token 落盘；禁止扩大任务范围。
- Git commit 信息必须遵循 Conventional Commits；**commit 类型和范围使用英文，描述使用中文**。示例：
  - `feat(core): 新增对话同步游标`
  - `fix(ui): 修复搜索命中跳转失败`
  - `test(search): 补充中文分词用例`
- PR 标题、PR 描述、Issue 描述一律使用中文。PR 标题建议格式：`[模块] 中文摘要`，例如 `[core] 完成 P0 只读同步原型`。
- 如需变更以上硬约束或 ADR 决策，先在 PR 描述中提出并等待人工确认。

ADR 全文见 `docs/adr/`。

## 2. 技术栈（固定）

TypeScript strict / WXT（Vite）/ Vue 3 `<script setup>` / Pinia / UnoCSS / Dexie / MiniSearch + `Intl.Segmenter` / Vitest / Playwright / ESLint + Prettier / pnpm。

已否决：React、Svelte、Plasmo、Element Plus、Naive UI、独立客户端/API 路线。理由见 ADR-004。

## 3. 目录与分层

```text
src/
├── entrypoints/      # background.ts, content.ts, popup/, options/
├── core/             # 与 UI 无关，可单测
│   ├── db/
│   ├── sync/
│   ├── search/
│   ├── project/
│   ├── preset/
│   ├── fork/
│   ├── similarity/
│   ├── driver/
│   └── degradation/
├── ui/               # Vue 组件、视图、composables
├── shared/           # 类型、常量、selectors.ts
└── assets/
tests/
├── unit/
└── e2e/
```

依赖方向：`entrypoints/ui → core → 适配层/浏览器层`。`core` 不依赖 `ui`；`ui` 不直接访问 IndexedDB 或 driver。

## 4. 数据模型

以 `src/core/db/schema.ts` 为唯一事实源。字段定义见 `docs/prd.md` 与 `docs/architecture.md`。新增字段必须写 Dexie 版本迁移；不允许无迁移直接改 schema。

## 5. 常用命令（以 `package.json` 为准）

```bash
pnpm install
pnpm dev
pnpm build
pnpm build:firefox
pnpm zip
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm test:coverage
pnpm test:e2e
```

交付前必须跑通：`pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`。若脚本尚未创建，Agent 应按上述命名补齐 `package.json`。

## 6. 交付规范（每个任务/PR 必须输出）

- 变更文件清单。
- 测试结果：单测、覆盖率数字、e2e 结果。
- 风险点与未覆盖场景。
- 降级行为说明：失败时用户看到什么、如何重试、如何回滚。
- 小步 PR；先写测试后实现；核心逻辑覆盖率 > 70%；主流程必须有 Playwright e2e。
- 涉及 `deepseek-driver` 的改动，PR 必须说明其 license 与版本。
- 不得自行扩大范围；写入类功能先做只读原型，再开 feature flag。

## 6.1 GitHub 操作（gh CLI）

- 所有 issue、PR、review、comment、CI 查询一律通过 `gh` CLI 完成，不操作 Web UI。
- 只读命令可自主执行：`gh issue view`、`gh pr view`、`gh pr list`、`gh run list`。
- 写入命令（创建/合并 PR、关闭 issue、`gh api -X DELETE/PUT/PATCH` 等）必须先经人工确认。
- **Agent 不得自行创建 GitHub Issue**；创建 Issue 是人类的决策。
- 读取时始终使用 `--json` 加 `| cat`，避免分页器和 scope 报错：
  ```bash
  gh issue view 123 --json title,body,state | cat
  gh pr view 456 --json title,body,files | cat
  ```
- 多行 PR 正文先写临时文件，用 gh pr create --body-file 提交。
- gh 因权限/认证失败时，停止操作并明确请求人工介入，不要 fallback 到网页或其他连接器。

## 7. 降级策略（写入/网络失败必须查此表）

| 失败场景 | 降级行为 |
|---|---|
| driver 不可用 / token 拦截失败 | 写入功能关闭，退回只读；注入改为“复制到剪贴板” |
| IndexedDB 读取失败 | 保留上次缓存，提示“同步不可用” |
| 全文检索初始化失败 | 退回标题搜索 |
| 分叉中途失败 | 保留草稿与新会话链接，提示可重试 |
| DeepSeek 页面 DOM 改版 | 选择器集中失效，插件显示“适配中”，不阻塞只读功能 |

统一由 `src/core/degradation/` 处理。任何写入/网络类能力失败都必须有明确降级路径。

## 8. 当前任务与范围

见 `docs/roadmap.md` 与 `docs/tasks/`。不要从本文件推断当前任务范围。

## 9. 参考文档

- `docs/prd.md`：产品需求、边界、验收标准。
- `docs/architecture.md`：架构分层、数据流、依赖规则。
- `docs/roadmap.md`：里程碑与退出标准。
- `docs/adr/`：架构决策记录。
- `CONTRIBUTING.md`（仓库根目录）：提交、PR、评审规范。放在根目录是 GitHub 平台约定，新建 PR 时会自动提示。
- `docs/tasks/`：当前任务书。
