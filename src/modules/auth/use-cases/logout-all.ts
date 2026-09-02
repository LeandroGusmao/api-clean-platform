import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IClock } from '#shared/ports/clock'

/**
 * Ends every session of one user, across every device.
 *
 * The id comes from the verified access token, never from client input — the
 * endpoint reads it with `getPrincipal`.
 *
 * Note what this does NOT do: an access token already issued stays valid until
 * it expires. That is the revocation latency decision 11 accepted when it kept
 * the database out of the authenticated path, and it is the TTL of the access
 * token — one hour by default.
 *
 * Takes the unit of work for the same reason `LogoutUseCase` does: the retry,
 * not atomicity.
 */
export class LogoutAllUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly clock: IClock,
  ) {}

  async execute(userId: string): Promise<void> {
    const now = this.clock.now()

    await this.uow(({ refreshTokens }) => refreshTokens.revokeAllForUser(userId, now))
  }
}
