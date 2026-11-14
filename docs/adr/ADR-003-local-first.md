# ADR-003：本地优先，默认无遥测无外传

- Status: Accepted
- Date: 2026-11-14

## Context

对话内容敏感，用户对浏览器扩展的信任门槛高。

## Decision

所有数据存本地 IndexedDB/扩展存储；默认无遥测、无外传网络请求；导出/备份由用户主动触发。

## Consequences

- 无云同步与多人协作（MVP 不做）。
- 用户换设备需手动导出/导入。
- 任何外发请求必须人工确认并写入 ADR。

## Alternatives considered

- 云同步：隐私与成本高，MVP 否决。
- 匿名遥测：默认关闭，暂不引入。
