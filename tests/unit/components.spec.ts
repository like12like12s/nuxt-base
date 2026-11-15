import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import Btn from '../../app/components/Btn.vue'
import AsyncState from '../../app/components/AsyncState.vue'
import ErrorState from '../../app/components/ErrorState.vue'
import EmptyState from '../../app/components/EmptyState.vue'

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
