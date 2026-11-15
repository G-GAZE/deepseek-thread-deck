<script lang="ts" setup>
import { computed } from 'vue';

import { useSidebarStore } from '../stores/sidebar';

const store = useSidebarStore();

const title = computed(() => {
  if (store.selectedProjectId === null) return '未分类会话';
  const project = store.projects.find((node) => node.id === store.selectedProjectId);
  return project?.name ?? '会话';
});

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}-${day}`;
}

async function assign(convId: string, event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement;
  const value = target.value === '' ? null : target.value;
  await store.assignConversation(convId, value);
}
</script>

<template>
  <section class="deck-section deck-section--conversations">
    <div class="deck-section__head">
      <h2 class="deck-section__title">{{ title }}</h2>
      <span class="deck-section__count">{{ store.conversations.length }} 条</span>
    </div>

    <p v-if="store.conversations.length === 0" class="deck-empty">暂无会话</p>

    <ul class="deck-list">
      <li v-for="conversation in store.conversations.slice(0, 200)" :key="conversation.id">
        <div class="deck-row deck-row--static">
          <span class="deck-row__name" :title="conversation.title">
            {{ conversation.title }}
          </span>
          <span class="deck-row__meta">{{ formatTime(conversation.updatedAt) }}</span>
          <select
            class="deck-select"
            :value="conversation.projectId ?? ''"
            title="分配到项目"
            @change="assign(conversation.id, $event)"
          >
            <option value="">未分类</option>
            <option v-for="project in store.projects" :key="project.id" :value="project.id">
              {{ project.name }}
            </option>
          </select>
        </div>
      </li>
    </ul>
  </section>
</template>
