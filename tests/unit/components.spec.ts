import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import Btn from '../../app/components/Btn.vue'
import AsyncState from '../../app/components/AsyncState.vue'
import ErrorState from '../../app/components/ErrorState.vue'
import EmptyState from '../../app/components/EmptyState.vue'
import LoadingState from '../../app/components/LoadingState.vue'
import ConfirmModal from '../../app/components/ConfirmModal.vue'
import { NB_LABELS, NB_LABELS_KEY, resolveLabels } from '../../app/composables/useLabels'

describe('Btn', () => {
  it('renders a button with the primary variant by default', async () => {
    const w = await mountSuspended(Btn, { slots: { default: () => 'Go' } })
    const el = w.find('button')
    expect(el.exists()).toBe(true)
    expect(el.attributes('type')).toBe('button')
    expect(el.classes()).toContain('bg-emerald-700')
    expect(el.text()).toBe('Go')
  })
  it('renders <a> for href and disables when asked', async () => {
    const a = await mountSuspended(Btn, { props: { href: 'https://x' }, slots: { default: () => 'x' } })
    expect(a.find('a').attributes('href')).toBe('https://x')
    const d = await mountSuspended(Btn, { props: { disabled: true, variant: 'danger' }, slots: { default: () => 'x' } })
    expect(d.find('button').attributes('disabled')).toBeDefined()
    expect(d.find('button').classes()).toContain('bg-red-700')
  })
})

describe('AsyncState order (loading → error → empty → content)', () => {
  it('shows the skeleton, never the empty state, while pending', async () => {
    const w = await mountSuspended(AsyncState, { props: { pending: true, empty: true }, slots: { default: () => 'content' } })
    expect(w.find('[role="status"]').exists()).toBe(true)
    expect(w.text()).not.toContain('ยังไม่มีข้อมูล')
    expect(w.text()).not.toContain('content')
  })
  it('keeps content during a refetch when data already exists', async () => {
    const w = await mountSuspended(AsyncState, { props: { pending: true, hasData: true }, slots: { default: () => 'content' } })
    expect(w.text()).toContain('content')
    expect(w.find('[role="status"]').exists()).toBe(false)
  })
  it('error wins over empty and surfaces the real message with retry', async () => {
    let retried = 0
    const w = await mountSuspended(AsyncState, {
      props: { error: new Error('API 503: upstream down'), empty: true, retry: () => { retried++ } },
      slots: { default: () => 'content' },
    })
    expect(w.find('[role="alert"]').text()).toContain('API 503: upstream down')
    await w.find('[role="alert"] button').trigger('click')
    expect(retried).toBe(1)
  })
  it('shows empty only once settled, then content', async () => {
    const w = await mountSuspended(AsyncState, { props: { empty: true }, slots: { default: () => 'content' } })
    expect(w.text()).toContain('ยังไม่มีข้อมูล')
    await w.setProps({ empty: false })
    await nextTick()
    expect(w.text()).toContain('content')
  })
})

describe('ErrorState / EmptyState', () => {
  it('ErrorState extracts message from Nuxt-style error objects', async () => {
    const w = await mountSuspended(ErrorState, { props: { error: { statusCode: 500, data: { message: 'db locked' } } } })
    expect(w.text()).toContain('db locked')
    expect(w.find('button').exists()).toBe(false) // no retry given → no button
  })
  it('EmptyState renders title, description and CTA slot', async () => {
    const w = await mountSuspended(EmptyState, { props: { title: 'ยังไม่มีรายการ', description: 'เพิ่มรายการแรก' }, slots: { default: () => 'CTA' } })
    expect(w.find('h2').text()).toBe('ยังไม่มีรายการ')
    expect(w.text()).toContain('เพิ่มรายการแรก')
    expect(w.text()).toContain('CTA')
  })
})

