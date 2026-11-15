<script lang="ts" setup>
import { useSidebarStore } from '../stores/sidebar';

const store = useSidebarStore();

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  store.scheduleSearch(target.value);
}

function openConversation(convId: string): void {
  void store.openConversation(convId);
}
</script>

<template>
  <section class="deck-section deck-section--search">
    <div class="deck-section__head">
      <h2 class="deck-section__title">检索</h2>
      <span v-if="store.searching" class="deck-section__count">搜索中…</span>
    </div>

    <input
      class="deck-input deck-input--search"
      type="search"
      placeholder="搜索标题、正文、思维链"
      :value="store.query"
      @input="onInput"
    />

    <p v-if="store.searchHint" class="deck-hint" data-testid="search-hint">
      {{ store.searchHint }}
    </p>
    <p v-else-if="!store.fullTextEnabled" class="deck-hint" data-testid="search-hint">
      全文检索已关闭，当前仅搜索标题
    </p>

    <p
      v-if="store.query.trim() !== '' && store.results.length === 0 && !store.searching"
      class="deck-empty"
    >
      没有匹配结果
    </p>

    <ul class="deck-list deck-list--scroll">
      <li v-for="hit in store.results" :key="`${hit.convId}:${hit.messageId ?? ''}`">
        <button class="deck-hit" type="button" @click="openConversation(hit.convId)">
          <span class="deck-hit__title">{{ hit.title }}</span>
          <span class="deck-hit__snippet">{{ hit.snippet }}</span>
          <span class="deck-hit__action">打开会话</span>
        </button>
      </li>
    </ul>
  </section>
</template>
