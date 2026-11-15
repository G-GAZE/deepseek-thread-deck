import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

/**
 * 主流程 e2e（阶段 8 + 阶段 9）：在 mock 的 chat.deepseek.com 上验证
 * 「真实页面缓存 → 同步 → 项目树 → 检索命中 → 复制会话 id」。
 *
 * mock 页按真实采集结果写入 `deepseek-chat` / `history-message`，
 * 扩展的只读数据源直接读它，因此这里跑的是真实同步链路（不是预置本地库）。
 *
 * 已知限制：真实页面跳转需要 selectors，当前落地为「复制会话 id + 待适配提示」。
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

test.describe('主流程：同步 → 检索', () => {
  test.skip(!existsSync(extensionPath), '未找到 .output/chrome-mv3，请先运行 pnpm build');

  test('同步页面缓存后检索命中并复制会话 id', async () => {
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

      // 无检索内容时，检索区应收缩到输入框高度，不留大片空白
      const searchSection = panel.locator('.deck-section--search');
      const idleBox = await searchSection.boundingBox();
      expect(idleBox?.height ?? 999).toBeLessThan(170);

      // 真实同步链路：读页面 IndexedDB 缓存 → 写本地库
      await panel.getByRole('button', { name: '同步' }).click();
      await expect(panel.getByTestId('sync-message')).toContainText('同步完成', {
        timeout: 30_000,
      });

      const uncategorizedRow = panel.getByRole('button', { name: '未分类' });
      await expect(uncategorizedRow).toBeVisible();
      await uncategorizedRow.click();
      // 同步消息里也有「40 条」，这里只断言会话列表的计数元素。
      await expect(panel.locator('.deck-section__count').first()).toHaveText('40 条', {
        timeout: 10_000,
      });

      // 回归：40 条会话时「新建」表单必须可点，不能被会话列表遮挡
      await panel.getByRole('button', { name: '＋ 新建' }).click();
      const projectName = panel.getByPlaceholder('项目名称');
      await expect(projectName).toBeVisible();
      await projectName.fill('回归项目');
      await panel.getByRole('button', { name: '创建' }).click();
      await expect(panel.getByRole('button', { name: '回归项目' })).toBeVisible({
        timeout: 10_000,
      });

      const searchInput = panel.getByPlaceholder('搜索标题、正文、思维链');
      await searchInput.fill('重试');

      await expect(panel.getByText('游标推进要保守', { exact: false }).first()).toBeVisible({
        timeout: 20_000,
      });

      // 有结果后检索区恢复可拖高度，分裂器向上拖应继续变高
      const resultBox = await searchSection.boundingBox();
      expect(resultBox?.height ?? 0).toBeGreaterThan((idleBox?.height ?? 0) + 40);
      const splitterBox = await panel.locator('.deck-splitter').boundingBox();
      if (resultBox === null || splitterBox === null) throw new Error('分裂器不可见');
      await page.mouse.move(
        splitterBox.x + splitterBox.width / 2,
        splitterBox.y + splitterBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y - 80, {
        steps: 5,
      });
      await page.mouse.up();
      const afterBox = await searchSection.boundingBox();
      expect(afterBox?.height ?? 0).toBeGreaterThan((resultBox?.height ?? 0) + 40);

      // 折叠态：只保留一个小圆按钮，不占满右侧整条（L3 修复的回归保护）
      await panel.getByTitle('收起线栈面板').click();
      const fab = page.locator('.deck-fab');
      await expect(fab).toBeVisible();
      await expect(panel).toHaveCount(0);
      await fab.click();
      await expect(page.locator('aside[data-testid="deck-panel"]')).toBeVisible();

      // 命中跳转第一版：优先点击页面自有的会话链接，保持 SPA（面板不重新加载）
      await page
        .locator('aside[data-testid="deck-panel"]')
        .getByText('游标推进要保守', { exact: false })
        .first()
        .click();
      await expect.poll(() => page.url(), { timeout: 10_000 }).toContain('/a/chat/s/conv-e2e-');
      const loads = await page.evaluate(() => Number(localStorage.getItem('__deckLoads') ?? '0'));
      expect(loads).toBe(1);
      await expect(page.locator('aside[data-testid="deck-panel"]')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
