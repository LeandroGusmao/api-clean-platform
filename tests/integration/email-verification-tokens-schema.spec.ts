import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { emailVerificationTokens } from '#modules/auth/infra/drizzle/schema/email-verification-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming
// an index would break the database and still keep this suite green.
const USER_ID_INDEX = 'email_verification_tokens_user_id_idx'
const ACTIVE_INDEX = 'email_verification_tokens_active_idx'
const ACTIVE_INDEX_PREDICATE = 'WHERE (consumed_at IS NULL)'
const NOT_NULL_VIOLATION = '23502'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const HASH_LENGTH = 64
const CODE_HASH = 'a'.repeat(HASH_LENGTH)

const TOKEN_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_TOKEN_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const EXPIRES_AT = new Date('2026-12-31T00:00:00.000Z')
const CREATED_AT = new Date('2026-08-31T00:00:00.000Z')
const ZERO_ATTEMPTS = 0

const NO_ROWS = 0
const ONE_INDEX = 1

const USER_MISSING_MESSAGE = 'no user row was stored'

let db: Database
let pool: Pool
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  // `email_verification_tokens` goes first: the cascade would take it anyway,
  // but deleting in dependency order keeps this hook honest about what it is
  // doing.
  await db.delete(emailVerificationTokens)
  await db.delete(users)

  const [stored] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning()

  if (stored === undefined) throw new Error(USER_MISSING_MESSAGE)
  userId = stored.id
})

const row = (overrides: Partial<typeof emailVerificationTokens.$inferInsert> = {}) => ({
  id: TOKEN_ID,
  userId,
  codeHash: CODE_HASH,
  expiresAt: EXPIRES_AT,
  attempts: ZERO_ATTEMPTS,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('email_verification_tokens table', () => {
  it('stores a row with all seven columns', async () => {
    await db.insert(emailVerificationTokens).values(row())

    const [stored] = await db.select().from(emailVerificationTokens)

    expect(stored?.id).toBe(TOKEN_ID)
    expect(stored?.userId).toBe(userId)
    expect(stored?.codeHash).toBe(CODE_HASH)
    expect(stored?.expiresAt).toEqual(EXPIRES_AT)
    expect(stored?.consumedAt).toBeNull()
    expect(stored?.attempts).toBe(ZERO_ATTEMPTS)
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without attempts, proving there is no default', async () => {
    // The entity owns `attempts`; a default here would be a silent second
    // source of truth for a value that has no legitimate direct writer.
    const { attempts: _attempts, ...withoutAttempts } = row()

    await expect(
      db.insert(emailVerificationTokens).values(withoutAttempts as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('deletes a user tokens along with the user', async () => {
    await db.insert(emailVerificationTokens).values(row())

    await db.delete(users)

    expect(await db.select().from(emailVerificationTokens)).toHaveLength(NO_ROWS)
  })

  it('rejects a token pointing at a user that does not exist', async () => {
    const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000'
    const FOREIGN_KEY_VIOLATION = '23503'

    await expect(
      db.insert(emailVerificationTokens).values(row({ userId: UNKNOWN_USER_ID })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } })
  })

  it('accepts a second live token for the same user', async () => {
    // Six digits collide by design — two accounts, or the same account across
    // a reissue, holding the same pending code is ordinary, so the table must
    // not enforce uniqueness on `code_hash`.
    await db.insert(emailVerificationTokens).values(row())
    await db.insert(emailVerificationTokens).values(row({ id: OTHER_TOKEN_ID }))

    const TWO_ROWS = 2
    expect(await db.select().from(emailVerificationTokens)).toHaveLength(TWO_ROWS)
  })

  it('carries the user_id index and the partial active index', async () => {
    const TABLE_NAME = 'email_verification_tokens'

    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
      indexdef: string
    }>

    const userIdIndex = rows.filter((r) => r.indexname === USER_ID_INDEX)
    const activeIndex = rows.filter((r) => r.indexname === ACTIVE_INDEX)

    expect(userIdIndex).toHaveLength(ONE_INDEX)
    expect(activeIndex).toHaveLength(ONE_INDEX)
    expect(activeIndex[0]?.indexdef).toContain(ACTIVE_INDEX_PREDICATE)
  })
})
