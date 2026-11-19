<script setup lang="ts">
// Tooltip — visible label for icon-only controls: shows on hover AND keyboard focus
// (group-focus-within), unlike native title= which covers neither touch nor focus.
// The trigger should carry the same text as aria-label (IconButton wires both).
// Rule t1308: every icon-only button/link needs a tooltip + aria-label.
//
// Positioning: clamped to the viewport and flipped below the trigger when there is no room
// above (a centred bubble next to the right edge ran off-screen at 390px, t1307 follow-up) —
// computed on mount, not only on hover, so the resting box lens audits is the clamped one.
// Hides itself while the trigger's own menu is open (aria-expanded="true" on the trigger,
// e.g. a dropdown button) so the bubble never sits on top of the open menu.
const props = withDefaults(defineProps<{ label: string; side?: 'top' | 'bottom' }>(), { side: 'top' })

const root = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const left = ref<number | null>(null)
const flipped = ref(false)
const menuOpen = ref(false)
let observer: MutationObserver | null = null

function position() {
  const r = root.value?.getBoundingClientRect()
  const t = tip.value
  if (!r || !t) return
  const w = t.offsetWidth
  const vw = window.innerWidth
  const vh = window.innerHeight
  const h = t.offsetHeight
  const center = r.left + r.width / 2
  left.value = Math.min(Math.max(center - w / 2, 8), Math.max(8, vw - 8 - w)) - r.left
  flipped.value = props.side === 'top' ? r.top - h - 8 < 0 : r.bottom + h + 8 > vh
}

function onEnter() { menuOpen.value = triggerExpanded(); position() }
function triggerExpanded(): boolean {
  const trigger = root.value?.firstElementChild
  return !!trigger && trigger.getAttribute('aria-expanded') === 'true'
}

onMounted(async () => {
  await nextTick()
  position()
  // aria-expanded flips without events near the tooltip — watch for it
  const trigger = root.value?.firstElementChild
  if (trigger) {
    observer = new MutationObserver(() => { menuOpen.value = triggerExpanded() })
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })
  }
  window.addEventListener('resize', position)
  document.addEventListener('scroll', position, true)
})
onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', position)
  document.removeEventListener('scroll', position, true)
})
</script>

<template>
  <span ref="root" class="relative inline-flex group/tt" @mouseenter="onEnter" @focusin="onEnter">
    <slot />
    <span
      ref="tip"
      role="tooltip"
      class="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-900 shadow-lg transition-opacity duration-100 motion-reduce:transition-none"
      :class="[
        (flipped ? side === 'top' : side === 'bottom') ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        menuOpen ? '!opacity-0' : 'opacity-0 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100',
      ]"
      :style="left != null ? { left: `${left}px` } : undefined"
    >
      {{ label }}
    </span>
  </span>
</template>
