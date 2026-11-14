# ADR-006：写入类能力必须 feature flag + 降级

- Status: Accepted
- Date: 2026-11-14

## Context

创建会话、注入、分叉等写入能力依赖页面与 driver，易受改版影响。直接暴露失败会破坏信任。

## Decision

写入类能力必须走 `driver-adapter`，带 feature flag，并有明确降级路径；driver 不可用时退回只读，或降级为复制到剪贴板。

## Consequences

- 每个写入功能需定义开关、失败提示、重试入口、回滚方式。
- 降级逻辑统一由 `core/degradation/` 处理。
- 只读功能不受写入失败阻塞。

## Alternatives considered

- 直接调用页面接口无降级：风险高，否决。
- 仅只读不做写入：无法满足 P1/P2，否决。
