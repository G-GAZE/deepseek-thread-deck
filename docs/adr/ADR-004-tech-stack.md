# ADR-004：技术栈 WXT + Vue3 + Pinia + UnoCSS + Dexie + MiniSearch

- Status: Accepted
- Date: 2026-11-14

## Context

需要 MV3 HMR、三端打包、Vue 生态、轻量注入样式、本地存储与中文检索。

## Decision

TypeScript strict / WXT / Vue3 `<script setup>` / Pinia / UnoCSS / Dexie / MiniSearch + `Intl.Segmenter` / Vitest + Playwright / ESLint + Prettier / pnpm。

## Consequences

- WXT 处理 manifest 差异与三端打包。
- UnoCSS 避免重组件库注入冲突。
- 中文分词先 `Intl.Segmenter`，不足再评估 `segmentit`。
- 核心层与 UI 解耦，便于单测。

## Alternatives considered

- React/Svelte：与用户 Vue3 能力不匹配。
- Plasmo：Vue 支持不如 WXT 直接。
- Element Plus/Naive UI：注入体积与样式冲突风险高。
- API/独立客户端：见 ADR-001/002。
