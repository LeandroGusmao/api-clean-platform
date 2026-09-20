import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { auditEvents } from './schema/audit-events.js'

/** Entity to row; there is no way back, because nothing reads a row. */
export function toPersistenceAuditEvent(
  event: AuditEvent,
): typeof auditEvents.$inferInsert {
  return {
    id: event.id,
    type: event.type,
    userId: event.userId,
    ip: event.ip,
    deviceLabel: event.deviceLabel,
    occurredAt: event.occurredAt,
  }
}
