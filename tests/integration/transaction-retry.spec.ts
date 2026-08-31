import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import {
  createTransactionRunner,
  type TransactionRunner,
} from '#infra/database/transaction-runner'
import type { WarnLogger } from '#infra/observability/logger'
import { User } from '#modules/auth/entities/user'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const FIRST_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const SECOND_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const FIRST_EMAIL = 'joao@example.com'
const SECOND_EMAIL = 'maria@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-30T12:00:00.000Z')

const FIRST_RESULT = 'first'
const SECOND_RESULT = 'second'

/** Spelled out: this is the contract the retry policy is asserted against. */
const DEADLOCK_DETECTED = '40P01'

/**
 * One transaction is killed and retries, the other never does — so the two
 * callbacks run three times between them. Which one loses is Postgres's choice
 * and deliberately not asserted.
 */
const TOTAL_ATTEMPTS_WITH_ONE_RETRY = 3

let db: Database
let pool: Pool
let runner: TransactionRunner
let warnings: Array<Record<string, unknown>>

const logger: WarnLogger = {
  warn: (details) => {
    warnings.push(details)
  },
}

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  runner = createTransactionRunner(db, logger)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  warnings = []
  await db.delete(users)

  const { users: repository } = authRepositories(db)
  await repository.save(makeUser(FIRST_ID, FIRST_EMAIL))
  await repository.save(makeUser(SECOND_ID, SECOND_EMAIL))
})

function makeUser(id: string, email: string) {
  return User.create({
    id,
    email: Email.create(email),
    passwordHash: PASSWORD_HASH,
    now: NOW,
  })
}

/** Takes a row lock that another transaction cannot take until this one ends. */
async function lockUser(tx: Database, id: string): Promise<void> {
  await tx.execute(sql`select id from ${users} where id = ${id} for update`)
}

function makeGate(): { pass: () => void; passed: Promise<void> } {
  let pass: () => void = () => undefined
  const passed = new Promise<void>((resolve) => {
    pass = resolve
  })

  return { pass, passed }
}

describe('transaction retry (integration — real Postgres)', () => {
  /**
   * A genuine deadlock, not a simulated one: two transactions take the two row
   * locks in opposite orders, each after the other has taken its first. Postgres
   * detects the cycle, kills one with 40P01, and the runner retries the victim —
   * which now finds both rows free.
   *
   * The `lock_timeout` from the connection-limits slice is 5s and Postgres's
   * `deadlock_timeout` is 1s, so the detector fires first and this is a deadlock
   * rather than a lock timeout. If that margin ever changes, this test fails
   * with 55P03 instead of passing, which is the right way to find out.
   */
  it('retries the transaction Postgres kills to break a deadlock', async () => {
    const first = makeGate()
    const second = makeGate()
    let attempts = 0

    const runFirst = runner(async (tx) => {
      attempts += 1
      await lockUser(tx, FIRST_ID)
      first.pass()
      await second.passed
      await lockUser(tx, SECOND_ID)

      return FIRST_RESULT
    })

    const runSecond = runner(async (tx) => {
      attempts += 1
      await lockUser(tx, SECOND_ID)
      second.pass()
      await first.passed
      await lockUser(tx, FIRST_ID)

      return SECOND_RESULT
    })

    await expect(Promise.all([runFirst, runSecond])).resolves.toEqual([
      FIRST_RESULT,
      SECOND_RESULT,
    ])
    expect(attempts).toBe(TOTAL_ATTEMPTS_WITH_ONE_RETRY)
  })

  it('records the deadlock it recovered from', async () => {
    const first = makeGate()
    const second = makeGate()

    await Promise.all([
      runner(async (tx) => {
        await lockUser(tx, FIRST_ID)
        first.pass()
        await second.passed
        await lockUser(tx, SECOND_ID)
      }),
      runner(async (tx) => {
        await lockUser(tx, SECOND_ID)
        second.pass()
        await first.passed
        await lockUser(tx, FIRST_ID)
      }),
    ])

    // Without this the recovery is invisible: a retried deadlock reaches no
    // error metric at all, so a rising rate of contention would show up only
    // once it started exhausting the retries.
    expect(warnings).toEqual([{ sqlstate: DEADLOCK_DETECTED, attempt: 1 }])
  })
})
