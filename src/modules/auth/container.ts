import type { Database } from '#infra/database/client'
import type { TransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { RandomTokenGenerator } from '#infra/providers/random-token-generator'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import type { AuthConfig } from './config.js'
import { authRepositories } from './infra/drizzle/auth-repositories.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { JwtTokenSigner } from './infra/providers/jwt-token-signer.js'
import { RefreshTokenIssuer } from './services/refresh-token-issuer.js'
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
  const { users: usersRepository, refreshTokens: refreshTokensRepository } =
    authRepositories(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()
  const tokenSigner = new JwtTokenSigner(config, clock)
  const tokenGenerator = new RandomTokenGenerator()
  const tokenDigest = new Sha256TokenDigest()
  const refreshTokenIssuer = new RefreshTokenIssuer(
    tokenGenerator,
    tokenDigest,
    idGenerator,
    config.REFRESH_TOKEN_TTL_SECONDS,
  )

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository,
      hashProvider,
      clock,
      idGenerator,
    ),
    loginUser: new LoginUserUseCase(
      usersRepository,
      hashProvider,
      tokenSigner,
      refreshTokensRepository,
      refreshTokenIssuer,
      clock,
    ),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
    /**
     * Not a use case: there is nothing to orchestrate. Decision 11 keeps the
     * database out of the authenticated path, so verification is signature
     * checking and nothing else. Published here so the composition root can
     * build the generic guard without any module coupling.
     */
    verifyAccessToken: (token: string) => tokenSigner.verify(token),
    /**
     * The cookie's `Max-Age` has to match the token's own lifetime, and the
     * endpoint is where the cookie is written — so both read this one value and
     * cannot drift apart.
     */
    refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
    /**
     * Still published, and now it has consumers: the rotation and both logouts
     * open their transaction through it. `tests/integration/unit-of-work.spec.ts`
     * also reaches for it directly to exercise the primitive on its own.
     */
    uow: createUnitOfWork(runner, authRepositories),
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>
