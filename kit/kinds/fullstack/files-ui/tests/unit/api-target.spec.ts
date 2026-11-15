import { describe, expect, it } from 'vitest'
import { apiTarget } from '../../server/utils/api-target'

describe('apiTarget', () => {
  it('forwards the path and query to API_URL', () => {
    expect(apiTarget('http://api:3000/', '/api/v1/items?limit=5')).toBe('http://api:3000/api/v1/items?limit=5')
  })

  it('falls back to the local API port', () => {
    expect(apiTarget(undefined, '/api/v1/items')).toBe('http://127.0.0.1:{{kit.apiPort}}/api/v1/items')
  })
})
