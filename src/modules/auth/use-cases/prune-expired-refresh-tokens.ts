import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_EXPIRED_REFRESH_TOKENS_JOB = 'prune-expired-refresh-tokens'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Deletes refresh tokens dead longer than the retention window — `expires_at <=
 * clock.now() - retention`. The window keeps a dead row available for a
 * post-mortem; the predicate and the trade-off are design §3.4.
 */
export class PruneExpiredRefreshTokensUseCase {
  constructor(
    private readonly refreshTokens: IRefreshTokensRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.refreshTokens.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
