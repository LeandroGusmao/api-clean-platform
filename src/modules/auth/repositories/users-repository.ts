import type { User } from '#modules/auth/entities/user'

export interface IUsersRepository {
  /**
   * Persists a new user.
   *
   * Throws `EmailAlreadyInUseError` when the email is taken. The authority is
   * the database's unique index, not a prior query: checking and then inserting
   * races, and two simultaneous requests would both pass the check.
   *
   * Only `save` for now. `findByEmail` arrives with login, which is the first
   * thing that reads a user.
   */
  save(user: User): Promise<void>
}
