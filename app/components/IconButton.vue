<script setup lang="ts">
// IconButton — icon-only action button (copy/edit/delete/close...). `label` is REQUIRED and becomes
// both the accessible name (aria-label) and the hover/focus tooltip (via Tooltip) — rule t1308:
// native title= alone is not enough, and an icon without a name is a guess.
// `to` renders NuxtLink (Nuxt only), `href` renders <a>, otherwise <button>.
const props = withDefaults(defineProps<{
  label: string
  variant?: 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  to?: string
  href?: string
  type?: 'button' | 'submit'
  disabled?: boolean
}>(), { variant: 'ghost', size: 'md', type: 'button', to: undefined, href: undefined })

const tag = computed(() => (props.to ? resolveComponent('NuxtLink') : props.href ? 'a' : 'button'))

const variants = {
  ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
  danger: 'text-red-400 hover:text-red-300 hover:bg-red-950/40',
}
const sizes = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
}
</script>

<template>
  <Tooltip :label="label">
    <component
      :is="tag"
      :to="to"
      :href="href"
      :type="!to && !href ? type : undefined"
      :disabled="!to && !href ? disabled : undefined"
      :aria-label="label"
      :title="label"
      :class="[variants[variant], sizes[size]]"
      class="inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50"
    >
      <slot />
    </component>
  </Tooltip>
</template>
