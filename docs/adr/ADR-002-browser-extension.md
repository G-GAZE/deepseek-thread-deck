# ADR-002：形态为浏览器扩展，不做独立客户端

- Status: Accepted
- Date: 2026-11-14

## Context

扩展能直接复用用户已登录的 DeepSeek 网页会话，迁移成本最低。

## Decision

以 Chrome/Edge MV3 为主，Firefox WebExtensions 兼容打包；不做独立客户端。

## Consequences

- 受浏览器扩展权限、商店审核、页面改版影响。
- 可直接复用登录态，无需用户迁移账号。
- 需要 content script 注入侧边栏，样式需轻量隔离。

## Alternatives considered

- 独立客户端：需登录迁移与额外维护，否决。
- 仅书签脚本：能力与可维护性不足，否决。
