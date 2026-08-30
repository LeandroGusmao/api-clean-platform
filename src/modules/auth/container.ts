import type { Database } from '#infra/database/client'
import type { TransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import type { AuthConfig } from './config.js'
import { authRepositories } from './infra/drizzle/auth-repositories.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { JwtTokenSigner } from './infra/providers/jwt-token-signer.js'
import { GetUserProfileUseCase } from './use-cases/get-user-profile.js'
import { LoginUserUseCase } from './use-cases/login-user.js'
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
export function makeAuthContainer(
  db: Database,
  config: AuthConfig,
  runner: TransactionRunner,
) {
  const { users: usersRepository } = authRepositories(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()
  const tokenSigner = new JwtTokenSigner(config, clock)

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository,
      hashProvider,
      clock,
      idGenerator,
    ),
    loginUser: new LoginUserUseCase(usersRepository, hashProvider, tokenSigner),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
    /**
     * Not a use case: there is nothing to orchestrate. Decision 11 keeps the
     * database out of the authenticated path, so verification is signature
     * checking and nothing else. Published here so the composition root can
     * build the generic guard without any module coupling.
     */
    verifyAccessToken: (token: string) => tokenSigner.verify(token),
    /**
     * Published with no consumer yet: the rotation of the refresh token slice
     * is the first use case that writes twice and needs one transaction. Wired
     * here rather than only in the tests so that the first construction in
     * production does not happen in the same slice that first depends on it —
     * the worst place to find a wiring mistake.
     */
    uow: createUnitOfWork(runner, authRepositories),
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>
