import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { DrizzleAccountExistsNoticesRepository } from '#modules/auth/infra/drizzle/drizzle-account-exists-notices-repository'
import { accountExistsNotices } from '#modules/auth/infra/drizzle/schema/account-exists-notices'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const NOW = new Date('2026-09-21T12:00:00.000Z')
const COOLDOWN_MS = 60_000
/** One millisecond short of the cooldown: still inside it. */
const INSIDE_COOLDOWN_MS = COOLDOWN_MS - 1

const CONCURRENT = 8
const ONE_WINNER = 1
const ONE_ROW = 1
const NO_ROWS = 0

let db: Database
let pool: Pool
let repo: DrizzleAccountExistsNoticesRepository
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzleAccountExistsNoticesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

async function insertUser(email: string): Promise<string> {
  const [created] = await db
    .insert(users)
    .values({ email, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })

  return created?.id ?? ''
}

beforeEach(async () => {
  await db.delete(accountExistsNotices)
  await db.delete(users)
  userId = await insertUser(EMAIL)
})

function claimAt(at: Date, forUserId = userId): Promise<boolean> {
  return repo.claim({
    userId: forUserId,
    sentAt: at,
    cooldownCutoff: new Date(at.getTime() - COOLDOWN_MS),
  })
}

describe('DrizzleAccountExistsNoticesRepository', () => {
  it('claims the first notice for an account', async () => {
    expect(await claimAt(NOW)).toBe(true)

    const [row] = await db.select().from(accountExistsNotices)
    expect(row?.userId).toBe(userId)
    expect(row?.sentAt).toEqual(NOW)
  })

  it('refuses a second claim inside the cooldown and leaves the first stamp', async () => {
    await claimAt(NOW)

    expect(await claimAt(new Date(NOW.getTime() + INSIDE_COOLDOWN_MS))).toBe(false)

    const [row] = await db.select().from(accountExistsNotices)
    expect(row?.sentAt).toEqual(NOW)
  })

  it('claims again once the cooldown has elapsed, in place', async () => {
    await claimAt(NOW)
    const later = new Date(NOW.getTime() + COOLDOWN_MS)

    expect(await claimAt(later)).toBe(true)

    const rows = await db.select().from(accountExistsNotices)
    expect(rows).toHaveLength(ONE_ROW)
    expect(rows[0]?.sentAt).toEqual(later)
  })

  it('lets exactly one of many concurrent claims win', async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => claimAt(NOW)),
    )

    expect(results.filter(Boolean)).toHaveLength(ONE_WINNER)
  })

  it('keeps each account independent', async () => {
    const otherUserId = await insertUser(OTHER_EMAIL)
    await claimAt(NOW)

    expect(await claimAt(NOW, otherUserId)).toBe(true)
  })

  it('goes away with the account it belongs to', async () => {
    await claimAt(NOW)

    await db.delete(users).where(eq(users.id, userId))

    expect(await db.select().from(accountExistsNotices)).toHaveLength(NO_ROWS)
  })
})
