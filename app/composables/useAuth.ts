// Auth hook point. Default provider = Authentik forward-auth (Caddy passes X-Authentik-* headers; the layer's
// Nitro route /api/_me turns them into a user). Disabled by default — enable in app.config:
//   nuxtBase: { auth: { enabled: true, loginUrl: '/outpost.goauthentik.io/start?rd=/' } }
// Apps with another scheme (internal token, own session) override by shipping their own app/composables/useAuth.ts.
export interface AuthUser { id: string; name: string; email?: string; groups?: string[] }

export function useAuth() {
  const cfg = useAppConfig().nuxtBase.auth
  const user = useState<AuthUser | null>('nb-auth-user', () => null)
  // ready=true immediately when auth is off, so UIs never flash an anonymous state they will not keep (optimistic-initial-state)
  const ready = useState<boolean>('nb-auth-ready', () => !cfg.enabled)
  const error = useState<string>('nb-auth-error', () => '')

  async function load() {
    if (!cfg.enabled) return
    try {
      const res = await $fetch<AuthUser | null>(cfg.meEndpoint, { headers: { accept: 'application/json' } })
      user.value = res && res.id ? res : null
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
