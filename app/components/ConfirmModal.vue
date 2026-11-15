<script setup lang="ts">
// Confirm dialog — replaces native confirm() (rule: no alert/confirm/prompt). Shared template, uses Modal + Btn. 2026-10-16 t220.
// <ConfirmModal v-model="askDelete" title="ลบไฟล์?" message="ลิงก์ในเนื้อหาจะเสีย" confirm-label="ลบ" danger @confirm="doDelete" />
withDefaults(defineProps<{
  modelValue: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
}>(), { confirmLabel: 'ยืนยัน', cancelLabel: 'ยกเลิก', danger: false, busy: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>()
</script>

<template>
  <Modal :model-value="modelValue" :label="title" @update:model-value="emit('update:modelValue', $event)">
    <h2 class="text-base font-semibold text-zinc-100">{{ title }}</h2>
    <p v-if="message" class="mt-2 text-sm text-zinc-400">{{ message }}</p>
    <slot />
    <div class="mt-6 flex justify-end gap-2">
      <Btn variant="secondary" :disabled="busy" @click="emit('update:modelValue', false)">{{ cancelLabel }}</Btn>
      <Btn :variant="danger ? 'danger' : 'primary'" :disabled="busy" @click="emit('confirm')">{{ confirmLabel }}</Btn>
    </div>
  </Modal>
</template>
