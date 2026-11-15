<template>
  <!-- the label wraps the control so screen readers tie them together (port from modelforge, t192) -->
  <label class="block">
    <span v-if="label" class="text-sm text-zinc-300 block mb-1">{{ label }}</span>
    <p v-if="desc" class="text-xs text-zinc-400 mb-2">{{ desc }}</p>
    <slot />
  </label>
</template>

<script setup lang="ts">
defineProps<{ label?: string; desc?: string }>()
</script>
