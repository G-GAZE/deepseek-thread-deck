# DeepSeek Thread Deck（DeepSeek 线栈）

本地优先、MIT 开源的 DeepSeek 网页版对话管理层浏览器扩展。把时间流对话列表升级为以项目/话题为中心、可检索、可复用上下文、可客户端分叉的工作台。

> 状态：M0 脚手架阶段。当前目标为 P0 只读同步原型，不拦截请求、不接入 API。

## 快速开始

```bash
pnpm install
pnpm dev
```

Chrome/Edge 加载开发产物；Firefox 打包使用 `pnpm build:firefox`。

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm test:e2e
```

## 文档

- [AGENTS.md](./AGENTS.md)：Agent 操作手册与硬约束
- [docs/prd.md](./docs/prd.md)：产品需求与验收
- [docs/architecture.md](./docs/architecture.md)：架构说明
- [docs/roadmap.md](./docs/roadmap.md)：路线图
- [docs/adr/](./docs/adr/)：架构决策记录
- [CONTRIBUTING.md](./CONTRIBUTING.md)：提交与 PR 规范

## 隐私

默认本地存储、无遥测、无外传网络请求。详见 `docs/prd.md` 与 ADR-003。

## License

DeepSeek Thread Deck 基于 MIT 协议开源。
