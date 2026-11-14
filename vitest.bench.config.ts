import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

/**
 * 基准专用配置：与 `pnpm test` 完全隔离。
 * - 只跑 tests/bench/**\/*.bench.ts；
 * - 不启用覆盖率（基准数字不进覆盖率分母）；
 * - 超时放宽，允许 5 万条消息在 fake-indexeddb 上跑完。
 * 指标口径见 docs/tasks/0001-conversation-sync-design.md §10。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${srcDir}/$1` },
      { find: /^~\/(.*)$/, replacement: `${srcDir}/$1` },
    ],
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/bench/**/*.bench.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    coverage: { enabled: false },
  },
});
