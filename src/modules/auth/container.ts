import type { Database } from '#infra/database/client'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import { DrizzleUsersRepository } from './infra/drizzle/drizzle-users-repository.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { RegisterUserUseCase } from './use-cases/register-user.js'

/**
 * The module's slice of the dependency graph. This file is `composition`: it is
 * the one place inside the module allowed to know concrete implementations —
 * that is the whole point of a composition root (decision 08).
 *
 * Stateless objects (repository, providers) are singletons here. Instantiating
 * a class costs nanoseconds against milliseconds of network and database, so
 * the cost is noise; the reason to avoid `new` in a handler was never
 * performance, it was coupling.
 */
export function makeAuthContainer(db: Database) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository,
      hashProvider,
      clock,
      idGenerator,
    ),
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>
