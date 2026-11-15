// @vitest-environment node
// The layer's GET /api/_me (server/api/_me.get.ts) — its decision, without a server.
import { describe, expect, it } from 'vitest'
import { layerMe } from '../../server/utils/layer-me'

const headers = (values: Record<string, string>) => (name: string) => values[name] ?? ''
const alice = { 'x-authentik-username': 'alice', 'x-authentik-uid': 'uid-1', 'x-authentik-name': 'Alice', 'x-authentik-email': 'alice@example.com', 'x-authentik-groups': 'staff|admins' }

describe('GET /api/_me', () => {
  it('default endpoint: the user from the forward-auth headers, 401 without them', () => {
    for (const endpoint of [undefined, '/api/_me']) {
      expect(layerMe(headers(alice), endpoint)).toEqual({ user: { id: 'uid-1', name: 'Alice', email: 'alice@example.com', groups: ['staff', 'admins'] } })
      expect(layerMe(headers({}), endpoint)).toEqual({ status: 401, message: 'not authenticated' })
    }
    expect(layerMe(headers({ 'x-authentik-username': 'bob' }), undefined)).toEqual({ user: { id: 'bob', name: 'bob', email: undefined, groups: [] } })
  })

  // L13 (review t1097): an app that uses its own endpoint (the kit: /api/v1/me, which checks the proxy secret) still
  // served this one — a second "who am I" that believes bare headers
  it('is switched off (404) when the app points meEndpoint somewhere else — whatever headers are sent', () => {
    for (const endpoint of ['/api/v1/me', 'https://api.example.com/me', '']) {
      expect(layerMe(headers(alice), endpoint)).toEqual({ status: 404, message: 'not found' })
      expect(layerMe(headers({}), endpoint)).toEqual({ status: 404, message: 'not found' })
    }
  })
})
