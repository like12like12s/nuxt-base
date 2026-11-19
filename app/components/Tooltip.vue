<script setup lang="ts">
// Tooltip — visible label for icon-only controls: shows on hover AND keyboard focus
// (group-focus-within), unlike native title= which covers neither touch nor focus.
// The trigger should carry the same text as aria-label (IconButton wires both).
// Rule t1308: every icon-only button/link needs a tooltip + aria-label.
//
// Positioning: clamped to the viewport and flipped below the trigger when there is no room
// above (a centred bubble next to the right edge ran off-screen at 390px, t1307 follow-up) —
// computed on mount, not only on hover, so the resting box lens audits is the clamped one.
// The vertical axis is clamped too: a trigger sitting at/below the fold (long lists) would
// otherwise leave its resting bubble hanging past the bottom edge (t1329, intzone manage rows).
// Hides itself while the trigger's own menu is open (aria-expanded="true" on the trigger,
// e.g. a dropdown button) so the bubble never sits on top of the open menu.
const props = withDefaults(defineProps<{ label: string; side?: 'top' | 'bottom' }>(), { side: 'top' })

const root = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const left = ref<number | null>(null)
const top = ref<number | null>(null)   // set only while the CSS side position would leave the viewport
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
  // side classes put the bubble h+6 from the trigger; when that spot is outside the viewport
  // (trigger below the fold), clamp the bubble in — detached until a scroll/resize repositions.
  const above = props.side === 'top' ? !flipped.value : flipped.value
  const want = above ? r.top - h - 6 : r.bottom + 6
  const maxY = Math.max(8, vh - 8 - h)
  top.value = want < 8 || want > maxY ? Math.min(Math.max(want, 8), maxY) - r.top : null
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
      class="pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-900 shadow-lg transition-opacity duration-100 motion-reduce:transition-none"
      :class="[
        // centred by CSS until measured; once `left` is set it is the bubble's final offset from the
        // trigger — keeping -translate-x-1/2 on top shifted every clamped bubble left by half its width (t1322)
        left == null ? 'left-1/2 -translate-x-1/2' : '',
        // same for the vertical axis: the side class owns placement until the spot is off-screen,
        // then the clamped inline top takes over (the class insets would fight it, t1329)
        top == null ? ((flipped ? side === 'top' : side === 'bottom') ? 'top-full mt-1.5' : 'bottom-full mb-1.5') : '',
        menuOpen ? '!opacity-0' : 'opacity-0 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100',
      ]"
      :style="left != null || top != null ? { left: left != null ? `${left}px` : undefined, top: top != null ? `${top}px` : undefined } : undefined"
    >
      {{ label }}
    </span>
  </span>
</template>
