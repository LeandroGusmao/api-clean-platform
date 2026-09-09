import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming
// the index would break the database and still keep this suite green.
const EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'
const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(users)
})

describe('users table', () => {
  // KEEP — the only test bound to the functional index itself. A repository
  // test would prove "duplicate email rejected" without proving which index
  // rejected it, which is the part that silently breaks.
  it('rejects an email that differs from an existing one only by case', async () => {
    await db.insert(users).values({ email: EMAIL, passwordHash: PASSWORD_HASH })

    // Asserting on the constraint name, not just on "it threw": that is what
    // proves the rejection came from the functional index over lower(email)
    // rather than from any other constraint. Drizzle's own error message is
    // just the failed query text; the underlying Postgres error — whose
    // `constraint` field names the violated index verbatim — is preserved as
    // `cause`, so the assertion targets that instead of `.message`.
    await expect(
      db
        .insert(users)
        .values({ email: EMAIL_DIFFERING_ONLY_BY_CASE, passwordHash: PASSWORD_HASH }),
    ).rejects.toMatchObject({ cause: { constraint: EMAIL_LOWER_UNIQUE_INDEX } })
  })

  // KEEP, and it gets MORE valuable over time: once the application sends id
  // and timestamps explicitly, nothing else exercises the column defaults, so
  // this becomes the only proof that the defense-in-depth path still works.
  it('fills id and both timestamps from the column defaults', async () => {
    // Inserting only the two required columns: whatever comes back was produced
    // by the database, which is the defense-in-depth the defaults exist for.
    const [inserted] = await db
      .insert(users)
      .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
      .returning()

    expect(inserted?.id).toMatch(UUID_PATTERN)
    expect(inserted?.createdAt).toBeInstanceOf(Date)
    expect(inserted?.updatedAt).toBeInstanceOf(Date)
  })

  it('accepts a user row with no password hash (federated account)', async () => {
    await db.insert(users).values({ email: EMAIL })

    const [stored] = await db.select().from(users).where(eq(users.email, EMAIL))

    expect(stored?.passwordHash).toBeNull()
  })
})
