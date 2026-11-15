// @vitest-environment node
// What the trace and security modules compose (behaviour: runtime-trace / runtime-security specs + the kit gate).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'

afterAll(cleanup)

function scaffold(args: string[], context?: object) {
  const base = tmp('ts')
  const dir = join(base, 'app')
  const extra: string[] = []
  if (context) {
    writeFileSync(join(base, 'ctx.json'), JSON.stringify(context))
    extra.push('--context', join(base, 'ctx.json'))
  }
  const r = cli(['new', 'demo-app', ...args, ...extra, '--dir', dir, '--json'])
  return { dir, r }
}

describe('trace module', () => {
  const { dir, r } = scaffold(['--kind', 'api', '--with', 'trace'])

  it('is ready for api / fullstack and brings the API standard', () => {
    expect(cli(['list', '--json']).json.modules.find((m: any) => m.name === 'trace')).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['api'] })
    expect(r.json.modules).toEqual(['base', 'api', 'db', 'testkit', 'trace'])
    expect(scaffold(['--kind', 'nuxt-app', '--with', 'trace']).r.status).toBe(4)
  })

  it('locks the runtime + the fake collector (test kit, not shipped in the build) and preloads tracing first', () => {
    expect(r.json.locked).toEqual(expect.arrayContaining(['src/kit/trace/tracing.ts', 'src/kit/testing/otlp-collector.ts']))
    expect(JSON.parse(read(dir, 'tsconfig.build.json')).exclude).toEqual(['src/kit/testing'])
    const index = read(dir, 'src/index.ts')
    const firstImport = index.split('\n').find((line) => line.startsWith('import '))
    expect(firstImport).toBe("import './tracing.js' // first: tracing is set up before anything else loads")
    expect(index).toContain('await stopTracing()')
    expect(read(dir, 'src/tracing.ts')).toContain("startTracing({ serviceName: 'demo-app-api' })")
    expect(read(dir, 'src/app.ts')).toContain('before: [traceMiddleware()],')
    expect(r.json.files).toContain('tests/trace.spec.ts')
    expect(Object.keys(JSON.parse(read(dir, 'package.json')).dependencies).filter((d) => d.startsWith('@opentelemetry/'))).toEqual([
      '@opentelemetry/api', '@opentelemetry/context-async-hooks', '@opentelemetry/core', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/resources', '@opentelemetry/sdk-trace',
    ])
  })

  it('the endpoint comes from --context (no host lives in the kit); without it tracing stays off', () => {
    expect(read(dir, '.env.example')).toMatch(/\nOTEL_EXPORTER_OTLP_ENDPOINT=\n/)
    expect(JSON.parse(read(dir, '.scaffold.json')).answers).not.toHaveProperty('otlpEndpoint')
    const withCtx = scaffold(['--kind', 'api', '--with', 'trace'], { otlpEndpoint: 'http://127.0.0.1:4318' })
    expect(read(withCtx.dir, '.env.example')).toContain('\nOTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318\n')
    expect(read(withCtx.dir, '.env.example')).toContain('\nOTEL_SERVICE_NAME=demo-app-api\n')
    expect(JSON.parse(read(withCtx.dir, '.scaffold.json')).answers.otlpEndpoint).toBe('http://127.0.0.1:4318')
    expect(cli(['check', withCtx.dir, '--json']).json.clean).toBe(true)
    expect(r.json.env).toContainEqual({ key: 'OTEL_EXPORTER_OTLP_ENDPOINT', required: false, secret: false })
  })

  it('without the module the app has no tracing code and no OpenTelemetry dependency', () => {
    const plain = scaffold(['--kind', 'api', '--with', 'api'])
    expect(plain.r.json.files).not.toContain('src/tracing.ts')
    for (const f of ['src/app.ts', 'src/index.ts', 'package.json', '.env.example']) expect(read(plain.dir, f), f).not.toMatch(/tracing|opentelemetry|OTEL_/i)
  })
})

describe('security module', () => {
  const { dir, r } = scaffold(['--kind', 'api', '--with', 'security'])

  it('is ready for api / fullstack; locks the runtime; the app passes it to createApi for every route', () => {
    expect(cli(['list', '--json']).json.modules.find((m: any) => m.name === 'security')).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['api'] })
    expect(r.json.locked).toContain('src/kit/security/security.ts')
    expect(read(dir, 'src/app.ts')).toMatch(/middleware: security\(\{\n\s+corsOrigins: parseOrigins\(config\.CORS_ORIGINS\),/)
    expect(r.json.files).toContain('tests/security.spec.ts')
  })

  it('config: no CORS origin by default, a rate limit and a body limit with defaults', () => {
    const config = read(dir, 'src/config.ts')
    for (const text of ['CORS_ORIGINS: z.string().optional()', 'RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300)', 'BODY_LIMIT_BYTES: z.coerce.number().int().min(1).default(1_048_576)']) expect(config).toContain(text)
    expect(read(dir, '.env.example')).toMatch(/\nCORS_ORIGINS=\n/)
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('## Security baseline')
  })

  it('without the module none of it is generated', () => {
    const plain = scaffold(['--kind', 'api', '--with', 'api'])
    for (const f of ['src/app.ts', 'src/config.ts', '.env.example']) expect(read(plain.dir, f), f).not.toMatch(/security|CORS_|RATE_LIMIT/)
  })
})

describe('all three together', () => {
  it.each([[['--kind', 'api', '--with', 'auth,trace,security']], [['--kind', 'fullstack', '--with', 'auth,trace,security', '--deploy', 'container']]])('%j: deterministic, clean, no directive left', (args) => {
    const a = scaffold(args)
    expect(a.r.status).toBe(0)
    expect(snapshot(scaffold(args).dir)).toEqual(snapshot(a.dir))
    expect(cli(['check', a.dir, '--json']).json).toMatchObject({ clean: true })
    for (const f of a.r.json.files as string[]) expect(read(a.dir, f), f).not.toMatch(/@kit:(if|else|end)|\{\{kit\./)
  })
})

describe('container preset with the modules', () => {
  it('the env template of the deploy host lists the keys of the installed modules — and only those', () => {
    const full = scaffold(['--kind', 'fullstack', '--with', 'auth,trace,security,notify', '--deploy', 'container'], { otlpEndpoint: 'http://collector.example:4318' })
    const env = read(full.dir, 'docker/env.example')
    for (const line of ['AUTH_PROXY_SECRET=', 'AUTH_ROLE_MAP=', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318', 'OTEL_SERVICE_NAME=demo-app-api', 'CORS_ORIGINS=', 'NOTIFIER_TOKEN=']) expect(env.split('\n'), line).toContain(line)
    expect(env).not.toMatch(/^AUTH_DEV_MODE=/m) // never offered for a deployed instance
    const plain = read(scaffold(['--kind', 'api', '--with', 'api', '--deploy', 'container']).dir, 'docker/env.example')
    expect(plain).not.toMatch(/AUTH_|OTEL_|CORS_|NOTIFIER_|@kit:/)
  })
})
