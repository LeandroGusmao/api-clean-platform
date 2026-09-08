import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { DrizzlePendingRegistrationsRepository } from '#modules/auth/infra/drizzle/drizzle-pending-registrations-repository'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { Email } from '#modules/auth/value-objects/email'

const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = 'JOAO@Example.com'
const OTHER_EMAIL = 'maria@example.com'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 900
const MILLISECONDS_PER_SECOND = 1000
const MAX_ATTEMPTS = 5

const DIGEST_A = 'digest:aaa'
const DIGEST_B = 'digest:bbb'
const REISSUED_DIGEST = 'digest:ccc'

const ID_OLDER = '11111111-1111-4111-8111-111111111111'
const ID_NEWER = '22222222-2222-4222-8222-222222222222'

const OLDER_AGE_MS = 120_000
const CONCURRENT_GUESSES = 10
const ONE_WINNER = 1
const ZERO = 0
const START_ATTEMPTS = 3

const PRUNE_RETENTION_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const PRUNED_ONE = 1
const KEPT_ONE = 1

let db: Database
let pool: Pool
let repo: DrizzlePendingRegistrationsRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzlePendingRegistrationsRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(pendingRegistrations)
})

function pendingAt(id: string, ageMs: number, codeHash = DIGEST_A): PendingRegistration {
  const issuedAt = new Date(NOW.getTime() - ageMs)
  return PendingRegistration.fromTrusted({
    id,
    email: Email.create(EMAIL),
    codeHash,
    attempts: ZERO,
    codeIssuedAt: issuedAt,
    expiresAt: new Date(issuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    consumedAt: null,
    createdAt: issuedAt,
  })
}

describe('DrizzlePendingRegistrationsRepository', () => {
  it('returns unconsumed rows for the email, most recent code first, case-insensitively', async () => {
    await repo.save(pendingAt(ID_OLDER, OLDER_AGE_MS, DIGEST_A))
    await repo.save(pendingAt(ID_NEWER, 0, DIGEST_B))

    const found = await repo.findUnconsumedByEmail(Email.create(MIXED_CASE_EMAIL))

    expect(found.map((p) => p.id)).toEqual([ID_NEWER, ID_OLDER])
  })

  it('excludes rows of other emails and consumed rows', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))
    await db.insert(pendingRegistrations).values({
      id: ID_OLDER,
      email: OTHER_EMAIL,
      codeHash: DIGEST_A,
      attempts: ZERO,
      codeIssuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      createdAt: NOW,
    })

    const found = await repo.findUnconsumedByEmail(Email.create(EMAIL))

    expect(found.map((p) => p.id)).toEqual([ID_NEWER])
  })

  it('caps attempts atomically under concurrent wrong guesses', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_GUESSES }, () =>
        repo.registerFailedAttempt(ID_NEWER, MAX_ATTEMPTS),
      ),
    )

    expect(results.filter(Boolean)).toHaveLength(MAX_ATTEMPTS)
    const [row] = await db
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, ID_NEWER))
    expect(row?.attempts).toBe(MAX_ATTEMPTS)
  })

  it('lets exactly one of two concurrent consumes win', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))

    const outcomes = await Promise.all([
      repo.consume(ID_NEWER, NOW),
      repo.consume(ID_NEWER, NOW),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(ONE_WINNER)
  })

  it('reissueCode resets attempts and moves code_issued_at and expires_at', async () => {
    const staleIssuedAt = new Date(NOW.getTime() - OLDER_AGE_MS)
    await db.insert(pendingRegistrations).values({
      id: ID_NEWER,
      email: EMAIL,
      codeHash: DIGEST_A,
      attempts: START_ATTEMPTS,
      codeIssuedAt: staleIssuedAt,
      expiresAt: new Date(
        staleIssuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND,
      ),
      createdAt: staleIssuedAt,
    })
    const newExpiry = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)

    await repo.reissueCode(ID_NEWER, REISSUED_DIGEST, NOW, newExpiry)

    const [row] = await db
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, ID_NEWER))
    expect(row?.codeHash).toBe(REISSUED_DIGEST)
    expect(row?.attempts).toBe(ZERO)
    expect(row?.codeIssuedAt).toEqual(NOW)
    expect(row?.expiresAt).toEqual(newExpiry)
    // created_at is untouched.
    expect(row?.createdAt).toEqual(staleIssuedAt)
  })

  it('deleteExpiredByEmail removes expired and consumed rows, keeps live ones', async () => {
    await repo.save(pendingAt(ID_NEWER, 0)) // live
    await repo.save(pendingAt(ID_OLDER, TTL_SECONDS * MILLISECONDS_PER_SECOND, DIGEST_B)) // expired

    await repo.deleteExpiredByEmail(Email.create(EMAIL), NOW)

    const remaining = await db.select().from(pendingRegistrations)
    expect(remaining.map((r) => r.id)).toEqual([ID_NEWER])
  })

  it('deleteExpiredBefore removes only rows expired at or before the cutoff, and counts them', async () => {
    const cutoff = new Date(NOW.getTime() - PRUNE_RETENTION_MS)
    const deadAgeMs = PRUNE_RETENTION_MS + TTL_SECONDS * MILLISECONDS_PER_SECOND + HOUR_MS
    await repo.save(pendingAt(ID_OLDER, deadAgeMs, DIGEST_A))
    // Expired, but still inside the retention window — must survive.
    await repo.save(pendingAt(ID_NEWER, HOUR_MS, DIGEST_B))

    const deleted = await repo.deleteExpiredBefore(cutoff)

    expect(deleted).toBe(PRUNED_ONE)
    const survivors = await db.select().from(pendingRegistrations)
    expect(survivors).toHaveLength(KEPT_ONE)
    expect(survivors[0]?.id).toBe(ID_NEWER)
  })
})
