// Authentik forward-auth → Caddy sets these headers on proxied requests. Returns the user or 401.
// Only trusted when the app sits behind the proxy; a direct hit without headers = 401 (anonymous).
export default defineEventHandler((event) => {
  const h = (n: string) => getHeader(event, n) || ''
  const username = h('x-authentik-username')
  if (!username) throw createError({ statusCode: 401, statusMessage: 'not authenticated' })
  return {
    id: h('x-authentik-uid') || username,
    name: h('x-authentik-name') || username,
    email: h('x-authentik-email') || undefined,
    groups: h('x-authentik-groups') ? h('x-authentik-groups').split('|') : [],
  }
})
