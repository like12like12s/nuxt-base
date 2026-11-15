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
  /** Runs after the server stopped accepting connections. */
  cleanup?: () => void | Promise<void>
  onSignal?: (signal: string) => void
  onError?: (err: unknown) => void
  /** Injectable for tests. */
  exit?: (code: number) => void
  signals?: readonly NodeJS.Signals[]
}

export function gracefulShutdown(server: Closable, options: ShutdownOptions = {}): (signal?: string) => Promise<void> {
  const { timeoutMs = 10_000, cleanup, onSignal, onError, exit = (code) => process.exit(code), signals = ['SIGTERM', 'SIGINT'] } = options
  let closing: Promise<void> | undefined
  const shutdown = (signal = 'manual'): Promise<void> => {
    closing ??= (async () => {
      onSignal?.(signal)
      const timer = setTimeout(() => exit(1), timeoutMs)
      timer.unref()
      try {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        await cleanup?.()
        clearTimeout(timer)
        exit(0)
      } catch (err) {
        onError?.(err)
        clearTimeout(timer)
        exit(1)
      }
    })()
    return closing
  }
  for (const signal of signals) process.once(signal, () => void shutdown(signal))
  return shutdown
}
