import { existsSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

// 只验证构建产物本身可被 Chrome 加载（M0 退出标准「可加载的空扩展」）。
// 真正的「同步 → 搜索 → 跳转」主流程 e2e 在任务 0001 的阶段 8 补齐。
const extensionPath = path.join(process.cwd(), '.output', 'chrome-mv3');

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

test.describe('扩展产物可加载', () => {
  test.skip(!existsSync(extensionPath), '未找到 .output/chrome-mv3，请先运行 pnpm build');

  test('Chrome MV3 产物可加载且权限最小化', async () => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });

    try {
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });

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
