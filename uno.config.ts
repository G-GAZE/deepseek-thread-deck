import { defineConfig, presetWind3 } from 'unocss';

// UnoCSS 配置。P0 界面用 Wind3 预设的原子类；
// 如需设计变量，统一放 theme，避免组件里出现魔法数值。
export default defineConfig({
  presets: [presetWind3()],
  theme: {
    colors: {
      deck: {
        accent: '#4d6bfe',
        surface: '#ffffff',
        muted: '#6b7280',
      },
    },
  },
  shortcuts: {
    'deck-panel': 'bg-deck-surface border border-neutral-200 rounded-lg',
  },
});
