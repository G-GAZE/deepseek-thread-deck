export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_idle',
  main() {
    // P0 阶段 7 在此挂载侧边栏（Shadow DOM + Vue）。
    // 当前脚手架不修改页面 DOM，保证脚本可注入且零副作用。
  },
});
