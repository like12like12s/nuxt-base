<template>
  <LoadingState v-if="pending && !hasData" :rows="rows" />
  <ErrorState v-else-if="error" :error="error" :retry="retry" />
  <slot v-else-if="empty" name="empty"><EmptyState :title="emptyTitle ?? nb.empty ?? 'ยังไม่มีข้อมูล'" :description="emptyDescription" /></slot>
  <slot v-else />
</template>

<script setup lang="ts">
// One wrapper for the loading → error → empty → content order, with the optimistic guard:
// empty is only shown once pending is false, and a refetch (pending with data already there) keeps the content visible.
//   <AsyncState :pending="status === 'pending'" :error="error" :empty="!data?.length" :retry="refresh">…</AsyncState>
withDefaults(defineProps<{
  pending?: boolean
  error?: unknown
  empty?: boolean
  /** true while a refetch runs over existing data — keeps content instead of a skeleton */
  hasData?: boolean
  retry?: () => void
  rows?: number
  emptyTitle?: string
  emptyDescription?: string
}>(), { pending: false, empty: false, hasData: false, rows: 3, emptyTitle: undefined, emptyDescription: '' })
// Default words follow the app's language (app.config nuxtBase.lang, provided by the layer's labels plugin).
const nb = inject<{ empty?: string }>('nb-labels', {})
</script>
