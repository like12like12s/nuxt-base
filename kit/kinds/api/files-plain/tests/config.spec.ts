import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeConfig, loadConfig } from '../src/config.js'
import { EnvError, loadEnv, redactEnv } from '../src/kit/api/env.js'

describe('config', () => {
  it('loads with defaults when the required keys are set', () => {
    const config = loadConfig({ PORT: '3000' })
    expect(config).toMatchObject({ PORT: 3000, HOST: '0.0.0.0', NODE_ENV: 'development', LOG_LEVEL: 'info' })
    expect(describeConfig(config)).toMatchObject({ PORT: 3000 })
  })

  it('fails fast and names the missing key', () => {
    expect(() => loadConfig({})).toThrow(EnvError)
    expect(() => loadConfig({})).toThrow(/missing PORT/)
    expect(() => loadConfig({ PORT: '' })).toThrow(/missing PORT/)
  })

  it('names an invalid key', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/invalid PORT/)
  })

  it('never prints a secret value — not in errors, not in the loggable config', () => {
    const shape = { API_TOKEN: z.string().min(32), PORT: z.coerce.number() }
    const secrets = ['API_TOKEN'] as const
    let message = ''
    try {
      loadEnv(shape, { source: { API_TOKEN: 'hunter2', PORT: '3000' }, secrets })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('invalid API_TOKEN')
    expect(message).not.toContain('hunter2')
    const config = loadEnv(shape, { source: { API_TOKEN: 'x'.repeat(32), PORT: '3000' }, secrets })
    expect(JSON.stringify(redactEnv(config, secrets))).not.toContain('xxxx')
  })
})
