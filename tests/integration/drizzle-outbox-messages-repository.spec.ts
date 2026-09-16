import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { DrizzleOutboxMessagesRepository } from '#modules/auth/infra/drizzle/drizzle-outbox-messages-repository'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const HIGH_MAX_ATTEMPTS = 1000
const CONCURRENT_FAILURES = 5
const ONE_ROW = 1
const TWO_ROWS = 2
const NONE = 0

let db: Database
let pool: Pool
let repository: DrizzleOutboxMessagesRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = new DrizzleOutboxMessagesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(outboxMessages)
})

const messageAt = (label: string, createdAt: Date) => {
  const id = randomUUID()
  return {
    id,
    msg: OutboxMessage.create({
      id,
      message: { to: `${label}@example.com`, subject: 'subject', text: 'text' },
      now: createdAt,
    }),
  }
}

describe('DrizzleOutboxMessagesRepository', () => {
  it('finds pending rows oldest first, ignoring dispatched and failed ones', async () => {
    const newest = messageAt('newest', LATER)
    const oldest = messageAt('oldest', NOW)
    const dispatched = messageAt('dispatched', NOW)

    await repository.save(newest.msg)
    await repository.save(oldest.msg)
    await repository.save(dispatched.msg)
    await repository.markDispatched(dispatched.id, LATER)

    const batch = await repository.findPendingBatch(TWO_ROWS)

    expect(batch.map((message) => message.id)).toEqual([oldest.id, newest.id])
  })

  it('sets failedAt only once attempts reaches the cap', async () => {
    const doomed = messageAt('doomed', NOW)
    await repository.save(doomed.msg)

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    let [pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(1)
    expect(pending?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    ;[pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(2)
    expect(pending?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    expect(await repository.findPendingBatch(ONE_ROW)).toHaveLength(NONE)
  })

  it('increments attempts atomically under concurrent failures, losing none', async () => {
    const racy = messageAt('racy', NOW)
    await repository.save(racy.msg)

    await Promise.all(
      Array.from({ length: CONCURRENT_FAILURES }, () =>
        repository.recordFailure(racy.id, LATER, 'boom', HIGH_MAX_ATTEMPTS),
      ),
    )

    const [row] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, racy.id))
    expect(row?.attempts).toBe(CONCURRENT_FAILURES)
  })

  it('prunes only dispatched/failed rows at or before the cutoff, never a pending one', async () => {
    const oldDispatched = messageAt('old-dispatched', NOW)
    const oldPending = messageAt('old-pending', NOW)

    await repository.save(oldDispatched.msg)
    await repository.markDispatched(oldDispatched.id, NOW)
    await repository.save(oldPending.msg)

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    const survivors = await repository.findPendingBatch(TWO_ROWS)
    expect(survivors.map((message) => message.id)).toEqual([oldPending.id])
  })
})
