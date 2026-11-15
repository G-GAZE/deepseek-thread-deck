<script lang="ts" setup>
import { computed, onMounted, onUnmounted } from 'vue';

import ConversationList from './ConversationList.vue';
import ProjectTree from './ProjectTree.vue';
import SearchPanel from './SearchPanel.vue';
import { useSidebarStore } from '../stores/sidebar';

const store = useSidebarStore();

const progressPercent = computed(() => {
  const current = store.progress;
  if (current === null || current.total === 0) return 0;
  return Math.min(100, Math.round((current.processed / current.total) * 100));
});

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await store.init();
  // 首建索引期间轮询进度（1s），构建完成后保留最后状态。
  timer = setInterval(() => {
    void store.refreshProgress();
  }, 1000);
});

onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
  store.dispose();
});
</script>

<template>
  <aside
    class="deck-panel"
    :class="{ 'deck-panel--collapsed': store.collapsed }"
    data-testid="deck-panel"
  >
    <button
      class="deck-toggle"
      type="button"
      :title="store.collapsed ? '展开线栈面板' : '收起线栈面板'"
      @click="store.toggleCollapsed()"
    >
      {{ store.collapsed ? '«' : '»' }}
    </button>

    <div v-if="!store.collapsed" class="deck-body">
      <header class="deck-header">
        <span class="deck-title">DeepSeek Thread Deck</span>
        <span class="deck-badge">{{ store.status === 'ready' ? 'P0 只读' : '初始化中' }}</span>
      </header>

      <p v-if="store.status === 'error'" class="deck-alert deck-alert--error">
        {{ store.errorMessage }}
      </p>

      <div v-if="store.progress?.phase === 'building'" class="deck-progress">
        <div class="deck-progress__bar">
          <div class="deck-progress__fill" :style="{ width: `${progressPercent}%` }" />
        </div>
        <span class="deck-progress__text">
          正在建立索引 {{ progressPercent }}%（{{ store.progress.processed }} /
          {{ store.progress.total }}）
        </span>
      </div>

      <ProjectTree />
      <ConversationList />
      <SearchPanel />
    </div>
  </aside>
</template>
