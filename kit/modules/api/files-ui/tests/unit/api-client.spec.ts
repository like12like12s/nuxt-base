// @vitest-environment node
// The typed client must be generated from the API's current contract: this fails when app/api/schema.d.ts is older
// than {{kit.apiDir}}/openapi.json. Fix: `npm run client` (after `npm run contract` in the API).
import { readFileSync } from 'node:fs'
import openapiTS, { astToString } from 'openapi-typescript'
import { describe, expect, it } from 'vitest'

const contract = new URL('../../../{{kit.apiDir}}/openapi.json', import.meta.url)
const committed = new URL('../../app/api/schema.d.ts', import.meta.url)

describe('typed client', () => {
  it('app/api/schema.d.ts matches the API contract (if not: npm run client)', async () => {
    const generated = astToString(await openapiTS(JSON.parse(readFileSync(contract, 'utf8'))))
    const file = readFileSync(committed, 'utf8')
    // the CLI puts a comment header in front of the generated types
    expect(file.slice(file.indexOf('export interface paths'))).toBe(generated.slice(generated.indexOf('export interface paths')))
  })
})
