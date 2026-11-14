import { defineConfig } from 'wxt';

import { resolvePackageVersion } from './scripts/minisearch-version';

const minisearchVersion = resolvePackageVersion('minisearch');

// WXT 配置。目录分层遵循 AGENTS.md §3：源码统一放在 src/ 下。
// manifest 权限遵循最小化原则（见 ADR-007、PR 描述中的权限清单）：
// - permissions: storage（P0 仅用于本地设置与 feature flag）
// - host_permissions: 仅 chat.deepseek.com
// 明确不申请：webRequest / declarativeNetRequest / tabs / <all_urls> / scripting / unlimitedStorage。
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue', '@wxt-dev/unocss'],
  vite: () => ({
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
