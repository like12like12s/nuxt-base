<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <header>
      <h1 class="text-xl font-semibold text-fg" data-test="title">{{ site.name }}</h1>
      <p class="text-sm text-muted">{{ site.description }}</p>
    </header>
    <Card>
      <!-- @kit:if lang:en -->
      <p class="text-sm text-fg-2">Components, tokens and patterns come from the nuxt-base layer. Replace this page.</p>
      <div class="mt-4">
        <Btn data-test="hello" @click="toast.show('It works')">Say hello</Btn>
      </div>
      <!-- @kit:else -->
      <p class="text-sm text-fg-2">Component, token และ pattern มาจาก nuxt-base layer — แทนที่หน้านี้ด้วยหน้าของแอป</p>
      <div class="mt-4">
        <Btn data-test="hello" @click="toast.show('ใช้งานได้')">ทักทาย</Btn>
      </div>
      <!-- @kit:end -->
    </Card>
  </main>
</template>

<script setup lang="ts">
const site = useAppConfig().nuxtBase.site
const toast = useToast()
</script>
