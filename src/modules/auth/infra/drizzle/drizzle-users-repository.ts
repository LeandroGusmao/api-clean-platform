import type { Database } from '#infra/database/client'
import { findDriverError, toPersistenceError } from '#infra/database/driver-error'
import type { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { USERS_EMAIL_LOWER_UNIQUE_INDEX, users } from './schema/users.js'
import { toPersistenceUser } from './user-mapper.js'

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Matches the constraint NAME, not just the code. The table already carries a
 * second unique constraint — its primary key — so an id collision raises 23505
 * as well, and matching the code alone would report it to the client as "email
 * already in use": a 409 over what is really a 500.
 *
 * `findDriverError` reaches the driver error underneath Drizzle's wrapper,
 * where `code` and `constraint` actually live.
 */
function isEmailAlreadyInUse(error: unknown): boolean {
  const driverError = findDriverError(error)

  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === USERS_EMAIL_LOWER_UNIQUE_INDEX
  )
}

export class DrizzleUsersRepository implements IUsersRepository {
  constructor(private readonly db: Database) {}

  async save(user: User): Promise<void> {
    try {
      // Insert and handle the violation, never check-then-insert: a prior
      // lookup races, and two simultaneous requests would both pass it.
      await this.db.insert(users).values(toPersistenceUser(user))
    } catch (error) {
      if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()

      // Never re-throw what the driver gave us. Drizzle's error glues every
      // bound parameter into its own message — and an insert into `users` binds
      // the password hash. `toPersistenceError` keeps the diagnosis and drops
      // the payload, so nothing downstream can wrap the dangerous object and
      // leak it through a concatenated message.
      throw toPersistenceError(error)
    }
  }
}
