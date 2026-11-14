import { defineConfig } from '@playwright/test';

// e2e 只跑本地 mock 页面 + 真实构建产物；不访问 DeepSeek 线上环境。
// 说明见 tests/e2e/README.md 与 docs/tasks/0001-scaffold-p0.md 验收用例。
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
