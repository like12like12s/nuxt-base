// Same-origin API: the browser calls /api/** on the UI, the UI server forwards it to the API. No API host ends up in
// the browser bundle, so the app works unchanged behind a tunnel or a reverse proxy.
// @kit:if auth
// On the way it carries the auth bridge (server/kit/auth-bridge.ts): identity headers and the proxy secret a client
// sent are always removed; the identity the forward-auth proxy vouches for is passed on, with the secret the API
// expects, only when the request's TCP peer is that proxy (AUTH_BRIDGE_TRUSTED_PROXIES + AUTH_PROXY_SECRET).
import { authBridgeFromEnv } from '../../kit/auth-bridge'
// @kit:end
import { apiTarget } from '../../utils/api-target'

// @kit:if auth
const bridge = authBridgeFromEnv()

export default defineEventHandler((event) => {
  bridge(event.node.req.headers, event.node.req.socket.remoteAddress)
  return proxyRequest(event, apiTarget(process.env.API_URL, event.path))
})
// @kit:else
export default defineEventHandler((event) => proxyRequest(event, apiTarget(process.env.API_URL, event.path)))
// @kit:end
