<template>
  <div class="relative">
    <select
      :value="modelValue"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      class="w-full appearance-none bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:border-zinc-600 transition"
    >
      <slot />
    </select>
    <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
  </div>
</template>

<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'

defineProps<{ modelValue: string | number }>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
