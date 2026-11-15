<template>
  <!-- overflow-x-auto: many tabs scroll sideways on phones instead of wrapping/clipping (from pilot t211) -->
  <div class="flex gap-1 border-b border-zinc-800 mb-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      :class="modelValue === tab.value ? 'text-zinc-100 border-zinc-100' : 'text-zinc-400 border-transparent hover:text-zinc-300'"
      class="shrink-0 whitespace-nowrap px-3 h-9 text-sm font-medium border-b-2 -mb-px transition-colors"
      @click="$emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  tabs: { label: string; value: string }[]
  modelValue: string
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
