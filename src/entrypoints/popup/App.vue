<script lang="ts" setup>
// M0 脚手架占位：只展示扩展状态，P0 的功能界面在页面侧边栏（content script）。
const version = browser.runtime.getManifest().version;
</script>

<template>
  <main class="w-80 p-4 font-sans text-sm text-neutral-800">
    <h1 class="m-0 text-base font-semibold">DeepSeek Thread Deck</h1>
    <p class="mt-1 text-neutral-500">v{{ version }} · P0 只读模式</p>
    <p class="mt-3 leading-relaxed text-neutral-600">
      打开
      <a class="text-blue-600 underline" href="https://chat.deepseek.com" target="_blank">
        chat.deepseek.com
      </a>
      ，侧边栏项目树与检索面板将显示在页面右侧。
    </p>
  </main>
</template>
