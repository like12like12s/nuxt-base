<template>
  <input
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 h-9 text-sm text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-zinc-600 transition disabled:opacity-50"
  />
</template>

<script setup lang="ts">
defineProps<{
  modelValue: string | number
  type?: 'text' | 'number' | 'search' | 'email' | 'password'
  placeholder?: string
  disabled?: boolean
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
