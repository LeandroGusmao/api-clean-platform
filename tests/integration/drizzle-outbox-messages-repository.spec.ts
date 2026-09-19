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
const LEASE_UNTIL = new Date('2026-09-15T12:02:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const HIGH_MAX_ATTEMPTS = 1000
const CONCURRENT_FAILURES = 5
const CONCURRENT_CLAIMERS = 6
const MESSAGES_TO_CLAIM = 40
const MILLISECONDS_PER_MESSAGE = 1000
const ONE_ROW = 1
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

const rowOf = async (id: string) => {
  const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id))
  return row
}

describe('DrizzleOutboxMessagesRepository', () => {
  it('claims the oldest pending row first, ignoring dispatched and failed ones', async () => {
    const newest = messageAt('newest', LATER)
    const oldest = messageAt('oldest', NOW)
    const dispatched = messageAt('dispatched', NOW)
    const failed = messageAt('failed', NOW)

    await repository.save(newest.msg)
    await repository.save(oldest.msg)
    await repository.save(dispatched.msg)
    await repository.save(failed.msg)
    await repository.markDispatched(dispatched.id, LATER)
    await repository.recordFailure(failed.id, LATER, 'boom', ONE_ROW)

    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe(oldest.id)
    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe(newest.id)
    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a claimed row until its claim expires', async () => {
    const only = messageAt('only', NOW)
    await repository.save(only.msg)
    await repository.claimNext(NOW, LEASE_UNTIL)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
    // The claim runs out AT its expiry: `claimed_until <= now` no longer counts.
    expect((await repository.claimNext(LEASE_UNTIL, LATER))?.id).toBe(only.id)
  })

  it('stores the claim and changes nothing else about the row', async () => {
    const only = messageAt('only', NOW)
    await repository.save(only.msg)

    await repository.claimNext(NOW, LEASE_UNTIL)

    const row = await rowOf(only.id)
    expect(row?.claimedUntil).toEqual(LEASE_UNTIL)
    expect(row?.attempts).toBe(NONE)
    expect(row?.dispatchedAt).toBeNull()
    expect(row?.failedAt).toBeNull()
  })

  // The whole point of the claim: however the runs interleave, a row goes to
  // exactly one of them.
  it('hands each row to exactly one of several concurrent claimers', async () => {
    for (let index = 0; index < MESSAGES_TO_CLAIM; index++) {
      await repository.save(
        messageAt(
          `row-${index}`,
          new Date(NOW.getTime() + index * MILLISECONDS_PER_MESSAGE),
        ).msg,
      )
    }
    const claimed: string[] = []

    await Promise.all(
      Array.from({ length: CONCURRENT_CLAIMERS }, async () => {
        for (;;) {
          const next = await repository.claimNext(NOW, LEASE_UNTIL)
          if (next === null) return
          claimed.push(next.id)
        }
      }),
    )

    expect(claimed).toHaveLength(MESSAGES_TO_CLAIM)
    expect(new Set(claimed).size).toBe(MESSAGES_TO_CLAIM)
  })

  it('sets failedAt only once attempts reaches the cap', async () => {
    const doomed = messageAt('doomed', NOW)
    await repository.save(doomed.msg)

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    let row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(1)
    expect(row?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(2)
    expect(row?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(MAX_ATTEMPTS)
    expect(row?.failedAt).toEqual(LATER)
  })

  it('increments attempts atomically under concurrent failures, losing none', async () => {
    const racy = messageAt('racy', NOW)
    await repository.save(racy.msg)

    await Promise.all(
      Array.from({ length: CONCURRENT_FAILURES }, () =>
        repository.recordFailure(racy.id, LATER, 'boom', HIGH_MAX_ATTEMPTS),
      ),
    )

    expect((await rowOf(racy.id))?.attempts).toBe(CONCURRENT_FAILURES)
  })

  it('prunes only dispatched/failed rows at or before the cutoff, never a pending one', async () => {
    const oldDispatched = messageAt('old-dispatched', NOW)
    const oldPending = messageAt('old-pending', NOW)

    await repository.save(oldDispatched.msg)
    await repository.markDispatched(oldDispatched.id, NOW)
    await repository.save(oldPending.msg)

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    const survivors = await db.select().from(outboxMessages)
    expect(survivors.map((row) => row.id)).toEqual([oldPending.id])
  })
})
