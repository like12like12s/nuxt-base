<script setup lang="ts">
// Overflow / action menu — shared template (zinc palette since t393). 2026-10-16 from pilot t219: Esc closes, align prop, aria, 36px trigger, slot close().
// Items go in the default slot; call `close()` from the slot after an action. Esc and outside-tap close it.
withDefaults(defineProps<{ align?: 'left' | 'right'; label?: string }>(), { align: 'right', label: 'More actions' })

const open = ref(false)
const el = ref<HTMLElement>()

function onClickOutside(e: Event) {
  if (el.value && !el.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false }
onMounted(() => { document.addEventListener('click', onClickOutside); document.addEventListener('keydown', onKey) })
onUnmounted(() => { document.removeEventListener('click', onClickOutside); document.removeEventListener('keydown', onKey) })
</script>

<template>
  <div ref="el" class="relative">
    <button
      type="button"
      :aria-label="label"
      :aria-expanded="open"
      :title="label"
      class="inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg px-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      :class="open && 'bg-zinc-800 text-zinc-100'"
      @click.stop="open = !open"
    >
      <slot name="trigger">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </slot>
    </button>
    <Transition
      enter-from-class="opacity-0 scale-95"
      enter-active-class="transition duration-100"
      leave-to-class="opacity-0 scale-95"
      leave-active-class="transition duration-100"
    >
      <div
        v-if="open"
        role="menu"
        class="absolute top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
        :class="align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'"
      >
        <slot :close="() => (open = false)" />
      </div>
    </Transition>
  </div>
</template>
