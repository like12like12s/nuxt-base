<template>
  <div class="min-h-screen">
    <NuxtPage />
    <Toast :message="toast.message" />
  </div>
</template>

<script setup lang="ts">
useSiteHead()
const toast = useToast()
</script>
