<script setup lang="ts">
// One row in <Dropdown>: 40px tall (touch), optional danger tone, divider above via `separated`.
withDefaults(defineProps<{ danger?: boolean; disabled?: boolean; separated?: boolean }>(), {})
defineEmits<{ click: [e: MouseEvent] }>()
</script>

<template>
  <div v-if="separated" class="my-1 border-t border-zinc-700/70" />
  <button
    type="button"
    role="menuitem"
    :disabled="disabled"
    class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:py-2"
    :class="danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-200 hover:bg-zinc-700/60'"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>
