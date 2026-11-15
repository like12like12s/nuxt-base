// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/shutdown.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Graceful shutdown: on SIGTERM / SIGINT stop accepting connections, let in-flight requests finish, run cleanup
// (close pools, flush telemetry), exit 0. A hard deadline exits 1 so a stuck request cannot hang a deploy.

export interface Closable {
  close(callback?: (err?: Error) => void): unknown
}

export interface ShutdownOptions {
  /** Hard deadline in ms (default 10 000 — matches `docker stop` / pm2 kill_timeout defaults). */
  timeoutMs?: number
  /** Runs after the server stopped accepting connections — and also when it could not be closed or the deadline passed. */
  cleanup?: () => void | Promise<void>
  /** After the hard deadline: how long cleanup may still take before the process exits anyway (default 2 000). */
  cleanupTimeoutMs?: number
  onSignal?: (signal: string) => void
  onError?: (err: unknown) => void
  /** Injectable for tests. */
  exit?: (code: number) => void
  signals?: readonly NodeJS.Signals[]
}

export function gracefulShutdown(server: Closable, options: ShutdownOptions = {}): (signal?: string) => Promise<void> {
  const { timeoutMs = 10_000, cleanupTimeoutMs = 2000, cleanup, onSignal, onError, exit = (code) => process.exit(code), signals = ['SIGTERM', 'SIGINT'] } = options
  let closing: Promise<void> | undefined
  // Cleanup (pools, telemetry) runs exactly once and on every path: also when the server could not be closed, and —
  // bounded — when the deadline passes with requests still open.
  let cleaned: Promise<void> | undefined
  const runCleanup = (): Promise<void> => (cleaned ??= (async () => { await cleanup?.() })())
  const shutdown = (signal = 'manual'): Promise<void> => {
    closing ??= (async () => {
      onSignal?.(signal)
      let done = false
      const finish = (code: number) => {
        if (done) return
        done = true
        clearTimeout(timer)
        exit(code)
      }
      const timer = setTimeout(() => {
        const last = setTimeout(() => finish(1), cleanupTimeoutMs)
        last.unref()
        void runCleanup().catch((err) => onError?.(err)).finally(() => finish(1))
      }, timeoutMs)
      timer.unref()
      let failed = false
      try {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      } catch (err) {
        failed = true
        onError?.(err)
      }
      try {
        await runCleanup()
      } catch (err) {
        failed = true
        onError?.(err)
      }
      finish(failed ? 1 : 0)
    })()
    return closing
  }
  for (const signal of signals) process.once(signal, () => void shutdown(signal))
  return shutdown
}
