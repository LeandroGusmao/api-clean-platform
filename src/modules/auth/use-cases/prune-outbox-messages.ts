import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_OUTBOX_MESSAGES_JOB = 'prune-outbox-messages'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Deletes outbox rows that were dispatched or given up on longer than the
 * retention window ago. Mirrors `PruneExpiredRefreshTokensUseCase` — same
 * cutoff arithmetic, same never-touch-a-live-row guarantee.
 */
export class PruneOutboxMessagesUseCase {
  constructor(
    private readonly outboxMessages: IOutboxMessagesRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.outboxMessages.deleteDispatchedOrFailedBefore(cutoff)
    return { rowsDeleted }
  }
}
