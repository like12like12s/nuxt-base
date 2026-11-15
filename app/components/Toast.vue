<template>
  <Teleport to="body">
    <Transition
      enter-from-class="opacity-0 translate-y-2"
      enter-active-class="transition duration-200"
      leave-to-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-200"
    >
      <div v-if="message" class="fixed bottom-24 left-4 right-4 sm:bottom-4 sm:left-auto sm:right-4 sm:w-auto z-50 bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm px-4 py-2.5 rounded-lg shadow-lg">
        {{ message }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{ message: string }>()
</script>
