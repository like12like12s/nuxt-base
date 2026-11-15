import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError } from 'h3'
import { describe, expect, it } from 'vitest'

// The UI never decides who the user is: it asks the API (GET /api/v1/me), which believes only the trusted proxy.
describe('auth wiring', () => {
  it('the layer\'s useAuth is on and reads the API', () => {
    expect(useAppConfig().nuxtBase.auth).toMatchObject({ enabled: true, meEndpoint: '/api/v1/me' })
  })

  it('load() takes the user from the API envelope', async () => {
    registerEndpoint('/api/v1/me', () => ({ data: { subject: 'uid-1', name: 'Alice', email: 'alice@example.com', roles: ['editor'], kind: 'user' } }))
    const auth = useAuth()
    await auth.load()
    expect(auth.ready).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.user).toMatchObject({ id: 'uid-1', name: 'Alice', email: 'alice@example.com', roles: ['editor'] })
  })

  it('401 from the API = anonymous, without an error', async () => {
    registerEndpoint('/api/v1/me', () => { throw createError({ statusCode: 401, statusMessage: 'Unauthorized' }) })
    const auth = useAuth()
    await auth.load()
    expect(auth.user).toBeNull()
    expect(auth.error).toBe('')
    expect(auth.ready).toBe(true)
  })
})
