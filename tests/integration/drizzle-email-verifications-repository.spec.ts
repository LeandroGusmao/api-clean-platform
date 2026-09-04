import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { EmailVerification } from '#modules/auth/entities/email-verification'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { emailVerificationTokens } from '#modules/auth/infra/drizzle/schema/email-verification-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const TTL_SECONDS = 3600

const NOW = new Date('2026-08-31T12:00:00.000Z')
const EARLIER = new Date('2026-08-31T11:00:00.000Z')
const LATER = new Date('2026-08-31T12:00:05.000Z')
const ALREADY_EXPIRED = new Date('2026-08-31T00:00:00.000Z')

const CODE_HASH_LENGTH = 64
const CODE_HASH_A = 'a'.repeat(CODE_HASH_LENGTH)
const CODE_HASH_B = 'b'.repeat(CODE_HASH_LENGTH)
const CODE_HASH_C = 'c'.repeat(CODE_HASH_LENGTH)

const NO_ATTEMPTS = 0
const ONE_ATTEMPT = 1
const NO_ROWS = 0
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const ID_PAD_LENGTH = 12

const USER_MISSING_MESSAGE = 'no user row was stored'
const NO_WARNINGS = { warn: () => {} }

let db: Database
let pool: Pool
let uow: IAuthUnitOfWork
let userId: string
let otherUserId: string
let sequence = 0

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  uow = createUnitOfWork(createTransactionRunner(db, NO_WARNINGS), authRepositories)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(emailVerificationTokens)
  await db.delete(users)

  const [stored, otherStored] = await db
    .insert(users)
    .values([
      { email: EMAIL, passwordHash: PASSWORD_HASH },
      { email: OTHER_EMAIL, passwordHash: PASSWORD_HASH },
    ])
    .returning()

  if (stored === undefined || otherStored === undefined) {
    throw new Error(USER_MISSING_MESSAGE)
  }
  userId = stored.id
  otherUserId = otherStored.id
})

const nextId = () => {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(ID_PAD_LENGTH, '0')}`
}

const verification = (
  ownerId: string,
  codeHash: string,
  now: Date = NOW,
  id: string = nextId(),
) =>
  EmailVerification.create({
    id,
    userId: ownerId,
    codeHash,
    now,
    ttlSeconds: TTL_SECONDS,
  })

describe('DrizzleEmailVerificationsRepository', () => {
  it('round trips a verification through save and findActiveByUserId', async () => {
    const saved = verification(userId, CODE_HASH_A)

    const found = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(saved)
      return repo.findActiveByUserId(userId)
    })

    expect(found?.id).toBe(saved.id)
    expect(found?.userId).toBe(userId)
    expect(found?.codeHash).toBe(CODE_HASH_A)
    expect(found?.expiresAt).toEqual(saved.expiresAt)
    expect(found?.consumedAt).toBeNull()
    expect(found?.attempts).toBe(NO_ATTEMPTS)
    expect(found?.createdAt).toEqual(saved.createdAt)
  })

  it('returns null when the only row for the user is already consumed', async () => {
    const saved = verification(userId, CODE_HASH_A)

    const found = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(saved)
      await repo.consume(saved.id, LATER)
      return repo.findActiveByUserId(userId)
    })

    expect(found).toBeNull()
  })

  it('returns the MOST RECENT of two unconsumed rows', async () => {
    // A resend leaves the old code standing until it is invalidated; the
    // lookup itself is what must prefer the fresh one — otherwise the stale
    // code would win and the one just emailed to the user would never work.
    const stale = verification(userId, CODE_HASH_A, EARLIER)
    const fresh = verification(userId, CODE_HASH_B, NOW)

    const found = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(stale)
      await repo.save(fresh)
      return repo.findActiveByUserId(userId)
    })

    expect(found?.id).toBe(fresh.id)
    expect(found?.codeHash).toBe(CODE_HASH_B)
  })

  it('does NOT filter expiry: an expired, unconsumed row still comes back', async () => {
    // Whether a code is too old is the entity's judgement against the injected
    // clock (`isUsable`), not the query's — moving it into SQL would put a
    // second clock into a decision the unit tests need to control.
    const expired = verification(userId, CODE_HASH_A, ALREADY_EXPIRED)

    const found = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(expired)
      return repo.findActiveByUserId(userId)
    })

    expect(found?.id).toBe(expired.id)
  })

  it('invalidateActiveForUser consumes every active row of that user and none of another', async () => {
    const first = verification(userId, CODE_HASH_A, EARLIER)
    const second = verification(userId, CODE_HASH_B, NOW)
    const strangers = verification(otherUserId, CODE_HASH_C, NOW)

    await uow(async ({ emailVerifications: repo }) => {
      await repo.save(first)
      await repo.save(second)
      await repo.save(strangers)
      await repo.invalidateActiveForUser(userId, LATER)
    })

    const stored = await db.select().from(emailVerificationTokens)
    const ownedByUser = stored.filter((each) => each.userId === userId)
    const ownedByOther = stored.find((each) => each.userId === otherUserId)

    expect(ownedByUser.every((each) => each.consumedAt !== null)).toBe(true)
    expect(ownedByOther?.consumedAt).toBeNull()
  })

  it('incrementAttempts adds exactly one, in the database', async () => {
    const saved = verification(userId, CODE_HASH_A)

    const found = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(saved)
      await repo.incrementAttempts(saved.id)
      return repo.findActiveByUserId(userId)
    })

    expect(found?.attempts).toBe(ONE_ATTEMPT)
  })

  it('consume returns true on the first call', async () => {
    const saved = verification(userId, CODE_HASH_A)

    const burned = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(saved)
      return repo.consume(saved.id, LATER)
    })

    expect(burned).toBe(true)
  })

  it('consume returns FALSE on the second call — single use, against real Postgres', async () => {
    const saved = verification(userId, CODE_HASH_A)

    const [firstCall, secondCall] = await uow(async ({ emailVerifications: repo }) => {
      await repo.save(saved)
      const first = await repo.consume(saved.id, LATER)
      const second = await repo.consume(saved.id, LATER)
      return [first, second]
    })

    expect(firstCall).toBe(true)
    expect(secondCall).toBe(false)
  })

  it('consume returns false for an id it has never seen', async () => {
    const burned = await uow(({ emailVerifications: repo }) =>
      repo.consume(UNKNOWN_ID, LATER),
    )

    expect(burned).toBe(false)
  })

  it('leaves no rows behind when the transaction rolls back', async () => {
    const failure = uow(async ({ emailVerifications: repo }) => {
      await repo.save(verification(userId, CODE_HASH_A))
      throw new Error('abort')
    })

    await expect(failure).rejects.toThrow()
    expect(await db.select().from(emailVerificationTokens)).toHaveLength(NO_ROWS)
  })
})
