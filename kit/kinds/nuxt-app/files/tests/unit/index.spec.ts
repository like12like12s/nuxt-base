import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '../../app/pages/index.vue'

describe('index page', () => {
  it('renders the site name from app.config', async () => {
    const page = await mountSuspended(IndexPage)
    expect(page.find('[data-test="title"]').text()).toBe({{kit.titleJson}})
  })

  // One language per project: the page and the layer's labels (app.config `lang`) agree.
  it('the page and the layer speak the project language', async () => {
    const page = await mountSuspended(IndexPage)
    // @kit:if lang:en
    expect(useAppConfig().nuxtBase.lang).toBe('en')
    expect(page.find('[data-test="hello"]').text()).toBe('Say hello')
    expect(page.text()).not.toMatch(/[\u0E00-\u0E7F]/)
    // @kit:else
    expect((useAppConfig().nuxtBase as { lang?: string }).lang ?? 'th').toBe('th')
    expect(page.find('[data-test="hello"]').text()).toBe('ทักทาย')
    // @kit:end
  })
})
