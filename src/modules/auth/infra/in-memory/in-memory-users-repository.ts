import type { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * Mirrors `DrizzleUsersRepository` on email uniqueness only, and only for the
 * ASCII inputs the tests use: `Email.create`'s `toLowerCase()` is
 * locale-independent Unicode folding, while Postgres `lower()` is
 * collation-dependent, so the two can disagree on exotic codepoints. It also
 * models no primary key at all — two saves with the same id coexist here,
 * where the real `users_pkey` would turn the second one into a 500. The
 * database's unique index is the authority in production; this class is a
 * test convenience, not a specification of uniqueness.
 */
export class InMemoryUsersRepository implements IUsersRepository {
  readonly users: User[] = []

  async save(user: User): Promise<void> {
    const taken = this.users.some((existing) => existing.email.equals(user.email))
    if (taken) throw new EmailAlreadyInUseError()

    this.users.push(user)
  }
}
