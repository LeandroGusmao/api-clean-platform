import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'

/**
 * In-memory adapter, for the unit tests of the use cases. Exposes
 * `events` because the port has no read: the tests inspect what was recorded.
 */
export class InMemoryAuditEventsRepository implements IAuditEventsRepository {
  readonly events: AuditEvent[] = []

  async save(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }

  async deleteOccurredBefore(cutoff: Date): Promise<number> {
    const survivors = this.events.filter((event) => event.occurredAt > cutoff)
    const deleted = this.events.length - survivors.length
    this.events.length = 0
    this.events.push(...survivors)
    return deleted
  }
}
