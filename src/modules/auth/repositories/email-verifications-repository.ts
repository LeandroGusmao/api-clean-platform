import type { EmailVerification } from '#modules/auth/entities/email-verification'

export interface IEmailVerificationsRepository {
  save(verification: EmailVerification): Promise<void>

  /**
   * The most recent row for this user that has not been consumed.
   *
   * Deliberately does NOT filter expiry in SQL: whether a code is too old is
   * the entity's judgement, made against the injected `IClock`, and moving it
   * into the query would put a second clock — the database's — into a decision
   * the unit tests need to control.
   *
   * ALWAYS by user, never by digest. Six-digit codes collide by design, so a
   * global lookup would let one account's code confirm another's.
   */
  findActiveByUserId(userId: string): Promise<EmailVerification | null>

  /** Marks every unconsumed row of this user consumed, so only one code is ever live. */
  invalidateActiveForUser(userId: string, at: Date): Promise<void>

  /**
   * Records one wrong guess, but only if the cap has not already been spent:
   * `UPDATE ... SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS
   * NULL AND attempts < ?`.
   *
   * Returns whether THIS call is the one that got to increment. That boolean is
   * what keeps the cap race-proof under concurrency — the same reasoning as
   * `consume`: a read-then-write (read `attempts`, compare, then write) would
   * let N parallel guesses all read the same value and all pass, letting one
   * live code absorb N guesses instead of `maxAttempts`. The conditional
   * `UPDATE` closes that window by making the read and the write one atomic
   * statement, serialized by Postgres's own row lock.
   *
   * Called OUTSIDE any transaction, and that is the third line of §8 of the unit
   * of work design: inside a transaction that rolls back, the brute-force
   * counter would be erased exactly when it matters.
   */
  registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean>

  /**
   * Burns the code: `WHERE id = ? AND consumed_at IS NULL`.
   *
   * Returns whether THIS call is the one that burned it. That boolean is what
   * makes single use race-proof without an explicit lock — of two simultaneous
   * confirms with the same code, one loses the conditional update, and the
   * caller turns that into the same generic failure as every other.
   */
  consume(id: string, at: Date): Promise<boolean>
}
