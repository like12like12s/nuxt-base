<template>
  <component
    :is="tag"
    :to="to"
    :href="href"
    :type="!to && !href ? type : undefined"
    :disabled="!to && !href ? disabled : undefined"
    :class="[(theme === 'auto' ? autoVariants : variants)[variant], sizes[size], theme === 'auto' ? 'focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950' : 'focus-visible:ring-offset-zinc-950']"
    class="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
// theme 'dark' (default) = internal tools, always dark. theme 'auto' = light + `dark:` variants for public sites (ported from price-compare, t760).
// `to` renders NuxtLink (Nuxt only), `href` renders <a>, otherwise <button>.
const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  theme?: 'dark' | 'auto'
  to?: string
  href?: string
  type?: 'button' | 'submit'
  disabled?: boolean
}>(), { variant: 'primary', size: 'md', theme: 'dark', type: 'button', to: undefined, href: undefined })

const tag = computed(() => (props.to ? resolveComponent('NuxtLink') : props.href ? 'a' : 'button'))

const variants = {
  primary: 'bg-emerald-700 hover:bg-emerald-800 text-zinc-100', // emerald-700/zinc-100 = 4.99:1 AA (t393); white on emerald-600 was 3.77
  secondary: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200',
  ghost: 'hover:bg-zinc-800 text-zinc-400',
  danger: 'bg-red-700 hover:bg-red-800 text-zinc-100', // red-700/zinc-100 = 5.89:1 + no pure white on dark (t393)
}
const autoVariants = {
  primary: variants.primary,
  secondary: 'border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
  danger: variants.danger,
}
const sizes = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
}
</script>
