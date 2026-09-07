import type { Database } from '#infra/database/client'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { DrizzleEmailVerificationsRepository } from './drizzle-email-verifications-repository.js'
import { DrizzleRefreshTokensRepository } from './drizzle-refresh-tokens-repository.js'
import { DrizzleUsersRepository } from './drizzle-users-repository.js'

/**
 * The only place that knows the module's full repository set.
 *
 * Serves both sides with one function: hand it the pool handle for the
 * autocommit singletons the container holds, or a transaction handle for
 * repositories bound to it. `Database` is the union of the two, which is why no
 * existing repository changes.
 */
export function authRepositories(db: Database): AuthRepos {
  return {
    users: new DrizzleUsersRepository(db),
    refreshTokens: new DrizzleRefreshTokensRepository(db),
    emailVerifications: new DrizzleEmailVerificationsRepository(db),
  }
}
