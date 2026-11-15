// `scaffold add page <name>` — a new route in the UI part: a page that follows the layer's
// loading -> error -> empty -> content pattern (AsyncState) and an e2e spec that opens it and fails on any JS error.
// Paths are relative to the UI part.
const title = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

export default function generate({ name, manifest }) {
  const auth = manifest.modules.includes('auth')
  const page = `<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <h1 class="text-xl font-semibold text-fg" data-test="title">${title(name)}</h1>
    <AsyncState :pending="pending" :error="error" :empty="!rows.length" :retry="load">
      <template #empty>
        <EmptyState title="Nothing here yet" description="Replace this with the page content." />
      </template>
      <Card>
        <ul class="divide-y divide-line">
          <li v-for="row in rows" :key="row" class="py-2 text-sm text-fg">{{ row }}</li>
        </ul>
      </Card>
    </AsyncState>
  </main>
</template>

<script setup lang="ts">
useSiteHead({ title: '${title(name)}' })

// The AsyncState pattern: pending while loading, error with a retry, empty when there is nothing, else the content.
const rows = ref<string[]>([])
const pending = ref(true)
const error = ref<string | null>(null)

async function load() {
  pending.value = true
  error.value = null
  try {
    // TODO: load the page's data (in a fullstack project: \`const { data, error } = await useApi().GET(...)\`)
    rows.value = []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pending.value = false
  }
}

onMounted(load)
</script>
`
  const e2e = `import { expect, test } from '@playwright/test'

test('${name}: renders with no JS error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(\`pageerror: \${e.message}\`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(\`console: \${m.text()}\`) })
${auth ? "  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { data: { subject: 'e2e', name: 'E2E User', email: null, roles: [], kind: 'user' } } }))\n" : ''}  await page.goto('/${name}')
  await expect(page.getByTestId('title')).toHaveText('${title(name)}')
  await expect(page).toHaveTitle(/${title(name)}/)
  // nothing to show yet: the empty state, not a blank page
  await expect(page.getByText('Nothing here yet')).toBeVisible()
  expect(errors).toEqual([])
})
`
  return {
    files: [
      { path: `app/pages/${name}.vue`, content: page },
      { path: `tests/e2e/${name}.spec.ts`, content: e2e },
    ],
    next: [`fill in app/pages/${name}.vue (data, states) and extend tests/e2e/${name}.spec.ts`, 'npm run gate', 'npm run test:e2e   # in the UI directory'],
  }
}
