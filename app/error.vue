<template>
  <div class="min-h-screen bg-bg text-fg-2 flex items-center justify-center p-6">
    <div class="w-full max-w-md space-y-5 text-center">
      <p class="text-6xl font-semibold text-zinc-700 tabular-nums">{{ error?.statusCode ?? 500 }}</p>
      <h1 class="text-lg font-semibold text-zinc-100">{{ error?.statusCode === 404 ? 'ไม่พบหน้านี้' : 'เกิดข้อผิดพลาด' }}</h1>
      <p v-if="error?.statusMessage || error?.message" class="text-sm text-zinc-400 break-words">{{ error?.statusMessage || error?.message }}</p>
      <div class="flex justify-center gap-2">
        <Btn @click="handleError">กลับหน้าแรก</Btn>
        <Btn variant="secondary" @click="reload">โหลดใหม่</Btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
// Default error page (skill error-pattern: never a white screen). Consumers override with their own app/error.vue.
defineProps<{ error?: NuxtError }>()
const handleError = () => clearError({ redirect: '/' })
const reload = () => window.location.reload()
</script>
