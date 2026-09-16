import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import {
  PRUNE_OUTBOX_MESSAGES_JOB,
  PruneOutboxMessagesUseCase,
} from '#modules/auth/use-cases/prune-outbox-messages'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const ONE = 1
const NONE = 0

let repository: InMemoryOutboxMessagesRepository
let useCase: PruneOutboxMessagesUseCase

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
  useCase = new PruneOutboxMessagesUseCase(repository, { now: () => NOW }, RETENTION_MS)
})

describe('PruneOutboxMessagesUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_OUTBOX_MESSAGES_JOB).toBe('prune-outbox-messages')
  })

  it('deletes a dispatched row past the retention window and reports the count', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    await repository.save(
      OutboxMessage.create({
        id: 'old',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: new Date(cutoff - ONE_MINUTE_MS),
      }),
    )
    await repository.markDispatched('old', new Date(cutoff - ONE_MINUTE_MS))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: ONE })
  })

  it('never deletes a still-pending row, however old', async () => {
    await repository.save(
      OutboxMessage.create({
        id: 'ancient-but-pending',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: new Date(NOW.getTime() - RETENTION_MS * 2),
      }),
    )

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: NONE })
    expect(await repository.findPendingBatch(ONE)).toHaveLength(ONE)
  })

  it('deletes a row whose settlement is exactly on the retention cutoff', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    await repository.save(
      OutboxMessage.create({
        id: 'on-cutoff',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: new Date(cutoff),
      }),
    )
    await repository.markDispatched('on-cutoff', new Date(cutoff))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: ONE })
  })

  it('keeps a dispatched row still inside the retention window', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    const insideWindow = new Date(cutoff + ONE_MINUTE_MS)
    await repository.save(
      OutboxMessage.create({
        id: 'inside-window',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: insideWindow,
      }),
    )
    await repository.markDispatched('inside-window', insideWindow)

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: NONE })
  })
})
