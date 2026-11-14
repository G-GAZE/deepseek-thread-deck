# 贡献指南

## 提交规范

- Commit 遵循 Conventional Commits。
- **类型和范围使用英文，描述使用中文**。
- 示例：
  - `feat(core): 新增对话同步游标`
  - `fix(ui): 修复搜索命中跳转失败`
  - `docs(adr): 补充分叉降级说明`
  - `test(search): 补充中文分词用例`
- PR 标题、PR 描述、Issue 描述一律使用中文。PR 标题建议：`[模块] 中文摘要`。

## PR 必须包含

- 变更文件清单。
- 测试结果：单测、覆盖率、e2e。
- 风险点与未覆盖场景。
- 降级行为说明与回滚方式。
- 涉及 `deepseek-driver` 时说明 license 与版本。

## 本地检查

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
```

核心逻辑覆盖率需 > 70%；主流程需有 Playwright e2e。不得自行扩大范围；写入类功能先只读原型再开 feature flag。
