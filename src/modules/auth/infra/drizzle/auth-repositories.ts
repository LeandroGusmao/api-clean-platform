import type { Database } from '#infra/database/client'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { DrizzleFederatedIdentitiesRepository } from './drizzle-federated-identities-repository.js'
import { DrizzleOutboxMessagesRepository } from './drizzle-outbox-messages-repository.js'
import { DrizzlePasswordResetTokensRepository } from './drizzle-password-reset-tokens-repository.js'
import { DrizzlePendingRegistrationsRepository } from './drizzle-pending-registrations-repository.js'
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
    pendingRegistrations: new DrizzlePendingRegistrationsRepository(db),
    passwordResetTokens: new DrizzlePasswordResetTokensRepository(db),
    federatedIdentities: new DrizzleFederatedIdentitiesRepository(db),
    outboxMessages: new DrizzleOutboxMessagesRepository(db),
  }
}
