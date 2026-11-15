import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

// WXT 自动生成的全局声明（defineContentScript、browser 等）。
// 该文件由 `pnpm exec wxt prepare`（postinstall 自动执行）产出，缺失时先跑一次 prepare。
import wxtAutoImports from './.wxt/eslint-auto-imports.mjs';

// 浏览器/Node 常用的全局名（不引入 globals 依赖，按需列出）。
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  Event: 'readonly',
  PointerEvent: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  crypto: 'readonly',
};

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.output/**',
      '.wxt/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: browserGlobals,
      parserOptions: { parser: tseslint.parser },
    },
  },
  wxtAutoImports,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // 分层约束（AGENTS.md §1、docs/architecture.md §2）：
    // core 不得依赖 Vue/Pinia/UI，UI 不得直连 IndexedDB 或 driver。
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vue', 'vue/*', 'pinia', '@vue/*', 'vue-router'],
              message: '核心层禁止依赖 Vue/Pinia（AGENTS.md §1）。',
            },
            {
              group: ['@/ui/*', '~/ui/*', '@/entrypoints/*', '~/entrypoints/*'],
              message: '核心层禁止依赖 UI 与入口层（docs/architecture.md §2）。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ui/**/*.{ts,vue}', 'src/entrypoints/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // core 暴露的 `openDeckDatabase` 是访问本地库的唯一合法入口；
              // 直接 import dexie 仍然禁止（AGENTS.md §1）。
              group: ['dexie'],
              message: 'UI 层不得直接使用 dexie，请通过 core 暴露的 API（如 openDeckDatabase）。',
            },
            {
              group: ['@/core/driver/*', '~/core/driver/*'],
              message: 'UI 层不得直接访问 driver。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