// One language per app (kit finding #15): the layer's own words come from app.config (nuxtBase.lang / labels) through
// provide/inject. Default = Thai, exactly as before.
describe('labels follow the app language', () => {
  const en = { global: { provide: { [NB_LABELS_KEY]: resolveLabels('en') } } }

  it('resolveLabels: th by default and for an unknown language; en is complete; overrides replace single entries only', () => {
    expect(resolveLabels(undefined)).toEqual(NB_LABELS.th)
    expect(resolveLabels('fr')).toEqual(NB_LABELS.th)
    expect(Object.keys(NB_LABELS.en).sort()).toEqual(Object.keys(NB_LABELS.th).sort())
    for (const value of Object.values(NB_LABELS.en)) expect(value).toMatch(/^[\x20-\x7e…]+$/) // no Thai left in the English set
    expect(resolveLabels('en', { retry: 'Reload the list', bogus: 'x' } as never)).toEqual({ ...NB_LABELS.en, retry: 'Reload the list' })
    expect(resolveLabels('en', { retry: '' })).toEqual(NB_LABELS.en)
  })

  it('the app config of the layer defaults to th, and useLabels() reads it', () => {
    expect(useAppConfig().nuxtBase.lang).toBe('th')
    expect(useLabels()).toEqual(NB_LABELS.th)
  })

  it('default (th): the words are the ones the components always had', async () => {
    const error = await mountSuspended(ErrorState, { props: { error: new Error('x'), retry: () => {} } })
    expect(error.text()).toContain('โหลดข้อมูลไม่สำเร็จ')
    expect(error.find('button').text()).toBe('ลองใหม่')
    expect((await mountSuspended(LoadingState)).find('[role="status"]').attributes('aria-label')).toBe('กำลังโหลด…')
    expect((await mountSuspended(AsyncState, { props: { empty: true } })).text()).toContain('ยังไม่มีข้อมูล')
  })

  it('en: loading, empty, error title and retry are English — nothing Thai is left on screen', async () => {
    const error = await mountSuspended(ErrorState, { props: { error: new Error('boom'), retry: () => {} }, ...en })
    expect(error.text()).toContain('Could not load the data')
    expect(error.find('button').text()).toBe('Try again')
    expect((await mountSuspended(LoadingState, en)).find('[role="status"]').attributes('aria-label')).toBe('Loading…')
    const empty = await mountSuspended(AsyncState, { props: { empty: true }, ...en })
    expect(empty.text()).toContain('Nothing here yet')
    const failed = await mountSuspended(AsyncState, { props: { error: new Error('boom'), retry: () => {} }, ...en })
    expect(failed.find('[role="alert"] button').text()).toBe('Try again')
    for (const w of [error, empty, failed]) expect(w.text()).not.toMatch(/[\u0E00-\u0E7F]/)
  })

  it('a prop still wins over the language', async () => {
    const w = await mountSuspended(ErrorState, { props: { title: 'Custom title', error: new Error('x') }, ...en })
    expect(w.text()).toContain('Custom title')
    expect((await mountSuspended(LoadingState, { props: { label: 'Fetching' }, ...en })).find('.sr-only').text()).toBe('Fetching')
  })

  it('ConfirmModal: confirm / cancel follow the language, the props win, and without a provider it stays Thai', async () => {
    const buttons = async (options: object) => {
      await mountSuspended(ConfirmModal, { props: { modelValue: true, title: 'Delete?' }, attachTo: document.body, ...options } as never)
      const texts = [...document.body.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent?.trim())
      document.body.innerHTML = ''
      return texts
    }
    expect(await buttons(en)).toEqual(['Cancel', 'Confirm'])
    expect(await buttons({ ...en, props: { modelValue: true, title: 'Delete?', confirmLabel: 'Delete', cancelLabel: 'Keep' } })).toEqual(['Keep', 'Delete'])
    expect(await buttons({ global: { provide: { [NB_LABELS_KEY]: {} } } })).toEqual(['ยกเลิก', 'ยืนยัน'])
  })
})
