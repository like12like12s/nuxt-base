import { describe, expect, it } from 'vitest'
import { describeConfig, loadConfig, loadDatabaseConfig } from '../src/config.js'
import { EnvError } from '../src/kit/api/env.js'

const env = { PORT: '3000', DATABASE_URL: 'mysql://app:s3cretpw@db.test/app' }

describe('config', () => {
  it('loads with defaults when the required keys are set', () => {
    expect(loadConfig(env)).toMatchObject({ PORT: 3000, HOST: '0.0.0.0', NODE_ENV: 'development', LOG_LEVEL: 'info', DB_RETRIES: 2, DB_QUERY_TIMEOUT_MS: 10_000 })
  })

  it('fails fast and names every missing key', () => {
    expect(() => loadConfig({})).toThrow(EnvError)
    expect(() => loadConfig({})).toThrow(/missing PORT/)
    expect(() => loadConfig({})).toThrow(/missing DATABASE_URL/)
    expect(() => loadConfig({ ...env, PORT: 'abc' })).toThrow(/invalid PORT/)
  })

  it('never prints the database URL — it may carry a password', () => {
    expect(JSON.stringify(describeConfig(loadConfig(env)))).not.toContain('s3cretpw')
    expect(describeConfig(loadConfig(env)).DATABASE_URL).toBe('***')
  })

  it('the db commands need only the database keys', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: 'sqlite::memory:' })).toMatchObject({ DATABASE_URL: 'sqlite::memory:', DB_POOL_MAX: 10 })
    expect(() => loadDatabaseConfig({ PORT: '3000' })).toThrow(/missing DATABASE_URL/)
  })
})
