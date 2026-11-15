<script setup lang="ts">
// Avatar with initials fallback — self-contained (no radix/reka).
// The fallback span MUST fill + center inside the rounded root: a bare span
// anchors top-left and gets clipped by overflow-hidden (bug found the first
// time this shipped, 2026-09-08).
// Origin: PrintQ users list identity cell (2026-09-08).
withDefaults(
  defineProps<{
    name?: string
    size?: 'sm' | 'base' | 'lg'
    shape?: 'circle' | 'square'
    src?: string
  }>(),
  { size: 'sm', shape: 'circle' },
)

const SIZES = { sm: 'h-8 w-8 text-xs', base: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-base' } as const
const SHAPES = { circle: 'rounded-full', square: 'rounded-md' } as const

function initials(name?: string) {
  const words = (name ?? '').trim().split(/\s+/).filter((w) => !w.startsWith('('))
  const chars = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '')
  return (chars.join('') || '?').toUpperCase()
}
</script>

<template>
  <span
    class="relative flex shrink-0 items-center justify-center overflow-hidden bg-zinc-800 font-medium text-zinc-300"
    :class="[SIZES[size], SHAPES[shape]]"
  >
    <img v-if="src" :src="src" :alt="name ?? ''" class="h-full w-full object-cover" />
    <span v-else>{{ initials(name) }}</span>
  </span>
</template>
