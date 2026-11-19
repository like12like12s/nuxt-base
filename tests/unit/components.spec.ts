import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, h } from 'vue'
import { vi } from 'vitest'
import Btn from '../../app/components/Btn.vue'
import IconButton from '../../app/components/IconButton.vue'
import Tooltip from '../../app/components/Tooltip.vue'
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

describe('Tooltip / IconButton (t1308: icon-only controls need a tooltip + aria-label)', () => {
  it('Tooltip: renders the slot plus a role=tooltip bubble that shows on hover AND focus-within', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'คัดลอก' }, slots: { default: () => '×' } })
    expect(w.text()).toContain('×')
    const tip = w.find('[role="tooltip"]')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toBe('คัดลอก')
    expect(tip.classes()).toContain('group-hover/tt:opacity-100')
    expect(tip.classes()).toContain('group-focus-within/tt:opacity-100')
  })

  it('Tooltip: side=bottom flips below the trigger', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'x', side: 'bottom' }, slots: { default: () => '×' } })
    // real geometry (the old version leaned on happy-dom's zero rect, which the t1329 vertical clamp now catches)
    const rect = { top: 400, bottom: 428, left: 200, right: 228, width: 28, height: 28, x: 200, y: 400, toJSON: () => {} } as DOMRect
    const rootEl = w.element as HTMLElement
    const tipEl = w.find('[role="tooltip"]').element as HTMLElement
    const spies = [
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue(rect),
      vi.spyOn(tipEl, 'offsetWidth', 'get').mockReturnValue(30),
      vi.spyOn(tipEl, 'offsetHeight', 'get').mockReturnValue(24),
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375),
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812),
    ]
    await w.trigger('mouseenter')
    // side=bottom with room below -> not flipped -> bubble below the trigger (top:100%)
    expect(w.find('[role="tooltip"]').classes()).toContain('top-full')
    for (const sp of spies) sp.mockRestore()
  })

  it('Tooltip: clamps inside the viewport at the right edge (390px, t1307 follow-up) and flips below when there is no room above', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'ชนิดของโน้ตที่จะสร้าง' }, slots: { default: () => '×' } })
    const rootEl = w.element as HTMLElement
    const tipEl = w.find('[role="tooltip"]').element as HTMLElement
    const rect = { top: 20, bottom: 40, left: 340, right: 372, width: 32, height: 20, x: 340, y: 20, toJSON: () => {} } as DOMRect
    const spies = [
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue(rect),
      vi.spyOn(tipEl, 'offsetWidth', 'get').mockReturnValue(140),
      vi.spyOn(tipEl, 'offsetHeight', 'get').mockReturnValue(24),
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390),
    ]
    await w.trigger('mouseenter')
    // unclamped centred bubble would end at 340+16+70=426 > 382 — clamped to viewport-8
    expect(parseFloat(tipEl.style.left)).toBe(390 - 8 - 140 - 340)
    // `left` is the final offset — no CSS centring on top of it (it pushed the bubble w/2 off, t1322)
    expect(w.find('[role="tooltip"]').classes()).not.toContain('-translate-x-1/2')
    expect(w.find('[role="tooltip"]').classes()).not.toContain('left-1/2')
    expect(w.find('[role="tooltip"]').classes()).toContain('top-full') // 20px of room above < 24+8 -> flipped below
    for (const sp of spies) sp.mockRestore()
  })

  it('Tooltip: clamps the vertical axis too — a below-the-fold trigger leaves no bubble hanging past the viewport bottom (t1329, intzone manage rows)', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'Remove' }, slots: { default: () => '×' } })
    const rootEl = w.element as HTMLElement
    const tipEl = w.find('[role="tooltip"]').element as HTMLElement
    // trigger at y=830 on a 375x812 phone: plenty of room above, but the bubble above it (y 800..824.5) still pokes past 812
    const rect = { top: 830, bottom: 858, left: 299, right: 327, width: 28, height: 28, x: 299, y: 830, toJSON: () => {} } as DOMRect
    const spies = [
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue(rect),
      vi.spyOn(tipEl, 'offsetWidth', 'get').mockReturnValue(58),
      vi.spyOn(tipEl, 'offsetHeight', 'get').mockReturnValue(24),
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375),
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812),
    ]
    await w.trigger('mouseenter')
    // side=top not flipped -> CSS spot at 830-24-6=800 > 812-8-24=780 -> clamped to 780 absolute = -50 from the trigger
    expect(parseFloat(tipEl.style.top)).toBe(780 - 830)
    // while clamped the bubble detaches from the CSS side classes (their insets would fight the inline top)
    const cls = w.find('[role="tooltip"]').classes()
    expect(cls).not.toContain('top-full')
    expect(cls).not.toContain('bottom-full')
    for (const sp of spies) sp.mockRestore()
  })

  it('Tooltip: a fully visible trigger keeps the CSS side placement (no vertical clamp)', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'Copy URL' }, slots: { default: () => '×' } })
    const rootEl = w.element as HTMLElement
    const tipEl = w.find('[role="tooltip"]').element as HTMLElement
    const rect = { top: 400, bottom: 428, left: 200, right: 228, width: 28, height: 28, x: 200, y: 400, toJSON: () => {} } as DOMRect
    const spies = [
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue(rect),
      vi.spyOn(tipEl, 'offsetWidth', 'get').mockReturnValue(58),
      vi.spyOn(tipEl, 'offsetHeight', 'get').mockReturnValue(24),
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375),
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812),
    ]
    await w.trigger('mouseenter')
    expect(tipEl.style.top).toBe('') // no inline top — the bottom-full mb-1.5 class owns placement
    expect(w.find('[role="tooltip"]').classes()).toContain('bottom-full')
    for (const sp of spies) sp.mockRestore()
  })

  it('Tooltip: hides itself while the trigger menu is open (aria-expanded, t1307 follow-up)', async () => {
    const w = await mountSuspended(Tooltip, { props: { label: 'เมนู' }, slots: { default: () => h('button', { type: 'button' }, 'm') } })
    const btn = w.find('button').element
    expect(w.find('[role="tooltip"]').classes()).not.toContain('!opacity-0')
    btn.setAttribute('aria-expanded', 'true')
    await new Promise(r => setTimeout(r, 25))
    await nextTick()
    expect(w.find('[role="tooltip"]').classes()).toContain('!opacity-0')
    btn.setAttribute('aria-expanded', 'false')
    await new Promise(r => setTimeout(r, 25))
    await nextTick()
    expect(w.find('[role="tooltip"]').classes()).not.toContain('!opacity-0')
  })

  it('IconButton: label becomes aria-label + title + the tooltip, with no visible text', async () => {
    const w = await mountSuspended(IconButton, { props: { label: 'ลบ' }, slots: { default: () => 'svg' } })
    const btn = w.find('button')
    expect(btn.attributes('aria-label')).toBe('ลบ')
    expect(btn.attributes('title')).toBe('ลบ')
    expect(btn.attributes('type')).toBe('button')
    expect(btn.text()).toBe('svg') // only the icon slot — no stray visible label
    expect(w.find('[role="tooltip"]').text()).toBe('ลบ')
  })

  it('IconButton: variant/size/disabled and href link form', async () => {
    const d = await mountSuspended(IconButton, { props: { label: 'Delete', variant: 'danger', size: 'sm', disabled: true }, slots: { default: () => 'x' } })
    expect(d.find('button').attributes('disabled')).toBeDefined()
    expect(d.find('button').classes()).toContain('h-7')
    expect(d.find('button').classes()).toContain('w-7')
    const a = await mountSuspended(IconButton, { props: { label: 'Open', href: 'https://x' }, slots: { default: () => 'x' } })
    expect(a.find('a').attributes('href')).toBe('https://x')
    expect(a.find('a').attributes('aria-label')).toBe('Open')
  })
})
