import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'

/**
 * The profile as the application answers it, independent of transport.
 *
 * Flat by design: the `Email` value object is unwrapped here, so no consumer has
 * to know the entity's internal types. Timestamps stay `Date` — formatting one
 * is the transport's concern, and returning an ISO string would make this pure
 * use case serve HTTP specifically, leaving the worker and cron entrypoints of
 * decision 10 to parse it back.
 */
export interface UserProfileResult {
  id: string
  email: string
  emailVerifiedAt: Date | null
  createdAt: Date
}

/**
 * Reads the authenticated user's own profile.
 *
 * The id always comes from the verified token's subject, never from client
 * input — that is what makes the route principal-scoped.
 */
export class GetUserProfileUseCase {
  constructor(private readonly usersRepository: IUsersRepository) {}

  async execute(userId: string): Promise<UserProfileResult> {
    const user = await this.usersRepository.findById(userId)
    if (user === null) throw new UserNotFoundError()

    return {
      id: user.id,
      email: user.email.value,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    }
  }
}
