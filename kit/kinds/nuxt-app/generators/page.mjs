// `scaffold add page <path>` — a new route in the UI part: a page that follows the layer's
// loading -> error -> empty -> content pattern (AsyncState) and an e2e spec that opens it and fails on any JS error.
//   reports            app/pages/reports.vue                  /reports
//   reports/monthly    app/pages/reports/monthly.vue          /reports/monthly
//   reports/[id]       app/pages/reports/[id].vue             /reports/:id   (the page reads route.params.id)
// Nuxt turns `x.vue` next to a directory `x/` into a PARENT route: the pages below it would only render inside a
// <NuxtPage> of x.vue. So a page under an existing flat page is refused (with the one `git mv` that fixes it), and a
// page named like an existing directory is written as its index.vue. Paths are relative to the UI part.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { usageError } from '../../../lib/errors.mjs'
import { langOf, text } from '../../../lib/i18n.mjs'

const title = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
const param = (segment) => /^\[([a-z][A-Za-z0-9]*)\]$/.exec(segment)?.[1]
const isDir = (path) => existsSync(path) && statSync(path).isDirectory()

export default function generate({ name, dir, manifest }) {
  const auth = manifest.modules.includes('auth')
  const t = text(langOf(manifest)) // the project's one UI language
  const segments = name.split('/')
  const pages = join(dir, 'app/pages')

  // A flat page above the new one would swallow it (see the header).
  for (let i = 1; i < segments.length; i++) {
    const parent = segments.slice(0, i).join('/')
    if (existsSync(join(pages, `${parent}.vue`))) {
      throw usageError(
        `add page ${name}: app/pages/${parent}.vue exists — with a page below it Nuxt would treat it as a parent layout and /${segments.join('/')} would not render. Move it first (in the UI directory): git mv app/pages/${parent}.vue app/pages/${parent}/index.vue`,
        'flat_parent',
      )
    }
  }
  // `add page reports` when app/pages/reports/ already holds pages: the list page of that directory.
  const file = isDir(join(pages, name)) ? `app/pages/${name}/index.vue` : `app/pages/${name}.vue`

  const statics = segments.filter((s) => !param(s))
  const params = segments.map(param).filter(Boolean)
  const heading = statics.map(title).join(' / ')
  const url = `/${segments.map((s) => (param(s) ? `sample-${param(s)}` : s)).join('/')}`
  const slug = segments.map((s) => param(s) ?? s).join('-')
  const paramLines = params.length
    ? `\n// The dynamic part${params.length > 1 ? 's' : ''} of the URL (/${segments.map((s) => (param(s) ? `:${param(s)}` : s)).join('/')}).\nconst route = useRoute()\n${params.map((p) => `const ${p} = String(route.params.${p})`).join('\n')}\n`
    : ''
  const paramMarkup = params.length ? `\n    <p class="text-sm text-muted" data-test="params">${params.map((p) => `{{ ${p} }}`).join(' / ')}</p>` : ''

  const page = `<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <h1 class="text-xl font-semibold text-fg" data-test="title">${heading}</h1>${paramMarkup}
    <AsyncState :pending="pending" :error="error" :empty="!rows.length" :retry="load">
      <template #empty>
        <EmptyState title="${t.emptyTitle}" description="${t.emptyPage}" />
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
useSiteHead({ title: '${heading}' })
${paramLines}
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
${auth ? "  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { data: { subject: 'e2e', name: 'E2E User', email: null, roles: [], kind: 'user' } } }))\n" : ''}  await page.goto('${url}')
  await expect(page.getByTestId('title')).toHaveText('${heading}')
  await expect(page).toHaveTitle(/${heading.replaceAll('/', '\\/')}/)
${params.length ? `  await expect(page.getByTestId('params')).toHaveText('${params.map((p) => `sample-${p}`).join(' / ')}') // the page got the URL's dynamic part${params.length > 1 ? 's' : ''}\n` : ''}  // nothing to show yet: the empty state, not a blank page
  await expect(page.getByText('${t.emptyTitle}')).toBeVisible()
  expect(errors).toEqual([])
})
`
  return {
    files: [
      { path: file, content: page },
      { path: `tests/e2e/${slug}.spec.ts`, content: e2e },
    ],
    // The tier map entry for the gate's tiers-check: the page pulls its own spec. A dynamic segment is written as
    // `*` — as a glob, `[id]` would be a character class, not the literal file name (GATE.md tiers).
    tiers: [{ key: file.replace(/\[[a-zA-Z][A-Za-z0-9]*\]/g, '*'), specs: [`tests/e2e/${slug}.spec.ts`] }],
    next: [`fill in ${file} (data, states) and extend tests/e2e/${slug}.spec.ts`, 'npm run gate', 'npm run test:e2e   # in the UI directory'],
  }
}
