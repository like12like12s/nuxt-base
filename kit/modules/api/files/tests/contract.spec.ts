// The contract test: the committed openapi.json must be exactly what the code produces. A red test here means the
// API changed — run `npm run contract`, review the diff of openapi.json, commit both.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTRACT_FILE, buildContract } from '../src/contract.js'
import { useApp } from './helpers.js'

const t = useApp()

describe('openapi contract', () => {
  it('openapi.json matches the routes in the code (if not: npm run contract)', () => {
    expect(readFileSync(CONTRACT_FILE, 'utf8')).toBe(buildContract())
  })

  it('GET /openapi.json serves the same document', async () => {
    const res = await t.build().api.get('/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(JSON.parse(buildContract()))
  })

  it('documents every v1 route with the standard envelopes and the error shape', () => {
    const doc = JSON.parse(buildContract())
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths).sort()).toEqual(['/api/v1/items', '/api/v1/items/{id}', '/health/live', '/health/ready', '/version'])
    for (const [path, operations] of Object.entries<Record<string, any>>(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries<any>(operation.responses)) {
          if (Number(status) < 400) continue
          expect(response.content['application/json'].schema, `${method} ${path} ${status}`).toEqual({ $ref: '#/components/schemas/Error' })
        }
      }
    }
    expect(doc.components.schemas.Error.properties.error.required.sort()).toEqual(['code', 'message', 'traceId'])
    expect(doc.paths['/api/v1/items'].get.parameters.map((p: { name: string }) => p.name).sort()).toEqual(['ids', 'limit', 'offset', 'sort'])
  })
})
