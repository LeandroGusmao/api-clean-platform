import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { Email } from '#modules/auth/value-objects/email'

/** `splice` takes a count, and exactly one row carries a given id. */
const SINGLE_ROW = 1

/**
 * In-memory adapter, for the unit tests of the use cases.
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

  async findByEmail(email: Email): Promise<User | null> {
    return this.users.find((existing) => existing.email.equals(email)) ?? null
  }

  async findById(id: string): Promise<User | null> {
    return this.users.find((existing) => existing.id === id) ?? null
  }

  async updatePasswordHash(
    id: string,
    passwordHash: string,
    updatedAt: Date,
  ): Promise<void> {
    const current = this.users.find((existing) => existing.id === id)
    if (current === undefined) return

    // The entity is frozen with `#` readonly fields, so there is nothing to
    // mutate: a new one is rehydrated from the old one's getters with the two
    // columns replaced. Same shape as `InMemoryRefreshTokensRepository.#replace`.
    this.users[this.users.indexOf(current)] = User.fromTrusted({
      id: current.id,
      email: current.email,
      passwordHash,
      emailVerifiedAt: current.emailVerifiedAt,
      createdAt: current.createdAt,
      updatedAt,
    })
  }

  /**
   * Models NO cascade: the real one is the database's, and it is proved in
   * `tests/integration/drizzle-users-repository.spec.ts`. A use case spec that
   * needs a child table emptied asserts on that table's own double.
   */
  async deleteById(id: string): Promise<void> {
    const index = this.users.findIndex((existing) => existing.id === id)
    if (index < 0) return

    this.users.splice(index, SINGLE_ROW)
  }
}
