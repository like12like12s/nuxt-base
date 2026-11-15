import { describe, it, expect, vi } from 'vitest'
import { useAuth, useToast, useAppConfig } from '#imports'

describe('useAuth (hook point, disabled by default)', () => {
  it('is ready immediately and anonymous when disabled', async () => {
    const a = useAuth()
    expect(a.enabled).toBe(false)
    expect(a.ready).toBe(true)
    expect(a.user).toBeNull()
    await a.load()
    expect(a.isAuthenticated).toBe(false)
  })
})

describe('useToast', () => {
  it('shows then clears a message', () => {
    vi.useFakeTimers()
    const t = useToast()
    t.show('hi', 100)
    expect(t.message).toBe('hi')
    vi.advanceTimersByTime(150)
    expect(t.message).toBe('')
    vi.useRealTimers()
  })
})

describe('app.config defaults', () => {
  it('exposes nuxtBase site/auth defaults merged with the playground overrides', () => {
    const c = useAppConfig().nuxtBase
    expect(c.site.name).toBe('nuxt-base playground')
    expect(c.auth.meEndpoint).toBe('/api/_me')
  })
})
