// Auth hook point. Default provider = Authentik forward-auth (Caddy passes X-Authentik-* headers; the layer's
// Nitro route /api/_me turns them into a user). Disabled by default — enable in app.config:
//   nuxtBase: { auth: { enabled: true, loginUrl: '/outpost.goauthentik.io/start?rd=/' } }
// Apps with another scheme (internal token, own session) override by shipping their own app/composables/useAuth.ts.
export interface AuthUser { id: string; name: string; email?: string; groups?: string[]; roles?: string[] }

// Two shapes are understood: the layer's own /api/_me ({ id, name, email?, groups? }) and an API that answers in the
// kit's envelope with its own vocabulary — GET /api/v1/me -> { data: { subject, name, email, roles } }.
export function toAuthUser(body: unknown): AuthUser | null {
  const raw = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const id = typeof u.id === 'string' && u.id ? u.id : typeof u.subject === 'string' ? u.subject : ''
  if (!id) return null
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined)
  return {
    id,
    name: typeof u.name === 'string' && u.name ? u.name : id,
    ...(typeof u.email === 'string' && u.email ? { email: u.email } : {}),
    ...(list(u.groups) ? { groups: list(u.groups) } : {}),
    ...(list(u.roles) ? { roles: list(u.roles) } : {}),
  }
}

export function useAuth() {
  const cfg = useAppConfig().nuxtBase.auth
  const user = useState<AuthUser | null>('nb-auth-user', () => null)
  // ready=true immediately when auth is off, so UIs never flash an anonymous state they will not keep (optimistic-initial-state)
  const ready = useState<boolean>('nb-auth-ready', () => !cfg.enabled)
  const error = useState<string>('nb-auth-error', () => '')

  async function load() {
    if (!cfg.enabled) return
    try {
      user.value = toAuthUser(await $fetch<unknown>(cfg.meEndpoint, { headers: { accept: 'application/json' } }))
      error.value = ''
    } catch (e: any) {
      user.value = null
      error.value = e?.statusCode === 401 ? '' : (e?.message || 'auth check failed')
      if (e?.statusCode !== 401) console.error('[useAuth.load]', e)
    } finally {
      ready.value = true
    }
  }

  function login() {
    if (cfg.loginUrl) window.location.href = cfg.loginUrl.replace('{rd}', encodeURIComponent(window.location.pathname))
  }

  // reactive → `auth.user?.name`, `auth.ready` unwrap in templates
  return reactive({ user, ready, error, load, login, isAuthenticated: computed(() => !!user.value), enabled: cfg.enabled })
}
