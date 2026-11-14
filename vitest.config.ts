import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// 覆盖率口径：只统计 core + shared（AGENTS.md §6「核心逻辑覆盖率 > 70%」）。
// UI 与 entrypoints 由 e2e 覆盖，不进入单元覆盖率分母。
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
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
      // local-storage.ts 只有类型声明、没有运行时语句，计入分母会永远显示 0%。
      exclude: ['**/*.d.ts', 'src/shared/local-storage.ts'],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
