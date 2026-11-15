<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="title || name || undefined"
    :title="title || undefined"
    :name="name || undefined"
    @click="$emit('update:modelValue', !modelValue)"
    :class="modelValue ? 'bg-emerald-600' : 'bg-zinc-700'"
    class="relative inline-flex w-10 h-6 shrink-0 rounded-full transition cursor-pointer"
  >
    <!-- h-6 (24px): tap target >= 24px (RESP-001); knob translate keeps 2px gaps both ends -->
    <span
      :class="modelValue ? 'translate-x-[18px]' : 'translate-x-0.5'"
      class="absolute left-0 top-0.5 w-5 h-5 bg-white rounded-full transition-transform"
    />
  </button>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean; title?: string; name?: string }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>
