export interface ClaimAccountExistsNoticeParams {
  userId: string
  sentAt: Date
  /** The previous notice must have been sent at or before this for a claim to win. */
  cooldownCutoff: Date
}

export interface IAccountExistsNoticesRepository {
  /**
   * One statement: record that the account is being sent the notice now, unless
   * it was already sent one after `cooldownCutoff`. `INSERT ... ON CONFLICT
   * (user_id) DO UPDATE SET sent_at = ? WHERE account_exists_notices.sent_at <=
   * ?`.
   *
   * Returns whether THIS call claimed the notice: `false` means the caller is
   * inside the cooldown and sends nothing. The cooldown lives in the `DO UPDATE`
   * `WHERE` and not in a prior read, so concurrent registers — on one replica or
   * several — cannot all see a free slot: Postgres serializes the upsert on the
   * primary key and exactly one of them wins.
   */
  claim(params: ClaimAccountExistsNoticeParams): Promise<boolean>
}
