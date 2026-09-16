import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const ONE_ROW = 1
const TWO_ROWS = 2
const NONE = 0
const ERROR_MESSAGE = 'connection refused'

const messageAt = (id: string, createdAt: Date) =>
  OutboxMessage.create({
    id,
    message: { to: `${id}@example.com`, subject: 'subject', text: 'text' },
    now: createdAt,
  })

let repository: InMemoryOutboxMessagesRepository

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
})

describe('InMemoryOutboxMessagesRepository', () => {
  it('finds only pending rows, oldest first, up to the limit', async () => {
    await repository.save(messageAt('newest', LATER))
    await repository.save(messageAt('oldest', NOW))

    const batch = await repository.findPendingBatch(ONE_ROW)

    expect(batch.map((message) => message.id)).toEqual(['oldest'])
  })

  it('excludes a dispatched row from the pending batch', async () => {
    await repository.save(messageAt('done', NOW))
    await repository.markDispatched('done', LATER)

    expect(await repository.findPendingBatch(TWO_ROWS)).toHaveLength(NONE)
  })

  it('excludes a permanently failed row from the pending batch', async () => {
    await repository.save(messageAt('doomed', NOW))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    }

    expect(await repository.findPendingBatch(TWO_ROWS)).toHaveLength(NONE)
  })

  it('records a failure below the cap without marking it failed', async () => {
    await repository.save(messageAt('retry-me', NOW))

    await repository.recordFailure('retry-me', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)

    const [pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(1)
    expect(pending?.lastError).toBe(ERROR_MESSAGE)
    expect(pending?.failedAt).toBeNull()
  })

  it('deletes only dispatched or failed rows before the cutoff', async () => {
    await repository.save(messageAt('old-dispatched', NOW))
    await repository.markDispatched('old-dispatched', NOW)
    await repository.save(messageAt('still-pending', NOW))

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    expect(repository.messages.map((message) => message.id)).toEqual(['still-pending'])
  })
})
