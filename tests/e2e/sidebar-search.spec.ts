import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

/**
 * 主流程 e2e（阶段 8）：在 mock 的 chat.deepseek.com 上验证
 * 「面板渲染 → 项目树计数 → 检索命中 → 复制会话 id」。
 *
 * 限制（已知，见 open-questions Q12/Q13）：
 * - 真实同步未接（RemoteSource 为占位），数据由 mock 页按同一 schema 预置；
 * - 真实页面跳转需要 selectors，当前落地为「复制会话 id + 待适配提示」。
 */
const extensionPath = path.join(process.cwd(), '.output', 'chrome-mv3');
const fixtureHtml = readFileSync(
  path.join(process.cwd(), 'tests/e2e/fixtures/mock-deepseek.html'),
  'utf8',
);

function currentChannel(): string {
  const channel = test.info().project.use.channel;
  if (typeof channel === 'string' && channel !== '') return channel;
  throw new Error('e2e project 未配置 use.channel');
}

function isMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|is not found|not installed|no such file/i.test(message);
}

test.describe('主流程：面板 → 检索', () => {
  test.skip(!existsSync(extensionPath), '未找到 .output/chrome-mv3，请先运行 pnpm build');

  test('侧边栏渲染、检索命中原会话并支持复制会话 id', async () => {
    const channel = currentChannel();
    // Chrome 已移除 --load-extension，主流程 e2e 只在 Edge（同 Chromium 引擎）跑。
    test.skip(channel !== 'msedge', '主流程 e2e 仅在 msedge 执行');

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext('', {
        channel,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          '--disable-features=DisableLoadExtensionCommandLineSwitch',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
    } catch (error) {
      if (isMissingBrowser(error)) {
        test.skip(true, `${channel} 未安装，跳过`);
        return;
      }
      throw error;
    }

    try {
      // 用 fulfill 把 chat.deepseek.com 指向本地 mock 页：URL 保持匹配 content script。
      await context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: fixtureHtml,
        }),
      );

      const page = await context.newPage();
      await page.goto('https://chat.deepseek.com/');
      await page.waitForFunction(
        () => (window as unknown as { __deckSeedDone?: boolean }).__deckSeedDone === true,
        undefined,
        { timeout: 15_000 },
      );

      const seedError = await page.evaluate(
        () => (window as unknown as { __deckSeedError?: string }).__deckSeedError ?? null,
      );
      expect(seedError).toBeNull();

      const panel = page.locator('aside[data-testid="deck-panel"]');
      await expect(panel).toBeVisible({ timeout: 20_000 });

      // mock 页在扩展建库后才写入数据，这里点「刷新」让面板重新拉取项目树与会话。
      await panel.getByTitle('刷新').click();
      const uncategorizedRow = panel.getByRole('button', { name: '未分类' });
      await expect(uncategorizedRow).toBeVisible();
      await uncategorizedRow.click();
      await expect(panel.getByText('1 条')).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByText('中文分词方案')).toBeVisible();

      const searchInput = panel.getByPlaceholder('搜索标题、正文、思维链');
      await searchInput.fill('游标');

      await expect(panel.getByText('游标推进要保守', { exact: false })).toBeVisible({
        timeout: 20_000,
      });

      await panel.getByText('游标推进要保守', { exact: false }).click();
      await expect(panel.locator('.deck-hint')).toContainText('复制', { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
