<script setup lang="ts">
// Dialog shell — shared template (zinc palette since t393). 2026-10-16 t220: Esc closes, scrolls when tall, aria, `wide` like components-react/modal.tsx.
const props = withDefaults(defineProps<{ modelValue: boolean; wide?: boolean; label?: string }>(), { wide: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function close() { emit('update:modelValue', false) }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && props.modelValue) close() }
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/60" @click="close" />
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        class="relative bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full mx-4 max-h-[85vh] overflow-y-auto shadow-xl"
        :class="wide ? 'max-w-2xl' : 'max-w-md'"
      >
        <slot :close="close" />
      </div>
    </div>
  </Teleport>
</template>
