<template>
  <div class="flex flex-col items-center justify-center text-center py-12 px-6">
    <div v-if="$slots.icon" class="mb-4 text-zinc-500 [&>svg]:w-10 [&>svg]:h-10"><slot name="icon" /></div>
    <h2 class="text-base font-semibold text-zinc-100">{{ title }}</h2>
    <p v-if="description" class="mt-1 max-w-md text-sm leading-6 text-zinc-400">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5 flex flex-wrap items-center justify-center gap-2"><slot /></div>
    <p v-if="hint" class="mt-4 text-xs text-zinc-500">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
// Empty state per skill empty-state-ux: says what the app does + what to do first + a primary CTA in the default slot.
defineProps<{ title: string; description?: string; hint?: string }>()
</script>
