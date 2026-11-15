<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <header>
      <h1 class="text-xl font-semibold text-fg" data-test="title">{{ site.name }}</h1>
      <p class="text-sm text-muted">{{ site.description }}</p>
    </header>
    <Card>
      <p class="text-sm text-fg-2">Components, tokens and patterns come from the nuxt-base layer. Replace this page.</p>
      <div class="mt-4">
        <Btn data-test="hello" @click="toast.show('It works')">Say hello</Btn>
      </div>
    </Card>
  </main>
</template>

<script setup lang="ts">
const site = useAppConfig().nuxtBase.site
const toast = useToast()
</script>
