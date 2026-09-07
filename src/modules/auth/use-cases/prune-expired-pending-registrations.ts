import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB =
  'prune-expired-pending-registrations'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Full sweep of abandoned pending registrations. The opportunistic prune in
 * `deleteExpiredByEmail` only reaches addresses with new traffic; this covers
 * the rest. Predicate and window: design §3.4.
 */
export class PruneExpiredPendingRegistrationsUseCase {
  constructor(
    private readonly pendingRegistrations: IPendingRegistrationsRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.pendingRegistrations.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
