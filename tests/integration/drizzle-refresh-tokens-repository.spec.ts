import { setTimeout as sleep } from 'node:timers/promises'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PersistenceError } from '#infra/database/driver-error'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { RefreshTokenHashCollisionError } from '#modules/auth/infra/drizzle/drizzle-refresh-tokens-repository'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'

/** Far enough that it never binds. */
const FAR_CEILING = new Date('2099-01-01T00:00:00.000Z')

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const TTL_SECONDS = 3600
const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:00:05.000Z')

const FAMILY_A = '11112222-3333-4444-8555-666677778888'
const FAMILY_B = '99990000-1111-4222-8333-444455556666'

const HASH_LENGTH = 64
const HASH_A = 'a'.repeat(HASH_LENGTH)
const HASH_B = 'b'.repeat(HASH_LENGTH)
const HASH_C = 'c'.repeat(HASH_LENGTH)
const UNKNOWN_HASH = 'f'.repeat(HASH_LENGTH)
/** Deliberately given to two different tokens, to force the unique violation. */
const SHARED_HASH = 'd'.repeat(HASH_LENGTH)

const USER_MISSING_MESSAGE = 'no user row was stored'
const NO_WARNINGS = { warn: () => {} }

/** Comfortably under ROTATION_LOCK_TIMEOUT_MS, so the waiter waits rather than 55P03s. */
const HOLD_MS = 300
const CONTENTION_DELAY_MS = 100

const NO_ROWS = 0
const ONE_ROW = 1
const TWO_ROWS = 2
const ID_PAD_LENGTH = 12

const PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const PRUNED_ONE = 1
const KEPT_ONE = 1

const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

let db: Database
let pool: Pool
let uow: IAuthUnitOfWork
let userId: string
let sequence = 0

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  uow = createUnitOfWork(createTransactionRunner(db, NO_WARNINGS), authRepositories)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(users)

  const [stored] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning()

  if (stored === undefined) throw new Error(USER_MISSING_MESSAGE)
  userId = stored.id
})

