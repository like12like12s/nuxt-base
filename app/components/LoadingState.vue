<template>
  <div class="animate-pulse space-y-3 motion-reduce:animate-none" role="status" :aria-label="text">
    <div v-for="i in rows" :key="i" class="h-4 rounded bg-zinc-800" :class="i === rows && rows > 1 ? 'w-2/3' : 'w-full'" />
    <span class="sr-only">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
// Neutral loading placeholder — never flash an empty/error state while pending (skill optimistic-initial-state).
// The label follows the app's language (app.config nuxtBase.lang) unless the prop says otherwise.
const props = withDefaults(defineProps<{ rows?: number; label?: string }>(), { rows: 3, label: undefined })
const nb = inject<{ loading?: string }>('nb-labels', {})
const text = computed(() => props.label ?? nb.loading ?? 'กำลังโหลด…')
</script>
