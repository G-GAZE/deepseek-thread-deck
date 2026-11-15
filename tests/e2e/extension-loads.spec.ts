import { existsSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';

// 只验证构建产物本身可被系统浏览器加载（M0 退出标准「可加载的空扩展」）。
// 真正的「同步 → 搜索 → 跳转」主流程 e2e 在任务 0001 的阶段 8 补齐。
//
// 前置条件：pnpm build（产出 .output/chrome-mv3）。
// 两个 project（chrome / msedge）复用系统已安装浏览器，不依赖 Playwright 自带 chromium。
//
// 已知平台限制（2026-11-14 实测）：
// - Edge 157 仍支持 --load-extension，可自动校验扩展加载。
// - Chrome 156 已移除该命令行开关：--disable-features=DisableLoadExtensionCommandLineSwitch
//   与 --enable-unsafe-extension-debugging 均无效，headless / 有头模式都不加载未打包扩展。
//   Chrome 侧只能人工在 chrome://extensions 打开「开发者模式 → 加载已解压的扩展程序」验收（M1b）。
//   因此 chrome project 在检测到该限制时明确 skip，并由 msedge project 承担自动校验，
//   不使用 mock 伪造加载结果。
const extensionPath = path.join(process.cwd(), '.output', 'chrome-mv3');
const SERVICE_WORKER_TIMEOUT_MS = 15_000;

interface ManifestShape {
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  manifest_version?: number;
}

function readManifest(): ManifestShape {
  const api = (
    globalThis as unknown as {
      chrome: { runtime: { getManifest: () => ManifestShape } };
    }
  ).chrome;
  return api.runtime.getManifest();
}

function currentChannel(): string {
  const channel = test.info().project.use.channel;
  if (typeof channel === 'string' && channel !== '') return channel;
  throw new Error('e2e project 未配置 use.channel，无法确定用哪个浏览器');
}

function isMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|is not found|not installed|no such file/i.test(message);
}

async function waitForServiceWorker(context: BrowserContext): Promise<Worker | undefined> {
  const [existing] = context.serviceWorkers();
  if (existing !== undefined) return existing;

  try {
    return await context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

test.describe('扩展产物可加载', () => {
  test.skip(!existsSync(extensionPath), '未找到 .output/chrome-mv3，请先运行 pnpm build');

  test('系统浏览器可加载扩展并暴露 MV3 service worker', async () => {
    const channel = currentChannel();
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
      // 只有「浏览器没装」才跳过；其他启动错误照常失败，不掩盖问题。
      if (isMissingBrowser(error)) {
        test.skip(true, `${channel} 未安装，跳过`);
        return;
      }
      throw error;
    }

    try {
      const worker = await waitForServiceWorker(context);

      if (worker === undefined) {
        // 仅 Chrome 存在已知的「命令行侧载被移除」限制，其他浏览器出现该情况视为真实失败。
        test.skip(
          channel === 'chrome',
          `Chrome 137+ 已移除 --load-extension（本机 ${channel} 实测不加载），` +
            'Chrome 侧请人工在 chrome://extensions 加载验收；自动校验由 msedge project 覆盖。',
        );
        throw new Error(`${channel} 未加载扩展：未出现 MV3 service worker`);
      }

      const manifest = await worker.evaluate(readManifest);

      expect(manifest.name).toBe('DeepSeek Thread Deck');
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(['storage']);
      expect(manifest.host_permissions).toEqual(['*://chat.deepseek.com/*']);
      expect(manifest.permissions ?? []).not.toContain('webRequest');
      expect(manifest.permissions ?? []).not.toContain('tabs');
      expect(manifest.host_permissions ?? []).not.toContain('<all_urls>');
    } finally {
      await context.close();
    }
  });
});
