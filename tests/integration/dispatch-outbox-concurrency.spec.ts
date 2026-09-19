import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { DrizzleOutboxMessagesRepository } from '#modules/auth/infra/drizzle/drizzle-outbox-messages-repository'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { DispatchOutboxMessagesUseCase } from '#modules/auth/use-cases/dispatch-outbox-messages'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const MESSAGES = 30
const CONCURRENT_RUNS = 5
const SEND_DELAY_MS = 5
const MAX_ATTEMPTS = 3
const BATCH_SIZE = 100
const LEASE_MS = 60_000
const NONE = 0
const ONE = 1

const RUN_STARTED_AT = new Date('2026-09-19T12:00:00.000Z')
const ABANDONED_RECIPIENT = 'abandoned@example.com'

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const saveMessage = (to: string, createdAt: Date) =>
  repository.save(
    OutboxMessage.create({
      id: randomUUID(),
      message: { to, subject: 'subject', text: 'text' },
      now: createdAt,
    }),
  )

const dispatcherAt = (emailSender: IEmailSender, now: () => Date) =>
  new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    { now },
    MAX_ATTEMPTS,
    BATCH_SIZE,
    LEASE_MS,
  )

describe('overlapping outbox dispatch runs', () => {
  // The problem the claim exists to close: with a plain SELECT every run below
  // reads the same rows, and each message goes out once per run.
  it('send each message exactly once', async () => {
    for (let index = 0; index < MESSAGES; index++) {
      await saveMessage(
        `user-${index}@example.com`,
        new Date(RUN_STARTED_AT.getTime() + index),
      )
    }
    const sends: string[] = []
    const emailSender: IEmailSender = {
      send: async (message: EmailMessage) => {
        await sleep(SEND_DELAY_MS)
        sends.push(message.to)
      },
    }

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_RUNS }, () =>
        dispatcherAt(emailSender, () => new Date()).execute(),
      ),
    )

    expect(sends).toHaveLength(MESSAGES)
    expect(new Set(sends).size).toBe(MESSAGES)
    expect(results.reduce((total, result) => total + result.dispatched, NONE)).toBe(
      MESSAGES,
    )
    const rows = await db.select().from(outboxMessages)
    expect(rows.every((row) => row.dispatchedAt !== null)).toBe(true)
  })

  // A run that dies mid-send leaves a claim behind. Nothing releases it: it
  // expires, and the next run takes the message.
  it('offers a message again once the claim of a run that died has expired', async () => {
    await saveMessage(ABANDONED_RECIPIENT, RUN_STARTED_AT)
    await repository.claimNext(
      RUN_STARTED_AT,
      new Date(RUN_STARTED_AT.getTime() + LEASE_MS),
    )
    const sends: string[] = []
    const emailSender: IEmailSender = {
      send: async (message: EmailMessage) => {
        sends.push(message.to)
      },
    }

    const insideTheLease = await dispatcherAt(
      emailSender,
      () => new Date(RUN_STARTED_AT.getTime() + LEASE_MS - ONE),
    ).execute()
    const atExpiry = await dispatcherAt(
      emailSender,
      () => new Date(RUN_STARTED_AT.getTime() + LEASE_MS),
    ).execute()

    expect(insideTheLease).toEqual({ dispatched: NONE, failed: NONE })
    expect(atExpiry).toEqual({ dispatched: ONE, failed: NONE })
    expect(sends).toEqual([ABANDONED_RECIPIENT])
  })
})
