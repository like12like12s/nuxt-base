<template>
  <div class="rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm" role="alert">
    <div class="flex items-start gap-3">
      <AlertTriangle class="w-5 h-5 shrink-0 text-red-400 mt-0.5" />
      <div class="min-w-0 flex-1">
        <p class="font-medium text-red-200">{{ title }}</p>
        <p v-if="message" class="mt-1 break-words text-red-300/90">{{ message }}</p>
        <div v-if="retry || $slots.default" class="mt-3 flex flex-wrap gap-2">
          <Btn v-if="retry" variant="secondary" size="sm" @click="retry">{{ nb.retry ?? 'ลองใหม่' }}</Btn>
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'
// Error state per skill error-pattern: say WHAT failed (title) + the actual message, and offer retry — never a blank page.
const props = defineProps<{ title?: string; error?: unknown; message?: string; retry?: () => void }>()
// Default words follow the app's language (app.config nuxtBase.lang, provided by the layer's labels plugin).
const nb = inject<{ loadFailed?: string; retry?: string }>('nb-labels', {})
const title = computed(() => props.title ?? nb.loadFailed ?? 'โหลดข้อมูลไม่สำเร็จ')
const message = computed(() => {
  if (props.message) return props.message
  const e = props.error as any
  if (!e) return ''
  return e?.data?.message || e?.statusMessage || e?.message || String(e)
})
</script>
