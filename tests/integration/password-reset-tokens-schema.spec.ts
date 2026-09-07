import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would keep this suite green through a rename that
// breaks the database.
const TABLE_NAME = 'password_reset_tokens'
const USER_ID_UNIQUE_INDEX = 'password_reset_tokens_user_id_unique'
const TOKEN_HASH_UNIQUE_INDEX = 'password_reset_tokens_token_hash_unique'
const NOT_NULL_VIOLATION = '23502'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

const HASH_LENGTH = 64
const TOKEN_HASH = 'a'.repeat(HASH_LENGTH)
const OTHER_TOKEN_HASH = 'b'.repeat(HASH_LENGTH)
const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'argon2-does-not-matter-here'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const ISSUED_AT = new Date('2026-09-07T00:00:00.000Z')
const EXPIRES_AT = new Date('2026-09-07T00:30:00.000Z')
const CREATED_AT = new Date('2026-09-07T00:00:00.000Z')

const ONE_INDEX = 1

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
  await db.delete(passwordResetTokens)
  await db.delete(users)
  const [created] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })
  userId = created?.id ?? ''
})

const row = (overrides: Partial<typeof passwordResetTokens.$inferInsert> = {}) => ({
  id: ROW_ID,
  userId,
  tokenHash: TOKEN_HASH,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('password_reset_tokens table', () => {
  it('stores a row with all seven columns', async () => {
    await db.insert(passwordResetTokens).values(row())
    const [stored] = await db.select().from(passwordResetTokens)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.userId).toBe(userId)
    expect(stored?.tokenHash).toBe(TOKEN_HASH)
    expect(stored?.issuedAt).toEqual(ISSUED_AT)
    expect(stored?.expiresAt).toEqual(EXPIRES_AT)
    expect(stored?.consumedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without issued_at, proving there is no default', async () => {
    const { issuedAt: _drop, ...withoutIssuedAt } = row()
    await expect(
      db.insert(passwordResetTokens).values(withoutIssuedAt as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('allows only one row per user', async () => {
    await db.insert(passwordResetTokens).values(row())
    await expect(
      db
        .insert(passwordResetTokens)
        .values(row({ id: OTHER_ROW_ID, tokenHash: OTHER_TOKEN_HASH })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('rejects a token_hash already used by another row', async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'maria@example.com', passwordHash: PASSWORD_HASH })
      .returning({ id: users.id })
    await db.insert(passwordResetTokens).values(row())
    await expect(
      db
        .insert(passwordResetTokens)
        .values(row({ id: OTHER_ROW_ID, userId: otherUser?.id ?? '' })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('rejects a row for a user that does not exist', async () => {
    await expect(
      db.insert(passwordResetTokens).values(row({ userId: MISSING_USER_ID })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } })
  })

  it('deletes the token when its user is deleted', async () => {
    await db.insert(passwordResetTokens).values(row())
    await db.delete(users)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(0)
  })

  it('carries both unique indexes', async () => {
    const result = await db.execute(
      sql`select indexname from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
    }>
    expect(rows.filter((r) => r.indexname === USER_ID_UNIQUE_INDEX)).toHaveLength(
      ONE_INDEX,
    )
    expect(rows.filter((r) => r.indexname === TOKEN_HASH_UNIQUE_INDEX)).toHaveLength(
      ONE_INDEX,
    )
  })
})
