import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological.
const TABLE_NAME = 'federated_identities'
const PROVIDER_SUBJECT_UNIQUE = 'federated_identities_provider_subject_unique'
const USER_PROVIDER_UNIQUE = 'federated_identities_user_provider_unique'
const USER_ID_INDEX = 'federated_identities_user_id_idx'
const UNIQUE_VIOLATION = '23505'
const NOT_NULL_VIOLATION = '23502'
const FK_VIOLATION = '23503'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const PROVIDER = 'google'
const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-09-08T12:00:00.000Z')

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(federatedIdentities)
  await db.delete(users)
  await db.insert(users).values({
    id: USER_ID,
    email: EMAIL,
    passwordHash: HASH,
    emailVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })
})

const row = (overrides: Partial<typeof federatedIdentities.$inferInsert> = {}) => ({
  id: ROW_ID,
  userId: USER_ID,
  provider: PROVIDER,
  providerUserId: SUBJECT,
  emailAtLink: EMAIL,
  createdAt: NOW,
  ...overrides,
})

describe('federated_identities table', () => {
  it('stores a row with all six columns', async () => {
    await db.insert(federatedIdentities).values(row())

    const [stored] = await db.select().from(federatedIdentities)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.userId).toBe(USER_ID)
    expect(stored?.provider).toBe(PROVIDER)
    expect(stored?.providerUserId).toBe(SUBJECT)
    expect(stored?.emailAtLink).toBe(EMAIL)
    expect(stored?.createdAt).toEqual(NOW)
  })

  it('rejects an insert without created_at, proving there is no default', async () => {
    const { createdAt: _createdAt, ...withoutCreatedAt } = row()

    await expect(
      db.insert(federatedIdentities).values(withoutCreatedAt as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('rejects a row whose user_id has no user (foreign key)', async () => {
    await expect(
      db.insert(federatedIdentities).values(row({ userId: OTHER_ROW_ID })),
    ).rejects.toMatchObject({ cause: { code: FK_VIOLATION } })
  })

  it('deletes the link when its user is deleted (ON DELETE CASCADE)', async () => {
    await db.insert(federatedIdentities).values(row())

    await db.delete(users)

    expect(await db.select().from(federatedIdentities)).toHaveLength(0)
  })

  it('refuses a second link for the same (provider, subject)', async () => {
    await db.insert(federatedIdentities).values(row())

    await expect(
      db.insert(federatedIdentities).values(row({ id: OTHER_ROW_ID })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('refuses a second Google link for the same user', async () => {
    await db.insert(federatedIdentities).values(row())

    await expect(
      db
        .insert(federatedIdentities)
        .values(row({ id: OTHER_ROW_ID, providerUserId: 'a-different-subject' })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('carries the two unique indexes and the user_id index', async () => {
    const result = await db.execute(
      sql`select indexname from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
    }>
    const names = rows.map((each) => each.indexname)

    expect(names).toContain(PROVIDER_SUBJECT_UNIQUE)
    expect(names).toContain(USER_PROVIDER_UNIQUE)
    expect(names).toContain(USER_ID_INDEX)
  })
})
