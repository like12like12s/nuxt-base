<template>
  <span data-ui="badge" :class="(theme === 'auto' ? autoVariants : variants)[variant]" class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md">
    <slot />
  </span>
</template>

<script setup lang="ts">
// theme 'dark' (default) = internal tools. theme 'auto' = light + `dark:` variants for public sites (ported from price-compare, t760).
// 'solid' = filled accent badge (emerald-700 + zinc-100, 4.99:1), same in both themes.
withDefaults(defineProps<{
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'solid'
  theme?: 'dark' | 'auto'
}>(), { variant: 'default', theme: 'dark' })

const variants = {
  default: 'bg-zinc-700 text-zinc-300',
  success: 'bg-emerald-900/50 text-emerald-400',
  warning: 'bg-amber-900/50 text-amber-400', // semantic warning = amber per UI standard (t393)
  danger: 'bg-red-900/50 text-red-400',
  info: 'bg-blue-900/50 text-blue-400',
  solid: 'bg-emerald-700 text-zinc-100',
}
const autoVariants = {
  default: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  success: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300',
  info: 'bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  solid: variants.solid,
}
</script>
