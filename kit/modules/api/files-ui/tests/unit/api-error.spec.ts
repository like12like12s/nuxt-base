import { describe, expect, it } from 'vitest'
import { apiProblem } from '~/utils/api-error'

// What a person is shown when the API refuses something: the fields of a 400, not just "Request validation failed".
describe('apiProblem', () => {
  it('a validation error names the fields — one line for a toast, one message per field for the form', () => {
    const problem = apiProblem({
      error: {
        code: 'VALIDATION',
        message: 'Request validation failed',
        details: [
          { path: 'json.name', message: 'Too small: expected string to have >=1 characters' },
          { path: 'json.name', message: 'a second issue of the same field' },
          { path: 'json.address.city', message: 'Required' },
          { path: 'query.limit', message: 'Too big: expected number to be <=200' },
        ],
        traceId: 'abc123',
      },
    })
    expect(problem.code).toBe('VALIDATION')
    expect(problem.fields).toEqual({ name: 'Too small: expected string to have >=1 characters', 'address.city': 'Required' })
    expect(problem.other).toEqual(['query.limit: Too big: expected number to be <=200'])
    expect(problem.text).toBe('Request validation failed — name: Too small: expected string to have >=1 characters; address.city: Required; query.limit: Too big: expected number to be <=200 (trace abc123)')
  })

  it('any other API error: its message and the trace id', () => {
    expect(apiProblem({ error: { code: 'CONFLICT', message: 'Order "A" already exists', traceId: 't1' } })).toMatchObject({ code: 'CONFLICT', fields: {}, text: 'Order "A" already exists (trace t1)' })
  })

  it('no answer in the API shape (network down, a proxy error page) is still a sentence', () => {
    expect(apiProblem(new TypeError('Failed to fetch'))).toMatchObject({ code: 'NETWORK', text: 'Failed to fetch', traceId: '' })
    expect(apiProblem(undefined).text).toBe('The request did not reach the API')
    expect(apiProblem({ error: { message: '', details: 'nope' } })).toMatchObject({ code: 'INTERNAL', text: 'Request failed', fields: {} })
  })
})
