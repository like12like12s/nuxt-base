// DO NOT EDIT — locked file from the nuxt-base kit (runtime/notify/client.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Client of a central notification hub with a plain HTTP API: `POST <url>/notify` with a JSON body and a bearer
// token. The hub decides the channels, the de-duplication and the rate limit; the app only says what happened.
// Off when no URL is configured. notify() never throws and never blocks for long: a notification that cannot be
// sent must not fail (or stall) the work that wanted to send it — the result says what happened.

export interface NotifyMessage {
  /** Routing key at the hub, e.g. `ops-warn`. */
  topic: string
  title: string
  message: string
  priority?: 'low' | 'normal' | 'high'
  /** Same key = the same incident: the hub collapses repeats. */
  dedupeKey?: string
  /** true = the incident named by dedupeKey is over. */
  resolved?: boolean
}

export type NotifyResult = { ok: true; status: number } | { ok: false; skipped: true } | { ok: false; status?: number; error: string }

export interface NotifierOptions {
  /** Base URL of the hub. Empty / undefined = notifications are off. */
  url?: string
  token?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  onError?: (error: string, message: NotifyMessage) => void
}

export interface Notifier {
  readonly enabled: boolean
  notify(message: NotifyMessage): Promise<NotifyResult>
}

export class NotifierConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotifierConfigError'
  }
}

/**
 * Throws NotifierConfigError (never quoting the value) when the URL is not a plain http(s) URL or carries
 * credentials (userinfo in front of the host): they would end up in every error message, result and log line that
 * names the request — the bearer token (NOTIFIER_TOKEN) is the only credential of the hub.
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const base = options.url?.trim().replace(/\/+$/, '') ?? ''
  if (base) {
    let parsed: URL | null = null
    try {
      parsed = new URL(base)
    } catch {
      parsed = null
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new NotifierConfigError('NOTIFIER_URL is not an http(s) URL')
    if (parsed.username || parsed.password) throw new NotifierConfigError('NOTIFIER_URL must not contain credentials (user:password@) — use NOTIFIER_TOKEN')
  }
  const { token, timeoutMs = 5000, onError } = options
  const send = options.fetch ?? globalThis.fetch
  return {
    enabled: base !== '',
    async notify(message) {
      if (!base) return { ok: false, skipped: true }
      const fail = (error: string, status?: number): NotifyResult => {
        onError?.(error, message)
        return { ok: false, ...(status === undefined ? {} : { status }), error }
      }
      try {
        const res = await send(`${base}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            topic: message.topic,
            title: message.title,
            message: message.message,
            ...(message.priority ? { priority: message.priority } : {}),
            ...(message.dedupeKey ? { dedupe_key: message.dedupeKey } : {}),
            ...(message.resolved === undefined ? {} : { resolved: message.resolved }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok ? { ok: true, status: res.status } : fail(`the hub answered ${res.status}`, res.status)
      } catch (error) {
        // Never the URL or the token: only what went wrong.
        return fail(error instanceof Error ? (error.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : error.message) : String(error))
      }
    },
  }
}
