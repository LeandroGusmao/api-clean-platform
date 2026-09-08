import type { PasswordResetToken } from '#modules/auth/entities/password-reset-token'

export interface IssueOrRefreshParams {
  /** Used only on the INSERT path — the first `forgot` for this account. */
  id: string
  userId: string
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  /** `issued_at` must be at or before this for a refresh to fire. */
  cooldownCutoff: Date
}

export interface IPasswordResetTokensRepository {
  /**
   * One statement: insert the account's first reset token, or refresh the
   * existing row in place — but only when its `issued_at` is at or before
   * `cooldownCutoff`. `INSERT ... ON CONFLICT (user_id) DO UPDATE SET
   * token_hash = ?, issued_at = ?, expires_at = ?, consumed_at = NULL WHERE
   * password_reset_tokens.issued_at <= ?`.
   *
   * Returns whether a row was written: `false` means the caller is inside the
   * cooldown and sends nothing. The cooldown is in the `DO UPDATE` `WHERE`, not
   * a prior read, so two concurrent `forgot` for one account cannot both mint —
   * Postgres serializes the upsert on the `user_id` unique index.
   */
  issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean>

  /**
   * The `reset` lookup, by the `token_hash` unique index. Returns `null` for a
   * digest that matches no row. Does NOT filter expiry or `consumed_at`:
   * usability is the entity's judgement against the injected clock.
   */
  findByHash(tokenHash: string): Promise<PasswordResetToken | null>

  /**
   * Burns the token: `UPDATE ... SET consumed_at = ? WHERE id = ? AND
   * consumed_at IS NULL`. Returns whether THIS call is the one that burned it —
   * of two concurrent resets redeeming the same token, one loses the
   * conditional update and the caller turns that into the same generic failure.
   */
  consume(id: string, at: Date): Promise<boolean>

  /**
   * Full sweep for the cron. Deletes every row whose `expires_at` is at or
   * before `cutoff`; the use case passes `clock.now() - retention`, so a dead
   * row lingers one retention window and stays available for a post-mortem
   * (design §3.4). Returns the deleted-row count for the run log. An
   * unconditional `DELETE`: no transaction, no lock, no ordering.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
}
