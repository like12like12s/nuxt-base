<template>
  <!-- "How to read" affordance for pages whose tables encode meaning in
       color/shape (badges, dots, pills): a small header button opening a
       popover whose rows demonstrate with the page's real cell styles
       instead of describing them in prose. Body = one <li> per row.
       Origin: PrintQ roles permission strip (2026-09-08). -->
  <div class="relative inline-block">
    <button
      type="button"
      class="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
      @click="open = !open"
    >
      <HelpCircle class="size-4" />
      {{ label }}
    </button>
    <div
      v-if="open"
      class="absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-xl"
    >
      <p class="mb-3 text-sm font-medium text-zinc-100">{{ title }}</p>
      <ul class="space-y-2.5 text-xs text-zinc-400">
        <slot />
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { HelpCircle } from 'lucide-vue-next'

withDefaults(defineProps<{ title: string; label?: string }>(), {
  label: 'How to read',
})
const open = ref(false)

// Click-away close (the panel itself stops propagation).
onMounted(() => {
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('div.relative.inline-block'))
      open.value = false
  })
})
</script>
