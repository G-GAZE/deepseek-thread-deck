import { defineConfig } from 'wxt';
import type { Plugin } from 'vite';

import { resolvePackageVersion } from './scripts/minisearch-version';

const minisearchVersion = resolvePackageVersion('minisearch');

/**
 * Chromium 在加载 content script 时会做 UTF-8 校验，**拒绝非字符码点**
 * （例如 Dexie 的 `MAX_KEY = "\uFFFF"`）。Dexie 现在被打进 content script，
 * 直接输出会让扩展加载失败（Edge 报「不是 UTF-8 编码格式」）。
 *
 * 这里把产物里的非 ASCII 字符统一转成 `\uXXXX` 转义：语义不变，产物变成纯 ASCII。
 */
function asciiOnlyChunks(): Plugin {
  return {
    name: 'deck-ascii-chunks',
    enforce: 'post',
    apply: 'build',
    // 必须用 generateBundle：renderChunk 早于 esbuild 压缩，压缩会把转义重新变回原字符。
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        if (!/[\u0080-\uffff]/.test(file.code)) continue;
        file.code = file.code.replace(
          /[\u0080-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
      }
    },
  };
}

// WXT 配置。目录分层遵循 AGENTS.md §3：源码统一放在 src/ 下。
// manifest 权限遵循最小化原则（见 ADR-007、PR 描述中的权限清单）：
// - permissions: storage（P0 仅用于本地设置与 feature flag）
// - host_permissions: 仅 chat.deepseek.com
// 明确不申请：webRequest / declarativeNetRequest / tabs / <all_urls> / scripting / unlimitedStorage。
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue', '@wxt-dev/unocss'],
  vite: () => ({
    plugins: [asciiOnlyChunks()],
    define: {
      // 索引快照的版本戳：构建期从 node_modules/minisearch/package.json 读取，
      // 不在运行时 import package.json（避免把整个 package.json 打进产物）。
      __MINISEARCH_VERSION__: JSON.stringify(minisearchVersion),
    },
  }),
  manifest: {
    name: 'DeepSeek Thread Deck',
    description: '本地优先的 DeepSeek 网页版对话管理层扩展：项目树、全文检索、命中跳转。',
    permissions: ['storage'],
    host_permissions: ['*://chat.deepseek.com/*'],
  },
});
