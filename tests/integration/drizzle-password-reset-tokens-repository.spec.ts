import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PersistenceError } from '#infra/database/driver-error'
import {
  DrizzlePasswordResetTokensRepository,
  PasswordResetTokenHashCollisionError,
} from '#modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const EMAIL = 'joao@example.com'
/** A second account, for the collisions that need two `user_id` values. */
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 1800
const MILLISECONDS_PER_SECOND = 1000
const EXPIRES_AT = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)
const COOLDOWN_MS = 60_000
/** Twice the cooldown: far enough past it that a refresh must fire. */
const PAST_COOLDOWN_MS = 120_000

const ID_FIRST = '11111111-1111-4111-8111-111111111111'
const ID_SECOND = '22222222-2222-4222-8222-222222222222'
const DIGEST_A = 'digest:aaa'
const DIGEST_B = 'digest:bbb'

const CONCURRENT = 8
const ONE_WINNER = 1
const ONE_ROW = 1

let db: Database
let pool: Pool
let repo: DrizzlePasswordResetTokensRepository
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzlePasswordResetTokensRepository(db)
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

const insertOtherUser = async (): Promise<string> => {
  const [created] = await db
    .insert(users)
    .values({ email: OTHER_EMAIL, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })

  return created?.id ?? ''
}

const params = (
  overrides: Partial<Parameters<typeof repo.issueOrRefresh>[0]> = {},
): Parameters<typeof repo.issueOrRefresh>[0] => ({
  id: ID_FIRST,
  userId,
  tokenHash: DIGEST_A,
  issuedAt: NOW,
  expiresAt: EXPIRES_AT,
  cooldownCutoff: new Date(NOW.getTime() - COOLDOWN_MS),
  ...overrides,
})

describe('DrizzlePasswordResetTokensRepository', () => {
  it('inserts the first token and returns true', async () => {
    expect(await repo.issueOrRefresh(params())).toBe(true)

    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.tokenHash).toBe(DIGEST_A)
    expect(row?.consumedAt).toBeNull()
  })

  it('refreshes an existing row in place once the cooldown has elapsed', async () => {
    await repo.issueOrRefresh(params())

    const later = new Date(NOW.getTime() + PAST_COOLDOWN_MS)
    const wrote = await repo.issueOrRefresh(
      params({
        id: ID_SECOND,
        tokenHash: DIGEST_B,
        issuedAt: later,
        expiresAt: new Date(later.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
        cooldownCutoff: new Date(later.getTime() - COOLDOWN_MS),
      }),
    )

    expect(wrote).toBe(true)
    const rows = await db.select().from(passwordResetTokens)
    expect(rows).toHaveLength(ONE_ROW)
    // The row the INSERT created, updated in place — the second id never lands.
    expect(rows[0]?.id).toBe(ID_FIRST)
    expect(rows[0]?.tokenHash).toBe(DIGEST_B)
    expect(rows[0]?.issuedAt).toEqual(later)
    expect(rows[0]?.consumedAt).toBeNull()
    // `created_at` is outside the SET clause: it dates the account's first reset.
    expect(rows[0]?.createdAt).toEqual(NOW)
  })

  it('refreshes when the cooldown cutoff exactly equals the stored issued_at', async () => {
    await repo.issueOrRefresh(params())

    // cooldownCutoff === the stored issued_at: the `lte` in the DO UPDATE's
    // WHERE takes this instant; an `lt` would drop it and write nothing.
    const wrote = await repo.issueOrRefresh(
      params({ id: ID_SECOND, tokenHash: DIGEST_B, cooldownCutoff: NOW }),
    )

    expect(wrote).toBe(true)
    const rows = await db.select().from(passwordResetTokens)
    expect(rows).toHaveLength(ONE_ROW)
    expect(rows[0]?.tokenHash).toBe(DIGEST_B)
  })

  it('does not write and returns false inside the cooldown', async () => {
    await repo.issueOrRefresh(params())

    const wrote = await repo.issueOrRefresh(
      params({ id: ID_SECOND, tokenHash: DIGEST_B }),
    )

    expect(wrote).toBe(false)
    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.tokenHash).toBe(DIGEST_A)
    expect(row?.issuedAt).toEqual(NOW)
  })

  it('un-consumes on a refresh, so a fresh forgot revives the flow', async () => {
    await repo.issueOrRefresh(params())
    await repo.consume(ID_FIRST, NOW)

    const later = new Date(NOW.getTime() + PAST_COOLDOWN_MS)
    await repo.issueOrRefresh(
      params({
        tokenHash: DIGEST_B,
        issuedAt: later,
        expiresAt: new Date(later.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
        cooldownCutoff: new Date(later.getTime() - COOLDOWN_MS),
      }),
    )

    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.consumedAt).toBeNull()
  })

  it('lets exactly one of many concurrent first-time issues win', async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_unused, index) =>
        repo.issueOrRefresh(
          params({ id: `${index}0000000-0000-4000-8000-000000000000` }),
        ),
      ),
    )

    // One call INSERTs; every other one conflicts, and its DO UPDATE WHERE is
    // false against the winner's `issued_at`, so it writes nothing.
    expect(results.filter(Boolean)).toHaveLength(ONE_WINNER)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(ONE_ROW)
  })

  it('findByHash matches by digest and returns null for an absent one', async () => {
    await repo.issueOrRefresh(params())

    const found = await repo.findByHash(DIGEST_A)

    expect(found?.id).toBe(ID_FIRST)
    expect(found?.userId).toBe(userId)
    expect(found?.tokenHash).toBe(DIGEST_A)
    // Every timestamp, column by column: two of them transposed would leave
    // `isUsable` comparing the wrong instants and nothing else would notice.
    expect(found?.issuedAt).toEqual(NOW)
    expect(found?.expiresAt).toEqual(EXPIRES_AT)
    expect(found?.consumedAt).toBeNull()
    expect(found?.createdAt).toEqual(NOW)

    expect(await repo.findByHash(DIGEST_B)).toBeNull()
  })

  it('raises the alarm when two accounts land on the same digest', async () => {
    // Unreachable with 32 bytes of randomBytes, and that is exactly the point:
    // what produces this in practice is a generator that regressed, which means
    // issued tokens are predictable. A security incident, not a database error.
    await repo.issueOrRefresh(params())
    const otherUserId = await insertOtherUser()

    await expect(
      repo.issueOrRefresh(params({ id: ID_SECOND, userId: otherUserId })),
    ).rejects.toBeInstanceOf(PasswordResetTokenHashCollisionError)
  })

  it('lets an id collision bubble as an ordinary persistence failure', async () => {
    // Three unique constraints on this table raise 23505: the primary key,
    // `user_id` and `token_hash`. Matching the CODE alone would report a broken
    // `IIdGenerator` as a compromised token generator — this keeps them apart.
    // A fresh `user_id` and a fresh digest leave the primary key as the only
    // constraint this second insert can violate.
    await repo.issueOrRefresh(params())
    const otherUserId = await insertOtherUser()

    const failure = repo.issueOrRefresh(
      params({ userId: otherUserId, tokenHash: DIGEST_B }),
    )

    await expect(failure).rejects.toBeInstanceOf(PersistenceError)
    await expect(failure).rejects.not.toBeInstanceOf(PasswordResetTokenHashCollisionError)
  })

  it('lets exactly one of two concurrent consumes win', async () => {
    await repo.issueOrRefresh(params())

    const outcomes = await Promise.all([
      repo.consume(ID_FIRST, NOW),
      repo.consume(ID_FIRST, NOW),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(ONE_WINNER)
  })
})
