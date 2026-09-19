import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming
// the index would break the database and still keep this suite green.
const TOKEN_HASH_UNIQUE_INDEX = 'refresh_tokens_token_hash_unique'
const FOREIGN_KEY_VIOLATION = '23503'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const HASH_LENGTH = 64
const TOKEN_HASH = 'a'.repeat(HASH_LENGTH)
const OTHER_TOKEN_HASH = 'b'.repeat(HASH_LENGTH)
const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000'
const TOKEN_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_TOKEN_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'

const EXPIRES_AT = new Date('2026-12-31T00:00:00.000Z')
const CREATED_AT = new Date('2026-08-31T00:00:00.000Z')

const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

const NO_ROWS = 0
const TWO_ROWS = 2

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
  // `refresh_tokens` goes first: the cascade would take it anyway, but deleting
  // in dependency order keeps this hook honest about what it is doing.
  await db.delete(refreshTokens)
  await db.delete(users)

  const [stored] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning()

  if (stored === undefined) throw new Error(USER_MISSING_MESSAGE)
  userId = stored.id
})

const row = (overrides: Partial<typeof refreshTokens.$inferInsert> = {}) => ({
  id: TOKEN_ID,
  userId,
  tokenHash: TOKEN_HASH,
  familyId: FAMILY_ID,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('refresh_tokens table', () => {
  it('rejects a duplicate token_hash, naming the unique index', async () => {
    await db.insert(refreshTokens).values(row())

    // Asserting on the constraint NAME, not just on "it threw": that is what
    // proves the rejection came from the token_hash index rather than from the
    // primary key, which raises 23505 as well.
    await expect(
      db.insert(refreshTokens).values(row({ id: OTHER_TOKEN_ID })),
    ).rejects.toMatchObject({ cause: { constraint: TOKEN_HASH_UNIQUE_INDEX } })
  })

  it('rejects a token pointing at a user that does not exist', async () => {
    await expect(
      db.insert(refreshTokens).values(row({ userId: UNKNOWN_USER_ID })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } })
  })

  it('deletes a user tokens along with the user', async () => {
    await db.insert(refreshTokens).values(row())

    await db.delete(users)

    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
  })

  it('stores revoked_at and replaced_by as nullable, and defaults neither', async () => {
    // The reserved seats of the state machine. If a default ever appears on
    // either, a freshly inserted token would read as already revoked or
    // already replaced, and the grace window would misfire on every rotation.
    await db.insert(refreshTokens).values(row())

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.revokedAt).toBeNull()
    expect(stored?.replacedBy).toBeNull()
  })

  it('stores the device context as nullable, and defaults none of it', async () => {
    // A row written before these columns existed has no context, and nothing
    // may invent one for it: an inserted default would make "never recorded"
    // read exactly like "recorded and unrecognised".
    await db.insert(refreshTokens).values(row())

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.ip).toBeNull()
    expect(stored?.deviceLabel).toBeNull()
    expect(stored?.sessionStartedAt).toBeNull()
  })

  it('round-trips the device context', async () => {
    await db
      .insert(refreshTokens)
      .values(
        row({ ip: IP, deviceLabel: DEVICE_LABEL, sessionStartedAt: SESSION_STARTED_AT }),
      )

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.ip).toBe(IP)
    expect(stored?.deviceLabel).toBe(DEVICE_LABEL)
    expect(stored?.sessionStartedAt).toEqual(SESSION_STARTED_AT)
  })

  it('accepts a second live token in the same family', async () => {
    // The application keeps at most one live token per family at commit time,
    // but the TABLE must not enforce that, and this test is what would catch
    // someone adding a partial unique index on family_id to "help".
    //
    // The reason is unavoidable: a normal rotation has to insert the successor
    // before it can call markRotated with the successor's id, so both rows are
    // live for the span of two statements inside every single transaction.
    await db.insert(refreshTokens).values(row())
    await db
      .insert(refreshTokens)
      .values(row({ id: OTHER_TOKEN_ID, tokenHash: OTHER_TOKEN_HASH }))

    expect(await db.select().from(refreshTokens)).toHaveLength(TWO_ROWS)
  })
})
