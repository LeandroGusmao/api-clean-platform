import type { AuditEvent } from '#modules/auth/entities/audit-event'

export interface IAuditEventsRepository {
  /** Plain insert, called INSIDE the `uow` of the use case that made the change. */
  save(event: AuditEvent): Promise<void>

  /**
   * Deletes every event that occurred at or before `cutoff` and returns how many.
   * Mirrors `deleteExpiredBefore` on the sibling repositories.
   */
  deleteOccurredBefore(cutoff: Date): Promise<number>
}
