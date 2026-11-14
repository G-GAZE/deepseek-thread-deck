# ADR-007：P0 只读安全模式优先

- Status: Accepted
- Date: 2026-11-14

## Context

请求拦截与写入能力会提高用户信任门槛与改版风险。P0 需要先证明同步、分类、检索、导出的价值。

## Decision

P0 不碰请求拦截，仅读 IndexedDB 与本地存储；写入能力放到 P1/P2，并遵守 ADR-006。

## Consequences

- P0 风险低、易审计、易发布。
- P0 不提供注入与分叉。
- 后续写入能力需单独评审与 feature flag。

## Alternatives considered

- P0 即做请求拦截：风险与审核成本高，否决。
