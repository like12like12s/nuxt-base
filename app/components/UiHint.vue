<script setup lang="ts">
// UiHint — "!" icon opening a small popup bubble (the CMS items-editor tooltip
// look, without its radix dependency): click to toggle, click-outside/Esc to
// close. The bubble is clamped to the viewport (arrow re-aimed at the icon)
// so a field near the left edge — settings' Database — can't fall off-screen.
defineProps<{ message: string }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const bubble = ref<HTMLElement | null>(null)
const bubbleLeft = ref<number | null>(null)
const arrowLeft = ref<number | null>(null)

// Position after render: centre the bubble on the icon, clamp to the viewport
// (8px margin), then aim the arrow back at wherever the icon actually ended up.
function position() {
  const r = root.value?.getBoundingClientRect()
  const b = bubble.value
  if (!r || !b) return
  const w = b.offsetWidth
  const vw = window.innerWidth
  const iconCenter = r.left + r.width / 2
  const left = Math.min(Math.max(iconCenter - w / 2, 8), Math.max(8, vw - 8 - w))
  bubbleLeft.value = left - r.left
  arrowLeft.value = Math.min(Math.max(iconCenter - left, 10), w - 10)
}
async function toggle() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    position()
  }
}
function onDoc(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
function onReposition() {
  if (open.value) position()
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onReposition)
  // capture: reposition on any ancestor's scroll, not just the window's
  document.addEventListener('scroll', onReposition, true)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onReposition)
  document.removeEventListener('scroll', onReposition, true)
})
</script>

<template>
  <span ref="root" class="relative inline-flex">
    <button
      type="button"
      class="text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      :aria-expanded="open"
      aria-label="info"
      @click="toggle"
    >
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </button>
    <transition name="hint">
      <span
        v-if="open"
        ref="bubble"
        role="tooltip"
        class="absolute bottom-full mb-2 z-40 w-56 max-w-[70vw] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-[11px] leading-snug text-zinc-100 dark:text-zinc-900 shadow-lg text-left whitespace-normal"
        :style="bubbleLeft != null ? { left: `${bubbleLeft}px` } : undefined"
      >
        {{ message }}
        <span
          class="absolute top-full -mt-1 -translate-x-1/2 border-4 border-transparent border-t-zinc-900 dark:border-t-zinc-100"
          :style="arrowLeft != null ? { left: `${arrowLeft}px` } : undefined"
        />
      </span>
    </transition>
  </span>
</template>

<style scoped>
.hint-enter-active, .hint-leave-active { transition: opacity 0.12s ease; }
.hint-enter-from, .hint-leave-to { opacity: 0; }
</style>
