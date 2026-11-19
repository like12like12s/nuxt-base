<script setup lang="ts">
// Tooltip — visible label for icon-only controls: shows on hover AND keyboard focus
// (group-focus-within), unlike native title= which covers neither touch nor focus.
// The trigger should carry the same text as aria-label (IconButton wires both).
// Rule t1308: every icon-only button/link needs a tooltip + aria-label.
withDefaults(defineProps<{ label: string; side?: 'top' | 'bottom' }>(), { side: 'top' })
</script>

<template>
  <span class="relative inline-flex group/tt">
    <slot />
    <span
      role="tooltip"
      class="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-900 shadow-lg opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/tt:opacity-100 group-focus-within/tt:opacity-100"
      :class="side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'"
    >
      {{ label }}
    </span>
  </span>
</template>
