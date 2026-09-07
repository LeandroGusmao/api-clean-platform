import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import { CRON_EXIT_OK, cronExitCode, runCron } from '#main/run-cron'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const EMAIL = 'joao@example.com'
/** A second account: `password_reset_tokens` allows one live token per user. */
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const HASH_LENGTH = 64
const EXPECTED_JOBS = 3
const ROWS_DELETED_PER_JOB = 1
const SURVIVORS_PER_TABLE = 1

const DAY_MS = 24 * 60 * 60 * 1000
/** Past every retention window (the longest is 7 days, for refresh tokens). */
const LONG_AGO_MS = 8 * DAY_MS
const RECENTLY_MS = 60 * 60 * 1000

/** Only `makeContainer` needs it; the cron run logs nothing itself. */
const SILENT_LOGGER = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as AppLogger

let db: Database
let pool: Pool
let userId: string
let otherUserId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(pendingRegistrations)
  await db.delete(passwordResetTokens)
  await db.delete(users)
  const inserted = await db
    .insert(users)
    .values([
      { email: EMAIL, passwordHash: PASSWORD_HASH },
      { email: OTHER_EMAIL, passwordHash: PASSWORD_HASH },
    ])
    .returning({ id: users.id })
  userId = inserted[0]?.id ?? ''
  otherUserId = inserted[1]?.id ?? ''
})

const ago = (ms: number) => new Date(Date.now() - ms)

describe('runCron', () => {
  it('prunes the long-dead rows of every table and keeps the recent ones', async () => {
    const dead = ago(LONG_AGO_MS)
    const recent = ago(RECENTLY_MS)

    await db.insert(refreshTokens).values([
      {
        id: randomUUID(),
        userId,
        tokenHash: 'a'.repeat(HASH_LENGTH),
        familyId: randomUUID(),
        expiresAt: dead,
        createdAt: dead,
      },
      {
        id: randomUUID(),
        userId,
        tokenHash: 'b'.repeat(HASH_LENGTH),
        familyId: randomUUID(),
        expiresAt: recent,
        createdAt: recent,
      },
    ])
    await db.insert(pendingRegistrations).values([
      {
        id: randomUUID(),
        email: EMAIL,
        codeHash: 'digest:dead',
        attempts: 0,
        codeIssuedAt: dead,
        expiresAt: dead,
        createdAt: dead,
      },
      {
        id: randomUUID(),
        email: EMAIL,
        codeHash: 'digest:recent',
        attempts: 0,
        codeIssuedAt: recent,
        expiresAt: recent,
        createdAt: recent,
      },
    ])
    await db.insert(passwordResetTokens).values([
      {
        id: randomUUID(),
        userId,
        tokenHash: 'c'.repeat(HASH_LENGTH),
        issuedAt: dead,
        expiresAt: dead,
        consumedAt: null,
        createdAt: dead,
      },
      {
        id: randomUUID(),
        userId: otherUserId,
        tokenHash: 'd'.repeat(HASH_LENGTH),
        issuedAt: recent,
        expiresAt: recent,
        consumedAt: null,
        createdAt: recent,
      },
    ])

    const outcomes = await runCron(env, SILENT_LOGGER)

    expect(outcomes).toHaveLength(EXPECTED_JOBS)
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
    expect(outcomes.map((outcome) => outcome.metrics?.rowsDeleted)).toEqual([
      ROWS_DELETED_PER_JOB,
      ROWS_DELETED_PER_JOB,
      ROWS_DELETED_PER_JOB,
    ])
    expect(cronExitCode(outcomes)).toBe(CRON_EXIT_OK)

    expect(await db.select().from(refreshTokens)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(SURVIVORS_PER_TABLE)
  })
})
