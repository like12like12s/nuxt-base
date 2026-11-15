// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/users.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The `users` table mirrors who has signed in through the identity provider: one row per subject, with the roles the
// app derived from their groups. It is written on change only — a request from a known user with unchanged details is
// one indexed read, no write and no audit row.
import type { Kysely } from 'kysely'
import { audited, created, fromJson, toJson, touched } from '../db/repo.js'
import type { ProxyIdentity } from './proxy.js'

export interface UserRecord {
  id: string
  subject: string
  email: string | null
  name: string | null
  roles: string[]
}

const COLUMNS = ['id', 'subject', 'email', 'name', 'roles'] as const
const record = (row: { id: string; subject: string; email: string | null; name: string | null; roles: string }): UserRecord => ({
  ...row,
  roles: fromJson<string[]>(row.roles, []),
})

export async function findUser(db: Kysely<any>, subject: string): Promise<UserRecord | null> {
  const row = await db.selectFrom('users').select(COLUMNS).where('subject', '=', subject).where('deletedAt', 'is', null).executeTakeFirst()
  return row ? record(row) : null
}

/** Insert the user on first sight, update the row when email / name / roles changed. The actor of the audit row is the user. */
export async function upsertUser(db: Kysely<any>, identity: ProxyIdentity, roles: readonly string[]): Promise<UserRecord> {
  const wanted = { email: identity.email ?? null, name: identity.name ?? identity.username, roles: [...roles] }
  const existing = await findUser(db, identity.subject)
  if (existing && existing.email === wanted.email && existing.name === wanted.name && toJson(existing.roles) === toJson(wanted.roles)) return existing

  const write = () =>
    audited(db, { action: existing ? 'user.sync' : 'user.create', actor: identity.subject }, async (trx) => {
      const before = await findUser(trx, identity.subject)
      if (before) {
        await trx.updateTable('users').set({ email: wanted.email, name: wanted.name, roles: toJson(wanted.roles), ...touched() }).where('id', '=', before.id).execute()
      } else {
        await trx.insertInto('users').values({ ...created(), subject: identity.subject, email: wanted.email, name: wanted.name, roles: toJson(wanted.roles) }).execute()
      }
      const after = (await findUser(trx, identity.subject))!
      return { result: after, target: `user:${after.id}`, ...(before ? { before } : {}), after }
    })
  try {
    return await write()
  } catch (error) {
    // Two first requests of the same new user at once: the unique index on `subject` lets one insert win.
    const winner = await findUser(db, identity.subject)
    if (!winner) throw error
    return write()
  }
}
