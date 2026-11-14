# ADR-001：不做 DeepSeek API，只做网页版增强

- Status: Accepted
- Date: 2026-11-14

## Context

用户核心诉求是保留 DeepSeek 免费网页版的使用方式。接入 API 会产生费用、要求 API Key，并改变交互方式。

## Decision

不接入 DeepSeek 开放 API，不要求 API Key，不提供模型服务。插件只增强网页版。

## Consequences

- 能力受网页版 DOM 与本地存储结构限制。
- 需要选择器集中管理与降级策略。
- 无 API 费用，用户信任门槛更低。

## Alternatives considered

- API 路线：费用与使用方式改变，否决。
- 独立客户端：迁移成本高，否决。
