<script setup lang="ts">
// Labelled range slider with live value and a reset control (new pattern from the t861 OD design).
import { RotateCcw } from 'lucide-vue-next'
withDefaults(defineProps<{
  modelValue: number; label: string; min?: number; max?: number; step?: number; unit?: string
  reset?: number | null; leftLabel?: string; rightLabel?: string; id?: string
}>(), { min: -100, max: 100, step: 1, unit: '', reset: 0 })
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
</script>

<template>
  <div>
    <div class="flex items-center justify-between gap-2 text-sm">
      <label :for="id" class="text-zinc-300">{{ label }}</label>
      <span class="flex items-center gap-1 text-zinc-400 tabular-nums">
        {{ modelValue > 0 && min < 0 ? '+' : '' }}{{ modelValue }}{{ unit }}
        <button v-if="reset != null && modelValue !== reset" type="button" class="grid size-6 place-items-center rounded-md hover:bg-zinc-800 hover:text-zinc-200" :aria-label="`คืนค่า ${label}`" @click="emit('update:modelValue', reset)">
          <RotateCcw class="size-3.5" />
        </button>
      </span>
    </div>
    <input :id="id" type="range" :min="min" :max="max" :step="step" :value="modelValue" class="mt-1 w-full accent-emerald-600" :aria-label="label"
           @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))" />
    <div v-if="leftLabel || rightLabel" class="flex justify-between text-xs text-zinc-400"><span>{{ leftLabel }}</span><span>{{ rightLabel }}</span></div>
  </div>
</template>
