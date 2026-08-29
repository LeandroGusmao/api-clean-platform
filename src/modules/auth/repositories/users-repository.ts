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
}
