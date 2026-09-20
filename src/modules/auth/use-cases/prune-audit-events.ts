import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_AUDIT_EVENTS_JOB = 'prune-audit-events'

export interface PruneAuditEventsResult {
  rowsDeleted: number
}

/**
 * Deletes audit events that occurred at or before the retention window ago.
 * Same cutoff arithmetic as `PruneOutboxMessagesUseCase`; unlike it there is no
 * "still pending" state to protect, so age is the only criterion.
 */
export class PruneAuditEventsUseCase {
  constructor(
    private readonly auditEvents: IAuditEventsRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneAuditEventsResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.auditEvents.deleteOccurredBefore(cutoff)
    return { rowsDeleted }
  }
}
