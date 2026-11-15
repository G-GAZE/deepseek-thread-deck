/** 构建期由 vite.define 注入（见 wxt.config.ts / vitest.config.ts）。 */
declare const __MINISEARCH_VERSION__: string;

/** Vite 的 `?inline` CSS 导入：返回处理后的 CSS 字符串（用于注入 shadow root）。 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
