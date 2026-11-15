import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '../../app/pages/index.vue'

describe('index page', () => {
  it('renders the site name from app.config', async () => {
    const page = await mountSuspended(IndexPage)
    expect(page.find('[data-test="title"]').text()).toBe({{kit.titleJson}})
  })
})
