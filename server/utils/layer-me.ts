// What GET /api/_me answers. Pure, so it can be tested without a server.
//
// The route reads the X-Authentik-* headers as they arrive: it is only right for an app whose every request comes
// through the forward-auth proxy (which replaces those headers). An app that has its own "who am I" endpoint — the
// kit's GET /api/v1/me checks the proxy secret — points `nuxtBase.auth.meEndpoint` at it, and then this route is
// switched off (404): a second endpoint that believes bare headers must not sit next to the real one.
export const LAYER_ME_ENDPOINT = '/api/_me'

export interface LayerUser {
  id: string
  name: string
  email?: string
  groups: string[]
}

export type LayerMe = { user: LayerUser } | { status: 401 | 404; message: string }

export function layerMe(header: (name: string) => string, meEndpoint: string | undefined): LayerMe {
  if ((meEndpoint ?? LAYER_ME_ENDPOINT) !== LAYER_ME_ENDPOINT) return { status: 404, message: 'not found' }
  const username = header('x-authentik-username')
  if (!username) return { status: 401, message: 'not authenticated' }
  return {
    user: {
      id: header('x-authentik-uid') || username,
      name: header('x-authentik-name') || username,
      email: header('x-authentik-email') || undefined,
      groups: header('x-authentik-groups') ? header('x-authentik-groups').split('|') : [],
    },
  }
}
