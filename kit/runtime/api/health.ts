// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/health.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Readiness checks. /health/live never runs any of this (the process is up — that is all it says). /health/ready runs
// every registered check with its own deadline: a driver waiting on an unreachable host does not fail fast, and a probe
// that times out reads as "no answer" instead of "not ready".

/** Deadline of one check. Probes must allow more: timeoutSeconds >= 3, period >= 10, failureThreshold >= 3. */
export const CHECK_TIMEOUT_MS = 2000

/** Thrown by a check to fail with a message that is safe to show to an unauthenticated probe. */
export class HealthCheckError extends Error {}

export interface HealthCheck {
  name: string
  /** Resolves = ok. Throws HealthCheckError = failed with that public message; any other error = "failed". */
  run: () => Promise<void>
  timeoutMs?: number
}

export interface CheckResult {
  name: string
  status: 'ok' | 'fail'
  ms: number
  message?: string
}

export interface HealthReport {
  ok: boolean
  checks: CheckResult[]
}

async function runOne(check: HealthCheck, onError?: (name: string, err: unknown) => void): Promise<CheckResult> {
  const start = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = (status: 'ok' | 'fail', message?: string): CheckResult => ({
    name: check.name,
    status,
    ms: Math.round(performance.now() - start),
    ...(message ? { message } : {}),
  })
  try {
    await Promise.race([
      check.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HealthCheckError('timed out')), check.timeoutMs ?? CHECK_TIMEOUT_MS)
      }),
    ])
    return done('ok')
  } catch (err) {
    if (err instanceof HealthCheckError) return done('fail', err.message)
    // The real cause may name a host or a query — it belongs in the log, not in an unauthenticated response.
    onError?.(check.name, err)
    return done('fail', 'failed')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runChecks(checks: readonly HealthCheck[], onError?: (name: string, err: unknown) => void): Promise<HealthReport> {
  const results = await Promise.all(checks.map((check) => runOne(check, onError)))
  return { ok: results.every((r) => r.status === 'ok'), checks: results }
}
