import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming an
// index would break the database and still keep this suite green.
const TABLE_NAME = 'pending_registrations'
const EMAIL_LOWER_INDEX = 'pending_registrations_email_lower_idx'
const ACTIVE_INDEX = 'pending_registrations_active_idx'
const ACTIVE_INDEX_PREDICATE = 'WHERE (consumed_at IS NULL)'
const LOWER_EXPRESSION = 'lower(email)'
const NOT_NULL_VIOLATION = '23502'

const HASH_LENGTH = 64
const CODE_HASH = 'a'.repeat(HASH_LENGTH)
const EMAIL = 'joao@example.com'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CODE_ISSUED_AT = new Date('2026-09-07T00:00:00.000Z')
const EXPIRES_AT = new Date('2026-09-07T00:15:00.000Z')
const CREATED_AT = new Date('2026-09-07T00:00:00.000Z')
const ZERO_ATTEMPTS = 0

const ONE_INDEX = 1
const TWO_ROWS = 2

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(pendingRegistrations)
})

const row = (overrides: Partial<typeof pendingRegistrations.$inferInsert> = {}) => ({
  id: ROW_ID,
  email: EMAIL,
  codeHash: CODE_HASH,
  attempts: ZERO_ATTEMPTS,
  codeIssuedAt: CODE_ISSUED_AT,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('pending_registrations table', () => {
  it('stores a row with all eight columns', async () => {
    await db.insert(pendingRegistrations).values(row())

    const [stored] = await db.select().from(pendingRegistrations)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.email).toBe(EMAIL)
    expect(stored?.codeHash).toBe(CODE_HASH)
    expect(stored?.attempts).toBe(ZERO_ATTEMPTS)
    expect(stored?.codeIssuedAt).toEqual(CODE_ISSUED_AT)
    expect(stored?.expiresAt).toEqual(EXPIRES_AT)
    expect(stored?.consumedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without attempts, proving there is no default', async () => {
    const { attempts: _attempts, ...withoutAttempts } = row()

    await expect(
      db.insert(pendingRegistrations).values(withoutAttempts as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('accepts several coexisting rows for the same email', async () => {
    // Fungible pendings for one address is the whole design: the table must not
    // enforce uniqueness on `email`.
    await db.insert(pendingRegistrations).values(row())
    await db.insert(pendingRegistrations).values(row({ id: OTHER_ROW_ID }))

    expect(await db.select().from(pendingRegistrations)).toHaveLength(TWO_ROWS)
  })

  it('carries the plain lower(email) index and the partial active index', async () => {
    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
      indexdef: string
    }>

    const emailLower = rows.filter((r) => r.indexname === EMAIL_LOWER_INDEX)
    const active = rows.filter((r) => r.indexname === ACTIVE_INDEX)

    expect(emailLower).toHaveLength(ONE_INDEX)
    expect(emailLower[0]?.indexdef).toContain(LOWER_EXPRESSION)
    expect(active).toHaveLength(ONE_INDEX)
    expect(active[0]?.indexdef).toContain(LOWER_EXPRESSION)
    expect(active[0]?.indexdef).toContain(ACTIVE_INDEX_PREDICATE)
  })
})
