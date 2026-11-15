// `scaffold add page <name>` — a new route in the UI part. Deliberately minimal: a page that follows the layer's
// loading -> error -> empty -> content pattern. Paths are relative to the UI part.
const title = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

export default function generate({ name }) {
  const content = `<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <h1 class="text-xl font-semibold text-fg" data-test="title">${title(name)}</h1>
    <AsyncState :pending="false" :error="null" :empty="true">
      <template #empty>
        <EmptyState title="Nothing here yet" description="Replace this with the page content." />
      </template>
    </AsyncState>
  </main>
</template>

<script setup lang="ts">
useSiteHead({ title: '${title(name)}' })
</script>
`
  return { files: [{ path: `app/pages/${name}.vue`, content }], next: [`open /${name}`] }
}
