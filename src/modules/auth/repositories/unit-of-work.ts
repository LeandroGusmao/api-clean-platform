import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * One entry today, on purpose: the refresh token slice adds `refreshTokens`
 * here and in `auth-repositories.ts`, and nothing else in the project changes.
 * That cost is what this slice exists to make small.
 */
export interface AuthRepos {
  users: IUsersRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
