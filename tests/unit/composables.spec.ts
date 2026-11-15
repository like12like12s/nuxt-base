import { describe, it, expect, vi } from 'vitest'
import { toAuthUser, useAuth, useToast, useAppConfig } from '#imports'

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

describe('toAuthUser (what /me answers -> the user)', () => {
  it('reads the layer\'s own shape', () => {
    expect(toAuthUser({ id: 'u1', name: 'Alice', email: 'a@example.com', groups: ['staff'] })).toEqual({ id: 'u1', name: 'Alice', email: 'a@example.com', groups: ['staff'] })
  })
  it('reads the kit API envelope: { data: { subject, name, email, roles } }', () => {
    expect(toAuthUser({ data: { subject: 'uid-1', name: 'Alice', email: null, roles: ['editor'], kind: 'user' } })).toEqual({ id: 'uid-1', name: 'Alice', roles: ['editor'] })
    expect(toAuthUser({ data: { subject: 'service:9', name: null, roles: [] } })).toEqual({ id: 'service:9', name: 'service:9', roles: [] })
  })
  it('nothing usable = anonymous', () => {
    for (const body of [null, undefined, '', {}, { data: null }, { data: {} }, { name: 'no id' }, 204]) expect(toAuthUser(body)).toBeNull()
  })
})
