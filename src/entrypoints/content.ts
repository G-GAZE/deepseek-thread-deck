import { createPinia } from 'pinia';
import { createApp } from 'vue';

import panelStyles from '@/ui/styles/panel.css?inline';
import SidebarPanel from '@/ui/components/SidebarPanel.vue';
import {
  createDeckServices,
  setBootstrapError,
  setDeckServices,
} from '@/ui/services/deck-services';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_idle',
  async main(ctx) {
    const services = await createDeckServices();
    if (services.ok) {
      setDeckServices(services.data);
    } else {
      // 打不开数据库也照样挂面板：显示「同步不可用」，不让页面出现异常。
      setBootstrapError(services.error.message);
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'deepseek-thread-deck',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      // CSS 以 `?inline` 字符串注入 shadow root：样式完全隔离，且不需要
      // cssInjectionMode: 'ui'（那会往 manifest 加 web_accessible_resources）。
      css: panelStyles,
      onMount(container) {
        const app = createApp(SidebarPanel);
        app.use(createPinia());
        app.mount(container);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      },
    });

    ui.mount();
  },
});
