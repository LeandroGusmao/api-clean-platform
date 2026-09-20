import { lte } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'
import { toPersistenceAuditEvent } from './audit-event-mapper.js'
import { auditEvents } from './schema/audit-events.js'

/** How many rows affected when none matched. */
const NO_ROW_AFFECTED = 0

export class DrizzleAuditEventsRepository implements IAuditEventsRepository {
  constructor(private readonly db: Database) {}

  async save(event: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditEvents).values(toPersistenceAuditEvent(event))
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async deleteOccurredBefore(cutoff: Date): Promise<number> {
    try {
      const result = await this.db
        .delete(auditEvents)
        .where(lte(auditEvents.occurredAt, cutoff))

      return result.rowCount ?? NO_ROW_AFFECTED
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}
