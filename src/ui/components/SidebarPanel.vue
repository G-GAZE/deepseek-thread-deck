<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

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

/** 折叠态是一个可上下拖动的小按钮，避免占满右侧遮挡官方「快速跳转」。 */
const FAB_MARGIN = 56;
const fabTop = ref(Math.max(FAB_MARGIN, Math.round(window.innerHeight / 2) - 14));
let dragging = false;
let moved = false;
let dragOffset = 0;

function startDrag(event: PointerEvent): void {
  dragging = true;
  moved = false;
  dragOffset = event.clientY - fabTop.value;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent): void {
  if (!dragging) return;
  const next = event.clientY - dragOffset;
  if (Math.abs(next - fabTop.value) > 2) moved = true;
  fabTop.value = Math.min(Math.max(FAB_MARGIN, next), window.innerHeight - FAB_MARGIN);
}

function endDrag(): void {
  if (dragging && !moved) store.toggleCollapsed();
  dragging = false;
}

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
  <button
    v-if="store.collapsed"
    class="deck-fab"
    type="button"
    title="展开线栈面板（可上下拖动）"
    :style="{ top: `${fabTop}px` }"
    @pointerdown="startDrag"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
  >
    «
  </button>

  <aside v-else class="deck-panel" data-testid="deck-panel">
    <div class="deck-body">
      <header class="deck-header">
        <span class="deck-title">DeepSeek Thread Deck</span>
        <span class="deck-badge">{{ store.status === 'ready' ? 'P0 只读' : '初始化中' }}</span>
        <button
          class="deck-button deck-button--compact"
          type="button"
          :disabled="store.syncing"
          title="从页面缓存同步对话"
          @click="store.syncNow()"
        >
          {{ store.syncing ? '同步中…' : '同步' }}
        </button>
        <button class="deck-icon" type="button" title="刷新" @click="store.refreshAll()">↻</button>
        <button
          class="deck-icon"
          type="button"
          title="收起线栈面板"
          @click="store.toggleCollapsed()"
        >
          »
        </button>
      </header>

      <p v-if="store.syncMessage" class="deck-hint" data-testid="sync-message">
        {{ store.syncMessage }}
      </p>

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
