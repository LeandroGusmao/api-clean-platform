import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IEmailVerificationsRepository } from './email-verifications-repository.js'
import type { IRefreshTokensRepository } from './refresh-tokens-repository.js'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * `refreshTokens` is what the rotation writes twice in one transaction —
 * revoking the current token and inserting its successor — which is the case
 * decision 22 was written for.
 *
 * `emailVerifications` is here for the same reason: confirming an email burns
 * the code and stamps `users.email_verified_at` in one transaction — it is one
 * fact, and either both writes land or neither does.
 */
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
  emailVerifications: IEmailVerificationsRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
