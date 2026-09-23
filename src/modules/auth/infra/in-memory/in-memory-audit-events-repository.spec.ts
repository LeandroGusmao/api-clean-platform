import { describe, expect, it } from 'vitest'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { InMemoryAuditEventsRepository } from '#modules/auth/infra/in-memory/in-memory-audit-events-repository'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const DEVICE_LABEL = 'Chrome on Windows'
const CUTOFF = new Date('2026-09-20T12:00:00.000Z')
const ONE_SECOND_MS = 1000
const NO_EVENTS = 0
const TWO_EVENTS = 2
const ONE_EVENT = 1

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.PasswordChanged,
    userId: USER_ID,
    device: { ip: null, label: DEVICE_LABEL },
    now: occurredAt,
  })

const offset = (ms: number) => new Date(CUTOFF.getTime() + ms)

describe('InMemoryAuditEventsRepository', () => {
  it('stores what it is given', async () => {
    const repository = new InMemoryAuditEventsRepository()

    await repository.save(eventAt('a', CUTOFF))

    expect(repository.events).toHaveLength(ONE_EVENT)
  })

  it('deletes what happened at or before the cutoff and returns how many', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('before', offset(-ONE_SECOND_MS)))
    await repository.save(eventAt('at', CUTOFF))
    await repository.save(eventAt('after', offset(ONE_SECOND_MS)))

    const deleted = await repository.deleteOccurredBefore(CUTOFF)

    expect(deleted).toBe(TWO_EVENTS)
    expect(repository.events.map((event) => event.id)).toEqual(['after'])
  })

  it('returns zero when nothing is old enough', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('after', offset(ONE_SECOND_MS)))

    expect(await repository.deleteOccurredBefore(CUTOFF)).toBe(NO_EVENTS)
    expect(repository.events).toHaveLength(ONE_EVENT)
  })
})
