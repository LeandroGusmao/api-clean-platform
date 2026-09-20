import { describe, expect, it } from 'vitest'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { InMemoryAuditEventsRepository } from '#modules/auth/infra/in-memory/in-memory-audit-events-repository'
import { PruneAuditEventsUseCase } from '#modules/auth/use-cases/prune-audit-events'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const NOW = new Date('2026-09-20T12:00:00.000Z')
const RETENTION_MS = 1000 * 60 * 60
const ONE_SECOND_MS = 1000
const ONE_ROW = 1
const TWO_ROWS = 2
const NO_ROWS = 0

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.AccountDeleted,
    userId: USER_ID,
    device: { ip: null, label: null },
    now: occurredAt,
  })

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

describe('PruneAuditEventsUseCase', () => {
  it('deletes what is at or past the retention window and keeps the rest', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('past', at(-RETENTION_MS - ONE_SECOND_MS)))
    await repository.save(eventAt('edge', at(-RETENTION_MS)))
    await repository.save(eventAt('inside', at(-RETENTION_MS + ONE_SECOND_MS)))

    const result = await new PruneAuditEventsUseCase(
      repository,
      { now: () => NOW },
      RETENTION_MS,
    ).execute()

    expect(result).toEqual({ rowsDeleted: TWO_ROWS })
    expect(repository.events.map((event) => event.id)).toEqual(['inside'])
  })

  it('reports zero when nothing is old enough', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('recent', NOW))

    const result = await new PruneAuditEventsUseCase(
      repository,
      { now: () => NOW },
      RETENTION_MS,
    ).execute()

    expect(result).toEqual({ rowsDeleted: NO_ROWS })
    expect(repository.events).toHaveLength(ONE_ROW)
  })
})
