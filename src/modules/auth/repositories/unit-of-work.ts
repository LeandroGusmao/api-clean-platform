import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IPasswordResetTokensRepository } from './password-reset-tokens-repository.js'
import type { IPendingRegistrationsRepository } from './pending-registrations-repository.js'
import type { IRefreshTokensRepository } from './refresh-tokens-repository.js'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * `refreshTokens` is what the rotation writes twice in one transaction —
 * revoking the current token and inserting its successor — which is the case
 * decision 22 was written for.
 *
 * `pendingRegistrations` is here for the same reason: confirmation consumes the
 * pending row, inserts the `users` row and its first refresh token in one
 * transaction — one fact, and either all three land or none do.
 *
 * `passwordResetTokens` likewise: a reset burns the token, writes the new
 * password hash and revokes every session in one transaction — one fact.
 */
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
  pendingRegistrations: IPendingRegistrationsRepository
  passwordResetTokens: IPasswordResetTokensRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