const nextId = () => {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(ID_PAD_LENGTH, '0')}`
}

const token = (familyId: string, hash: string, id: string = nextId()) =>
  RefreshToken.create({
    id,
    userId,
    tokenHash: hash,
    familyId,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    lifetimeCeiling: FAR_CEILING,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

describe('DrizzleRefreshTokensRepository', () => {
  it('round trips a token through save and findByHashForUpdate', async () => {
    const saved = token(FAMILY_A, HASH_A)

    const found = await uow(async ({ refreshTokens: repo }) => {
      await repo.save(saved)
      return repo.findByHashForUpdate(saved.tokenHash)
    })

    expect(found?.id).toBe(saved.id)
    expect(found?.familyId).toBe(FAMILY_A)
    expect(found?.expiresAt).toEqual(saved.expiresAt)
    expect(found?.revokedAt).toBeNull()
    expect(found?.replacedBy).toBeNull()
  })

  it('returns null for a hash it has never seen', async () => {
    const found = await uow(({ refreshTokens: repo }) =>
      repo.findByHashForUpdate(UNKNOWN_HASH),
    )

    expect(found).toBeNull()
  })

  it('markRotated sets both revokedAt and replacedBy in one write', async () => {
    const current = token(FAMILY_A, HASH_A)
    const successor = token(FAMILY_A, HASH_B)

    const rotated = await uow(async ({ refreshTokens: repo }) => {
      await repo.save(current)
      await repo.save(successor)
      await repo.markRotated(current.id, successor.id, LATER)
      return repo.findByHashForUpdate(current.tokenHash)
    })

    expect(rotated?.revokedAt).toEqual(LATER)
    expect(rotated?.replacedBy).toBe(successor.id)
  })

  it('revokeFamily revokes the whole chain and leaves another chain alone', async () => {
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(token(FAMILY_A, HASH_B))
      await repo.save(token(FAMILY_B, HASH_C))
      await repo.revokeFamily(FAMILY_A, LATER)
    })

    const stored = await db.select().from(refreshTokens)
    const revoked = stored.filter((each) => each.revokedAt !== null)

    expect(revoked).toHaveLength(TWO_ROWS)
    expect(stored.find((each) => each.familyId === FAMILY_B)?.revokedAt).toBeNull()
  })

  it('revokeFamily does NOT push an already-revoked token forward', async () => {
    // Sliding `revokedAt` would slide the grace window with it, keeping a token
    // that should already be dead alive for another 30 seconds every time the
    // family is revoked again.
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.revokeFamily(FAMILY_A, NOW)
      await repo.revokeFamily(FAMILY_A, LATER)
    })

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.revokedAt).toEqual(NOW)
  })

  it('revokeFamily returns how many rows it revoked, and zero the second time', async () => {
    const counts: number[] = []

    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(token(FAMILY_A, HASH_B))
      await repo.save(token(FAMILY_B, HASH_C))
      counts.push(await repo.revokeFamily(FAMILY_A, NOW))
      counts.push(await repo.revokeFamily(FAMILY_A, LATER))
    })

    expect(counts).toEqual([TWO_ROWS, NO_ROWS])
  })

  it('revoke returns one for a live token, and zero once it is already dead', async () => {
    const counts: number[] = []

    await uow(async ({ refreshTokens: repo }) => {
      const live = token(FAMILY_A, HASH_A)
      await repo.save(live)
      counts.push(await repo.revoke(live.id, NOW))
      counts.push(await repo.revoke(live.id, LATER))
    })

    expect(counts).toEqual([ONE_ROW, NO_ROWS])
  })

  it('revokeAllForUser revokes across every family of that user', async () => {
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(token(FAMILY_B, HASH_B))
      await repo.revokeAllForUser(userId, LATER)
    })

    const stored = await db.select().from(refreshTokens)

    expect(stored.every((each) => each.revokedAt !== null)).toBe(true)
  })

  it('names a token_hash collision instead of burying it in a generic failure', async () => {
    // Unreachable with 32 bytes of randomBytes, and that is exactly the point:
    // what produces this in practice is a generator that regressed, which means
    // issued tokens are predictable. A security incident, not a database error.
    await expect(
      uow(async ({ refreshTokens: repo }) => {
        await repo.save(token(FAMILY_A, SHARED_HASH))
        await repo.save(token(FAMILY_A, SHARED_HASH))
      }),
    ).rejects.toBeInstanceOf(RefreshTokenHashCollisionError)
  })

  it('lets an id collision bubble as an ordinary persistence failure', async () => {
    // The primary key raises 23505 too. Matching the CODE alone would report a
    // broken IIdGenerator as a compromised token generator — this is the test
    // that keeps the two apart.
    const first = token(FAMILY_A, HASH_A)

    const failure = uow(async ({ refreshTokens: repo }) => {
      await repo.save(first)
      await repo.save(token(FAMILY_A, HASH_B, first.id))
    })

    await expect(failure).rejects.toBeInstanceOf(PersistenceError)
    await expect(failure).rejects.not.toBeInstanceOf(RefreshTokenHashCollisionError)
  })

  it('makes a second reader WAIT for the first transaction to commit', async () => {
    // THE test that defends `.for('update')`, and it lives here rather than in
    // the HTTP suite for a reason worth knowing: end to end, the lock is
    // invisible. With the grace window on, the rotation branch and the grace
    // branch produce the same visible answer — 200, new pair, same family — so
    // two simultaneous refreshes look identical with and without the lock. Only
    // at this level is the difference observable: without it, the second read
    // returns the stale row immediately.
    const current = token(FAMILY_A, HASH_A)
    const successor = token(FAMILY_A, HASH_B)
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(current)
      await repo.save(successor)
    })

    const first = uow(async ({ refreshTokens: repo }) => {
      await repo.findByHashForUpdate(current.tokenHash)
      await repo.markRotated(current.id, successor.id, LATER)
      // Hold the lock, but well under the 1s `ROTATION_LOCK_TIMEOUT_MS` the
      // repository sets — going over it would fail the waiter with 55P03
      // instead of making it wait.
      await sleep(HOLD_MS)
    })

    await sleep(CONTENTION_DELAY_MS)
    const seen = await uow(({ refreshTokens: repo }) =>
      repo.findByHashForUpdate(current.tokenHash),
    )
    await first

    expect(seen?.revokedAt).toEqual(LATER)
    expect(seen?.replacedBy).toBe(successor.id)
  })

  it('leaves no rows behind when the transaction rolls back', async () => {
    const failure = uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      throw new Error('abort')
    })

    await expect(failure).rejects.toThrow()
    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
  })

  it('findActiveByUserId returns the live row of each family for that user', async () => {
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(token(FAMILY_B, HASH_B))
    })

    const active = await uow(({ refreshTokens: repo }) =>
      repo.findActiveByUserId(userId, NOW),
    )

    expect(active.map((each) => each.familyId).sort()).toEqual(
      [FAMILY_A, FAMILY_B].sort(),
    )
  })

  it('findActiveByUserId excludes a revoked row', async () => {
    const revoked = token(FAMILY_A, HASH_A)
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(revoked)
      await repo.revoke(revoked.id, LATER)
    })

    const active = await uow(({ refreshTokens: repo }) =>
      repo.findActiveByUserId(userId, NOW),
    )

    expect(active).toHaveLength(NO_ROWS)
  })

  it('findActiveByUserId excludes an expired but never-revoked row', async () => {
    const expired = RefreshToken.fromTrusted({
      id: nextId(),
      userId,
      tokenHash: HASH_A,
      familyId: FAMILY_A,
      expiresAt: NOW,
      revokedAt: null,
      replacedBy: null,
      createdAt: NOW,
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })
    await uow(({ refreshTokens: repo }) => repo.save(expired))

    // Inclusive at the boundary, like `RefreshToken.isExpired`: an instant that
    // has arrived is spent.
    const active = await uow(({ refreshTokens: repo }) =>
      repo.findActiveByUserId(userId, NOW),
    )

    expect(active).toHaveLength(NO_ROWS)
  })

  it("findActiveByUserId excludes another user's rows", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'other@example.com', passwordHash: PASSWORD_HASH })
      .returning()
    if (otherUser === undefined) throw new Error(USER_MISSING_MESSAGE)

    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(
        RefreshToken.create({
          id: nextId(),
          userId: otherUser.id,
          tokenHash: HASH_B,
          familyId: FAMILY_B,
          now: NOW,
          ttlSeconds: TTL_SECONDS,
          lifetimeCeiling: FAR_CEILING,
          ip: IP,
          deviceLabel: DEVICE_LABEL,
          sessionStartedAt: SESSION_STARTED_AT,
        }),
      )
    })

    const active = await uow(({ refreshTokens: repo }) =>
      repo.findActiveByUserId(userId, NOW),
    )

    expect(active).toHaveLength(KEPT_ONE)
    expect(active[0]?.familyId).toBe(FAMILY_A)
  })

  it('deleteExpiredBefore removes only rows expired at or before the cutoff, and counts them', async () => {
    const cutoff = new Date(NOW.getTime() - PRUNE_RETENTION_MS)
    const dead = RefreshToken.fromTrusted({
      id: nextId(),
      userId,
      tokenHash: HASH_A,
      familyId: FAMILY_A,
      expiresAt: new Date(cutoff.getTime() - ONE_HOUR_MS),
      revokedAt: null,
      replacedBy: null,
      createdAt: new Date(cutoff.getTime() - ONE_HOUR_MS),
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })
    // Expired, but still inside the retention window — must survive.
    const alive = RefreshToken.fromTrusted({
      id: nextId(),
      userId,
      tokenHash: HASH_B,
      familyId: FAMILY_A,
      expiresAt: new Date(cutoff.getTime() + ONE_HOUR_MS),
      revokedAt: null,
      replacedBy: null,
      createdAt: new Date(cutoff.getTime() + ONE_HOUR_MS),
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    const deleted = await uow(async ({ refreshTokens: repo }) => {
      await repo.save(dead)
      await repo.save(alive)
      return repo.deleteExpiredBefore(cutoff)
    })

    expect(deleted).toBe(PRUNED_ONE)
    const survivors = await db.select().from(refreshTokens)
    expect(survivors).toHaveLength(KEPT_ONE)
    expect(survivors[0]?.id).toBe(alive.id)
  })
})
