// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/cli.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Service token commands of an app (src/auth/cli.ts calls runAuthCli with the app's roles):
//   token create --name <name> [--roles <a,b>] [--days <n>]  prints the token ONCE — it cannot be shown again
//                                                            no --roles (or --roles "") = a token that is authenticated
//                                                            and holds no role: it passes requireAuth() (reads), never
//                                                            requireRole() — the read-only token of a machine
//   token revoke <id|name>
//   token list
// Exit codes: 0 ok · 1 failed · 2 usage.
import { parseArgs } from 'node:util'
import { now } from '../db/clock.js'
import { openDatabase, type DatabaseOptions } from '../db/connect.js'
import { createServiceToken, listServiceTokens, revokeServiceToken } from './tokens.js'

export interface AuthCliDeps {
  /** DATABASE_URL */
  url: string
  roles: readonly string[]
  options?: Omit<DatabaseOptions, 'url'>
  out?: (line: string) => void
}

const USAGE = 'usage: token create --name <name> [--roles <a,b>] [--days <n>] | token revoke <id|name> | token list   (no --roles = authenticated, no role: read-only)'

export async function runAuthCli(argv: readonly string[], deps: AuthCliDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { name: { type: 'string' }, roles: { type: 'string' }, days: { type: 'string' } } })
  } catch (error) {
    out(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
  const [noun, verb, target, ...rest] = parsed.positionals
  const { name, roles: rolesFlag, days } = parsed.values
  if (noun !== 'token' || !['create', 'revoke', 'list'].includes(verb ?? '') || rest.length) {
    out(USAGE)
    return 2
  }

  let roles: string[] = []
  let expiresAt: string | null = null
  if (verb === 'create') {
    roles = (rolesFlag ?? '').split(',').map((role) => role.trim()).filter(Boolean)
    const unknown = roles.filter((role) => !deps.roles.includes(role))
    if (!name?.trim() || unknown.length || target) {
      out(unknown.length ? `unknown role(s): ${unknown.join(', ')} — this app has: ${deps.roles.join(', ')}` : USAGE)
      return 2
    }
    if (days !== undefined) {
      const n = Number(days)
      if (!Number.isFinite(n) || n <= 0) {
        out('--days must be a positive number')
        return 2
      }
      expiresAt = new Date(Date.parse(now()) + n * 86_400_000).toISOString()
    }
  } else if ((verb === 'revoke') !== Boolean(target)) {
    out(USAGE)
    return 2
  }

  const database = openDatabase<any>({ ...deps.options, url: deps.url })
  try {
    if (verb === 'create') {
      const created = await createServiceToken(database.db, { name: name!.trim(), roles, expiresAt })
      out(`created ${created.id}  name=${created.name}  roles=${created.roles.join(',') || '(none: authenticated, read-only)'}  expires=${created.expiresAt ?? 'never'}`)
      out(`token: ${created.token}`)
      out('Store it now — only its hash is kept, it cannot be shown again.')
      return 0
    }
    if (verb === 'revoke') {
      const revoked = await revokeServiceToken(database.db, target!)
      for (const token of revoked) out(`revoked ${token.id}  name=${token.name}`)
      if (!revoked.length) out(`no live token with id or name "${target}"`)
      return revoked.length ? 0 : 1
    }
    const at = now()
    for (const token of await listServiceTokens(database.db)) {
      const state = token.revokedAt ? 'revoked' : token.expiresAt && token.expiresAt <= at ? 'expired' : 'active'
      out(`${token.id}  ${state.padEnd(7)}  name=${token.name}  roles=${token.roles.join(',')}  expires=${token.expiresAt ?? 'never'}  lastUsed=${token.lastUsedAt ?? 'never'}`)
    }
    return 0
  } catch (error) {
    // Most often: the schema is not migrated yet. The message of a driver error never contains the URL.
    out(`token ${verb} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await database.close()
  }
}
