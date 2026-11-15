export default defineBackground(() => {
  // P0 只读模式（ADR-007）：
  // - 不拦截请求，不发送任何外发网络请求。
  // - 同步由 content script 在 chat.deepseek.com 页面上下文完成，
  //   因此 IndexedDB 属于页面源，background 不持有数据副本。
  // 这里只保留最小初始化，后续如需调度再由 core 暴露入口。
});
