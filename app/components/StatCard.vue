<template>
  <div class="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 min-w-0">
    <div class="flex items-center gap-2 text-zinc-400">
      <component :is="icon" v-if="icon" class="w-3.5 h-3.5 shrink-0" />
      <span class="text-xs font-medium uppercase tracking-wider truncate">{{ label }}</span>
    </div>
    <div class="mt-2 flex items-center gap-2 min-w-0">
      <slot />
    </div>
    <div v-if="sub" class="mt-1.5 text-xs text-zinc-400 font-mono truncate">{{ sub }}</div>
  </div>
</template>

<script setup>
defineProps({ icon: [Object, Function], label: String, sub: String });
</script>
