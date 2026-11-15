// GET /api/v1/me — who the API thinks is calling. The UI's useAuth() reads it; 401 = nobody is signed in.
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { getContext } from '../../kit/api/context.js'
import { errorResponses, unauthorized } from '../../kit/api/errors.js'
import { dataOf, one } from '../../kit/api/pagination.js'
import { requireAuth } from '../../kit/auth/guard.js'

export const MeSchema = z
  .object({
    subject: z.string().openapi({ example: 'a1b2c3' }),
    name: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(z.string()).openapi({ example: ['editor'] }),
    kind: z.enum(['user', 'service']),
  })
  .openapi('Me')

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['auth'],
  summary: 'The authenticated caller',
  middleware: [requireAuth()] as const,
  responses: { 200: { description: 'The caller', content: { 'application/json': { schema: dataOf(MeSchema) } } }, ...errorResponses(401) },
})

export function registerMe(v1: OpenAPIHono): void {
  v1.openapi(meRoute, (c) => {
    const user = getContext()?.user
    if (!user) throw unauthorized()
    const kind = user.subject.startsWith('service:') ? ('service' as const) : ('user' as const)
    return c.json(one({ subject: user.subject, name: user.name ?? null, email: user.email ?? null, roles: [...user.roles], kind }), 200)
  })
}
