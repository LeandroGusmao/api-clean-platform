import type { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { Email } from '#modules/auth/value-objects/email'

export interface IPendingRegistrationsRepository {
  /**
   * Plain insert. Coexisting rows for one email are legal by design, so there is
   * no violation to translate.
   */
  save(pending: PendingRegistration): Promise<void>

  /**
   * Every unconsumed row for this email, most recent first (`code_issued_at
   * DESC`). Deliberately does NOT filter expiry or the attempt cap in SQL:
   * whether a code is still usable is the entity's judgement against the
   * injected `IClock`, and the use case filters with `isUsable`.
   *
   * ALWAYS by `lower(email)`. A lookup by `code_hash` would let one address's
   * code redeem another's, since six digits collide by design.
   */
  findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]>

  /**
   * Mints a fresh code onto an existing pending row: `UPDATE ... SET code_hash =
   * ?, attempts = 0, code_issued_at = ?, expires_at = ? WHERE id = ? AND
   * consumed_at IS NULL`. `created_at` is untouched. `expiresAt` is passed
   * ready-made — it is `IClock` + ttl arithmetic, which the use case does.
   */
  reissueCode(
    id: string,
    codeHash: string,
    codeIssuedAt: Date,
    expiresAt: Date,
  ): Promise<void>

  /**
   * Records one wrong guess, but only if the cap has not been spent: `UPDATE ...
   * SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND
   * attempts < ?`. Returns whether THIS call is the one that incremented — the
   * conditional `UPDATE`, serialized by Postgres's row lock, is what keeps the
   * cap race-proof under concurrency: a read-then-write would let N parallel
   * guesses all read the same value and all pass.
   *
   * Called OUTSIDE any transaction (§8 line 3): inside one that rolls back, the
   * brute-force counter would be erased exactly when it matters.
   */
  registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean>

  /**
   * Burns the code: `UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at
   * IS NULL`. Returns whether THIS call is the one that burned it — of two
   * concurrent confirms redeeming the same code, one loses the conditional
   * update and the caller turns that into the same generic failure as every
   * other.
   */
  consume(id: string, at: Date): Promise<boolean>

  /**
   * Opportunistic prune: `DELETE ... WHERE lower(email) = ? AND (expires_at <= ?
   * OR consumed_at IS NOT NULL)`. Never touches a live, unconsumed row — the one
   * a concurrent confirm may be about to consume does not match the `WHERE`.
   */
  deleteExpiredByEmail(email: Email, now: Date): Promise<void>
}
