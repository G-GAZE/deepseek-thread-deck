import { defineConfig } from '@playwright/test';

// e2e 只跑本地构建产物；不访问 DeepSeek 线上环境。
// 两个 project 分别复用系统已安装的 Chrome 与 Edge：
// 避免下载 Playwright 自带 chromium（本机网络受限），也更贴近用户真实环境。
// 说明见 tests/e2e/README.md 与 docs/tasks/0001-scaffold-p0.md 验收用例。
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'msedge', use: { channel: 'msedge' } },
  ],
});
