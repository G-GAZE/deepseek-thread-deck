<script lang="ts" setup>
import { ref } from 'vue';

import { useSidebarStore } from '../stores/sidebar';

const store = useSidebarStore();

const creating = ref(false);
const newName = ref('');
const renamingId = ref<string | null>(null);
const renamingName = ref('');
const confirmingDeleteId = ref<string | null>(null);

function startCreate(): void {
  creating.value = true;
  newName.value = '';
}

async function submitCreate(): Promise<void> {
  const name = newName.value.trim();
  if (name === '') {
    creating.value = false;
    return;
  }
  const created = await store.createProject(name);
  if (created) {
    creating.value = false;
    newName.value = '';
  }
}

function startRename(projectId: string, currentName: string): void {
  renamingId.value = projectId;
  renamingName.value = currentName;
}

async function submitRename(): Promise<void> {
  const projectId = renamingId.value;
  if (projectId === null) return;
  const name = renamingName.value.trim();
  if (name === '') {
    renamingId.value = null;
    return;
  }
  const renamed = await store.renameProject(projectId, name);
  if (renamed) renamingId.value = null;
}

async function confirmDelete(projectId: string): Promise<void> {
  if (confirmingDeleteId.value !== projectId) {
    confirmingDeleteId.value = projectId;
    return;
  }
  await store.deleteProject(projectId);
  confirmingDeleteId.value = null;
}
</script>

<template>
  <section class="deck-section deck-section--tree">
    <div class="deck-section__head">
      <h2 class="deck-section__title">项目</h2>
      <button class="deck-link" type="button" @click="startCreate">＋ 新建</button>
    </div>

    <form v-if="creating" class="deck-inline-form" @submit.prevent="submitCreate">
      <input v-model="newName" class="deck-input" placeholder="项目名称" maxlength="60" autofocus />
      <button class="deck-button" type="submit">创建</button>
      <button class="deck-link" type="button" @click="creating = false">取消</button>
    </form>

    <ul class="deck-list">
      <li>
        <button
          class="deck-row"
          :class="{ 'deck-row--active': store.selectedProjectId === null }"
          type="button"
          @click="store.selectProject(null)"
        >
          <span class="deck-row__name">未分类</span>
          <span class="deck-row__count">{{ store.uncategorizedCount }}</span>
        </button>
      </li>

      <li v-for="project in store.projects" :key="project.id">
        <form
          v-if="renamingId === project.id"
          class="deck-inline-form"
          @submit.prevent="submitRename"
        >
          <input v-model="renamingName" class="deck-input" maxlength="60" autofocus />
          <button class="deck-button" type="submit">保存</button>
          <button class="deck-link" type="button" @click="renamingId = null">取消</button>
        </form>

        <div v-else class="deck-row-wrap">
          <button
            class="deck-row"
            :class="{ 'deck-row--active': store.selectedProjectId === project.id }"
            type="button"
            @click="store.selectProject(project.id)"
            @dblclick="startRename(project.id, project.name)"
          >
            <span class="deck-row__name">{{ project.name }}</span>
            <span class="deck-row__count">{{ project.conversationCount }}</span>
          </button>
          <button
            class="deck-icon"
            type="button"
            title="重命名"
            @click="startRename(project.id, project.name)"
          >
            ✎
          </button>
          <button
            class="deck-icon"
            :class="{ 'deck-icon--danger': confirmingDeleteId === project.id }"
            type="button"
            :title="confirmingDeleteId === project.id ? '再次点击确认删除' : '删除项目'"
            @click="confirmDelete(project.id)"
          >
            ✕
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
