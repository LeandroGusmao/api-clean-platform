import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB =
  'prune-expired-password-reset-tokens'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Full sweep of spent and abandoned reset tokens. `issueOrRefresh` only ever
 * supersedes the one live row per account; nothing else clears the table.
 * `expires_at <= clock.now() - retention`: the window keeps a dead row
 * available for a post-mortem.
 */
export class PruneExpiredPasswordResetTokensUseCase {
  constructor(
    private readonly passwordResetTokens: IPasswordResetTokensRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.passwordResetTokens.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
