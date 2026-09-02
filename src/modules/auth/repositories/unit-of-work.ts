import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IRefreshTokensRepository } from './refresh-tokens-repository.js'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * `refreshTokens` is what the rotation writes twice in one transaction —
 * revoking the current token and inserting its successor — which is the case
 * decision 22 was written for.
 */
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
