import type { User } from '#modules/auth/entities/user'
import type { Email } from '#modules/auth/value-objects/email'

export interface IUsersRepository {
  /**
   * Persists a new user.
   *
   * Throws `EmailAlreadyInUseError` when the email is taken. The authority is
   * the database's unique index, not a prior query: checking and then inserting
   * races, and two simultaneous requests would both pass the check.
   */
  save(user: User): Promise<void>

  /**
   * Matches case-insensitively, through the `lower(email)` unique index.
   * Returns null rather than throwing: whether a missing user is an error is
   * the caller's decision, and login deliberately treats it as a credential
   * failure rather than a lookup failure.
   */
  findByEmail(email: Email): Promise<User | null>

  findById(id: string): Promise<User | null>

  /**
   * Writes ONLY `password_hash` and `updated_at`.
   *
   * A command with primitives rather than an entity, which is this module's
   * declared shape for updates — every write on `IRefreshTokensRepository` that
   * is not an insert looks the same. It also makes the wrong column
   * inexpressible: this signature has no access to `email`, so writing it is a
   * compile error rather than a review comment.
   *
   * `updatedAt` is passed EXPLICITLY, always. The column carries `$onUpdate`,
   * which fills an absence with the system clock — measured against
   * drizzle-orm 1.0.0-rc.4, it never overwrites a value that is present — so
   * omitting it here is the one way the injected `IClock` stops being the
   * source of truth, and it would fail in silence.
   *
   * Silent about a missing id: the caller has already loaded the user, and
   * turning a deleted row into an error here would duplicate a decision that
   * belongs to the use case.
   */
  updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>

  /**
   * Writes ONLY `email_verified_at` and `updated_at`.
   *
   * Narrow for the same two reasons as `updatePasswordHash`: the wrong column is
   * inexpressible, because this signature cannot reach `email`; and `updatedAt`
   * goes EXPLICITLY, always, because `$onUpdate` fills an absence with the
   * system clock — omitting it is the one way the injected `IClock` stops being
   * the source of truth, and it fails in silence.
   *
   * Two parameters even though the single call site passes the same instant to
   * both: collapsing them would make the repository DECIDE that
   * `email_verified_at` always equals `updated_at`, which is true of this caller
   * and is not a property of the table.
   *
   * Silent about a missing id, like `updatePasswordHash`: the caller has already
   * loaded the user.
   */
  markEmailVerified(id: string, verifiedAt: Date, updatedAt: Date): Promise<void>
}
