<template>
  <main class="mx-auto max-w-3xl p-6 space-y-8">
    <header>
      <h1 class="text-xl font-semibold text-fg" data-test="title">nuxt-base playground</h1>
      <p class="text-sm text-muted">Every component/pattern below comes from the layer — this app has no components of its own.</p>
    </header>

    <section class="space-y-3">
      <h2 class="text-sm font-medium text-faint uppercase tracking-wide">Tokens</h2>
      <div class="flex gap-2">
        <div class="h-8 w-8 rounded-ui bg-bg border border-line" data-test="swatch-bg" />
        <div class="h-8 w-8 rounded-ui bg-surface" />
        <div class="h-8 w-8 rounded-ui bg-surface-2" />
        <div class="h-8 w-8 rounded-ui bg-accent" data-test="swatch-accent" />
        <div class="h-8 w-8 rounded-ui bg-danger" />
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium text-faint uppercase tracking-wide">Components</h2>
      <div class="flex flex-wrap items-center gap-2">
        <Btn data-test="btn-primary" @click="toast.show('primary clicked')">Primary</Btn>
        <Btn variant="secondary">Secondary</Btn>
        <Btn variant="ghost">Ghost</Btn>
        <Btn variant="danger" size="sm">Danger</Btn>
        <Badge>badge</Badge>
        <Toggle v-model="on" />
      </div>
      <Card><p class="text-sm">Card body · toggle is {{ on ? 'on' : 'off' }}</p></Card>
      <Field label="Name"><Input v-model="name" placeholder="type here" /></Field>
      <Btn variant="secondary" size="sm" @click="modal = true">Open modal</Btn>
      <Modal v-model="modal" label="Demo"><p class="text-sm">Hello from the layer's Modal.</p></Modal>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium text-faint uppercase tracking-wide">Async patterns</h2>
      <Segmented v-model="demo" :options="[{ value: 'loading', label: 'loading' }, { value: 'error', label: 'error' }, { value: 'empty', label: 'empty' }, { value: 'data', label: 'data' }]" />
      <div data-test="async">
        <AsyncState :pending="demo === 'loading'" :error="demo === 'error' ? new Error('API 503: upstream down') : undefined" :empty="demo === 'empty'" :retry="() => (demo = 'data')">
          <template #empty><EmptyState title="ยังไม่มีรายการ" description="เริ่มด้วยการเพิ่มรายการแรก"><Btn size="sm">เพิ่มรายการ</Btn></EmptyState></template>
          <ul class="text-sm list-disc pl-5"><li>item 1</li><li>item 2</li></ul>
        </AsyncState>
      </div>
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-medium text-faint uppercase tracking-wide">Auth hook</h2>
      <p class="text-sm text-muted" data-test="auth">enabled={{ auth.enabled }} ready={{ auth.ready }} user={{ auth.user?.name ?? 'anonymous' }}</p>
      <NuxtLink to="/does-not-exist" class="text-sm text-accent underline">404 page</NuxtLink>
    </section>
  </main>
</template>

<script setup lang="ts">
const toast = useToast()
const auth = useAuth()
const on = ref(true)
const name = ref('')
const modal = ref(false)
const demo = ref<'loading' | 'error' | 'empty' | 'data'>('data')
</script>
