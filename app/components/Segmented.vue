<script setup lang="ts">
// Segmented control (radio group) — mobile editor tabs and small binary choices (new pattern from the t861 OD design).
defineProps<{ options: { value: string; label: string; disabled?: boolean }[]; modelValue: string; label?: string; grow?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="inline-flex max-w-full rounded-lg border border-zinc-700 bg-zinc-900 p-0.5" :class="grow && 'flex w-full'">
    <button
      v-for="o in options" :key="o.value" type="button" role="radio" :aria-checked="modelValue === o.value" :disabled="o.disabled"
      class="min-h-9 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50 sm:min-h-8"
      :class="[modelValue === o.value ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200', grow && 'flex-1']"
      @click="emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>
