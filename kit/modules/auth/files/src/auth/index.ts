// Auth of {{kit.name}}, wired from the validated config. The rules live in the locked runtime (src/kit/auth):
//   - forward-auth headers (X-Authentik-* by default; AUTH_HEADER_PRESET=remote for Remote-User / Remote-Groups / …)
//     are believed only with AUTH_PROXY_SECRET and/or AUTH_TRUSTED_PROXIES
//   - `Authorization: Bearer <service token>` — tokens are created with `npm run auth:token -- create ...`
//   - AUTH_DEV_MODE=1 makes every request the dev user below; the API refuses to start with it in production
import type { Config } from '../config.js'
import type { AppDatabase } from '../db/index.js'
import type { Logger } from '../kit/api/log.js'
import { createAuth, type Auth } from '../kit/auth/guard.js'
import { csv, identityHeaders, parseRoleMap } from '../kit/auth/proxy.js'
import { ROLES } from './roles.js'

export const DEV_USER = { subject: 'dev', name: 'Dev User', roles: [...ROLES] }

export function appAuth(config: Config, database: AppDatabase, logger?: Logger): Auth {
  return createAuth({
    db: database.db,
    roles: ROLES,
    roleMap: parseRoleMap(config.AUTH_ROLE_MAP, ROLES),
    proxy: {
      secret: config.AUTH_PROXY_SECRET,
      trustedProxies: csv(config.AUTH_TRUSTED_PROXIES),
      // A preset or name that cannot be used stops the boot (AuthConfigError) — never a silent "nobody is signed in".
      headers: identityHeaders({
        preset: config.AUTH_HEADER_PRESET,
        username: config.AUTH_HEADER_USERNAME,
        uid: config.AUTH_HEADER_UID,
        email: config.AUTH_HEADER_EMAIL,
        name: config.AUTH_HEADER_NAME,
        groups: config.AUTH_HEADER_GROUPS,
      }),
      groupsSeparator: config.AUTH_HEADER_GROUPS_SEPARATOR,
    },
    devUser: config.AUTH_DEV_MODE === '1' ? DEV_USER : null,
    env: config.NODE_ENV,
    logger,
  })
}
