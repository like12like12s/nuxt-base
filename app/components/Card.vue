<template>
  <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
    <div v-if="title" class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-3">{{ title }}</div>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>()
</script>
