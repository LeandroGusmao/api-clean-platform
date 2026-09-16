import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import {
  AUTH_MODULE,
  CRON_EXIT_OK,
  CronInvocationError,
  cronExitCode,
  JOB_NAME_SEPARATOR,
  runCron,
} from '#main/run-cron'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { DISPATCH_OUTBOX_MESSAGES_JOB } from '#modules/auth/use-cases/dispatch-outbox-messages'
import { PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB } from '#modules/auth/use-cases/prune-expired-password-reset-tokens'
import { PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB } from '#modules/auth/use-cases/prune-expired-pending-registrations'
import { PRUNE_EXPIRED_REFRESH_TOKENS_JOB } from '#modules/auth/use-cases/prune-expired-refresh-tokens'
import { PRUNE_OUTBOX_MESSAGES_JOB } from '#modules/auth/use-cases/prune-outbox-messages'

const EMAIL = 'joao@example.com'
/** A second account: `password_reset_tokens` allows one live token per user. */
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const HASH_LENGTH = 64
const EXPECTED_JOBS = 5
const ONE_JOB = 1
const ROWS_DELETED_PER_JOB = 1
const NONE = 0
const SURVIVORS_PER_TABLE = 1
/** Both rows still there — the table's job never ran. */
const SEEDED_PER_TABLE = 2
const UNKNOWN_SELECTOR = 'auth:no-such-job'

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
  await db.delete(outboxMessages)
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

/** One row past every retention window and one inside it, in each of the three tables. */
async function seedDeadAndRecentRows(): Promise<void> {
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
}

describe('runCron', () => {
  it('with no selector, prunes the long-dead rows of every table and keeps the recent ones', async () => {
    await seedDeadAndRecentRows()

    const outcomes = await runCron(env, SILENT_LOGGER)

    expect(outcomes).toHaveLength(EXPECTED_JOBS)
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
    expect(cronExitCode(outcomes)).toBe(CRON_EXIT_OK)

    const rowsDeletedFor = (job: string) =>
      outcomes.find((outcome) => outcome.name.endsWith(job))?.metrics?.rowsDeleted

    expect(rowsDeletedFor(PRUNE_EXPIRED_REFRESH_TOKENS_JOB)).toBe(ROWS_DELETED_PER_JOB)
    expect(rowsDeletedFor(PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB)).toBe(
      ROWS_DELETED_PER_JOB,
    )
    expect(rowsDeletedFor(PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB)).toBe(
      ROWS_DELETED_PER_JOB,
    )
    expect(rowsDeletedFor(PRUNE_OUTBOX_MESSAGES_JOB)).toBe(NONE)

    const dispatchOutcome = outcomes.find((outcome) =>
      outcome.name.endsWith(DISPATCH_OUTBOX_MESSAGES_JOB),
    )
    expect(dispatchOutcome?.metrics).toEqual({ dispatched: NONE, failed: NONE })

    expect(await db.select().from(refreshTokens)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(SURVIVORS_PER_TABLE)
  })

  it('with a qualified selector, runs that job alone and leaves the other tables untouched', async () => {
    await seedDeadAndRecentRows()

    const outcomes = await runCron(
      env,
      SILENT_LOGGER,
      `${AUTH_MODULE}${JOB_NAME_SEPARATOR}${PRUNE_EXPIRED_REFRESH_TOKENS_JOB}`,
    )

    expect(outcomes).toHaveLength(ONE_JOB)
    expect(outcomes[0]?.name).toBe(
      `${AUTH_MODULE}${JOB_NAME_SEPARATOR}${PRUNE_EXPIRED_REFRESH_TOKENS_JOB}`,
    )
    expect(outcomes[0]?.metrics?.rowsDeleted).toBe(ROWS_DELETED_PER_JOB)

    expect(await db.select().from(refreshTokens)).toHaveLength(SURVIVORS_PER_TABLE)
    // The falsification: the other two jobs did NOT run, so their dead rows are
    // still there. Without this, a selector that silently ran everything passes.
    expect(await db.select().from(pendingRegistrations)).toHaveLength(SEEDED_PER_TABLE)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(SEEDED_PER_TABLE)
  })

  it('with a module selector, runs every job of that module', async () => {
    await seedDeadAndRecentRows()

    const outcomes = await runCron(env, SILENT_LOGGER, AUTH_MODULE)

    expect(outcomes).toHaveLength(EXPECTED_JOBS)
    expect(cronExitCode(outcomes)).toBe(CRON_EXIT_OK)
  })

  it('refuses an unknown selector instead of reporting a healthy empty run', async () => {
    await expect(runCron(env, SILENT_LOGGER, UNKNOWN_SELECTOR)).rejects.toBeInstanceOf(
      CronInvocationError,
    )
  })

  it('dispatches a pending outbox row for real and marks it dispatched', async () => {
    await db.insert(outboxMessages).values({
      id: randomUUID(),
      to: EMAIL,
      subject: 'Your password was changed',
      text: 'Your password was just changed.',
      attempts: 0,
      createdAt: new Date(),
    })

    const outcomes = await runCron(
      env,
      SILENT_LOGGER,
      `${AUTH_MODULE}${JOB_NAME_SEPARATOR}${DISPATCH_OUTBOX_MESSAGES_JOB}`,
    )

    expect(outcomes).toHaveLength(ONE_JOB)
    expect(outcomes[0]?.metrics).toEqual({ dispatched: 1, failed: NONE })
    const [row] = await db.select().from(outboxMessages)
    expect(row?.dispatchedAt).not.toBeNull()
  })
})
