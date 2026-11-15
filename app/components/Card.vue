<template>
  <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
    <!-- header-right slot (ported back from drill, t1086): title left, actions right. Without the slot the markup is unchanged. -->
    <div v-if="$slots['header-right']" class="mb-3 flex items-center gap-3">
      <div class="text-xs font-medium text-zinc-400 uppercase tracking-wide">{{ title }}</div>
      <div class="ml-auto"><slot name="header-right" /></div>
    </div>
    <div v-else-if="title" class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-3">{{ title }}</div>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>()
</script>
