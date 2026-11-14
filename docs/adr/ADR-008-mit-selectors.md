# ADR-008：MIT 开源，选择器集中管理

- Status: Accepted
- Date: 2026-11-14

## Context

扩展需要可审计、可协作；DeepSeek 改版会导致 DOM 选择器失效。

## Decision

采用 MIT 协议开源；页面 DOM 选择器统一放 `src/shared/selectors.ts`，便于集中修复。

## Consequences

- 代码可审计，降低信任门槛。
- 改版时只修选择器文件，并配合“适配中”降级提示。
- 贡献者需遵守 AGENTS.md 与贡献指南。

## Alternatives considered

- 闭源：信任与协作不足，否决。
- 选择器散落：维护成本高，否决。
