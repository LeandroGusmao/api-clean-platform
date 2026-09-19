import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LEASE_UNTIL = new Date('2026-09-15T12:02:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const ONE_ROW = 1
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
  it('claims pending rows oldest first, one at a time', async () => {
    await repository.save(messageAt('newest', LATER))
    await repository.save(messageAt('oldest', NOW))

    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe('oldest')
    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe('newest')
    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a dispatched row', async () => {
    await repository.save(messageAt('done', NOW))
    await repository.markDispatched('done', LATER)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a permanently failed row', async () => {
    await repository.save(messageAt('doomed', NOW))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    }

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a claimed row until its claim expires', async () => {
    await repository.save(messageAt('only', NOW))
    await repository.claimNext(NOW, LEASE_UNTIL)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
    // The claim runs out AT its expiry: `claimed_until <= now` no longer counts.
    expect((await repository.claimNext(LEASE_UNTIL, LATER))?.id).toBe('only')
  })

  it('records a failure below the cap without marking it failed', async () => {
    await repository.save(messageAt('retry-me', NOW))

    await repository.recordFailure('retry-me', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)

    const [stored] = repository.messages
    expect(stored?.attempts).toBe(ONE_ROW)
    expect(stored?.lastError).toBe(ERROR_MESSAGE)
    expect(stored?.failedAt).toBeNull()
  })

  it('keeps the claim when a failure is recorded', async () => {
    await repository.save(messageAt('retry-me', NOW))
    await repository.claimNext(NOW, LEASE_UNTIL)

    await repository.recordFailure('retry-me', NOW, ERROR_MESSAGE, MAX_ATTEMPTS)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
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
