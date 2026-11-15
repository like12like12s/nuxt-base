// Authentik forward-auth → Caddy sets these headers on proxied requests. Returns the user or 401.
// Only trusted when the app sits behind the proxy; a direct hit without headers = 401 (anonymous).
// Off (404) when the app's `nuxtBase.auth.meEndpoint` names another endpoint — see server/utils/layer-me.ts.
import { layerMe } from '../utils/layer-me'

export default defineEventHandler((event) => {
  const endpoint = (useAppConfig() as { nuxtBase?: { auth?: { meEndpoint?: string } } }).nuxtBase?.auth?.meEndpoint
  const result = layerMe((name) => getHeader(event, name) || '', endpoint)
  if ('status' in result) throw createError({ statusCode: result.status, statusMessage: result.message })
  return result.user
})
