// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/tokens.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Service tokens: credentials for machines (jobs, other services) sent as `Authorization: Bearer <token>`.
//   - 256 random bits, shown exactly once (at creation); only the sha256 is stored in `service_tokens`
//   - roles, an optional expiry, revocable; `lastUsedAt` shows which tokens are still in use
//   - looked up by hash, then compared in constant time
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import { now } from '../db/clock.js'
import { audited, created, fromJson, toJson, touched } from '../db/repo.js'

/** Makes a token recognisable (in a log scrubber, in a secret scanner) and lets a foreign bearer be skipped cheaply. */
export const TOKEN_PREFIX = 'kit_'

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
const generateToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('base64url')

export interface ServiceToken {
  id: string
  name: string
  roles: string[]
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

const COLUMNS = ['id', 'name', 'roles', 'createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt'] as const
type Row = Omit<ServiceToken, 'roles'> & { roles: string }
const record = (row: Row): ServiceToken => ({ ...row, roles: fromJson<string[]>(row.roles, []) })

export interface NewToken {
  name: string
  roles: readonly string[]
  /** ISO-8601; omit for a token that does not expire. */
  expiresAt?: string | null
}

/** Create a token. `token` in the result is the only time the secret exists outside the caller's hands. */
export async function createServiceToken(db: Kysely<any>, input: NewToken): Promise<ServiceToken & { token: string }> {
  const name = input.name.trim()
  if (!name) throw new Error('a service token needs a name')
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('expiresAt is not a date')
  const token = generateToken()
  const row = { ...created(), hash: hashToken(token), name, roles: toJson([...input.roles]), expiresAt: input.expiresAt ?? null, revokedAt: null, lastUsedAt: null }
  const saved = await audited(db, { action: 'service_token.create', target: `service_token:${row.id}` }, async (trx) => {
    await trx.insertInto('service_tokens').values(row).execute()
    const after = record((await trx.selectFrom('service_tokens').select(COLUMNS).where('id', '=', row.id).executeTakeFirstOrThrow()) as Row)
    return { result: after, after }
  })
  return { ...saved, token }
}

export type TokenCheck = { ok: true; token: ServiceToken } | { ok: false; reason: 'unknown' | 'revoked' | 'expired' }

/**
 * Check a presented token. `lastUsedAt` is refreshed at most once per `touchEveryMs` so a busy client does not turn
 * every request into a write.
 */
export async function verifyServiceToken(db: Kysely<any>, presented: string, options: { touchEveryMs?: number } = {}): Promise<TokenCheck> {
  if (!presented.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'unknown' }
  const hash = hashToken(presented)
  const row = await db.selectFrom('service_tokens').select([...COLUMNS, 'hash']).where('hash', '=', hash).where('deletedAt', 'is', null).executeTakeFirst()
  if (!row || !timingSafeEqual(Buffer.from(String(row.hash), 'hex'), Buffer.from(hash, 'hex'))) return { ok: false, reason: 'unknown' }
  if (row.revokedAt) return { ok: false, reason: 'revoked' }
  const at = now()
  if (row.expiresAt && row.expiresAt <= at) return { ok: false, reason: 'expired' }
  const { hash: _hash, ...rest } = row
  const token = record(rest as Row)
  if (!token.lastUsedAt || Date.parse(at) - Date.parse(token.lastUsedAt) >= (options.touchEveryMs ?? 60_000)) {
    await db.updateTable('service_tokens').set({ lastUsedAt: at }).where('id', '=', token.id).execute()
    token.lastUsedAt = at
  }
  return { ok: true, token }
}

/** Revoke by id or by name (every live token of that name). Returns what was revoked; the rows stay for the record. */
export async function revokeServiceToken(db: Kysely<any>, idOrName: string): Promise<ServiceToken[]> {
  const live = await db
    .selectFrom('service_tokens')
    .select(COLUMNS)
    .where((eb) => eb.or([eb('id', '=', idOrName), eb('name', '=', idOrName)]))
    .where('revokedAt', 'is', null)
    .where('deletedAt', 'is', null)
    .execute()
  const revoked: ServiceToken[] = []
  for (const row of live) {
    const before = record(row as Row)
    revoked.push(
      await audited(db, { action: 'service_token.revoke', target: `service_token:${before.id}` }, async (trx) => {
        await trx.updateTable('service_tokens').set({ revokedAt: now(), ...touched() }).where('id', '=', before.id).execute()
        const after = record((await trx.selectFrom('service_tokens').select(COLUMNS).where('id', '=', before.id).executeTakeFirstOrThrow()) as Row)
        return { result: after, before, after }
      }),
    )
  }
  return revoked
}

/** Every token, newest first — never the hash. */
export async function listServiceTokens(db: Kysely<any>): Promise<ServiceToken[]> {
  const rows = await db.selectFrom('service_tokens').select(COLUMNS).where('deletedAt', 'is', null).orderBy('createdAt', 'desc').orderBy('id', 'asc').execute()
  return rows.map((row) => record(row as Row))
}
