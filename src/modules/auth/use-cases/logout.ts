import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface LogoutCommand {
  refreshToken: string
}

/**
 * Ends one session by revoking the family of the presented token.
 *
 * Takes the unit of work even though it writes to a single repository, which
 * the guidance of decision 22 would not obviously require. The reason is the
 * RETRY, not atomicity: the rotation locks one row and then updates the whole
 * family, while this updates the family directly — overlapping row sets locked
 * in different orders, a plain AB-BA, so `40P01` is reachable. Outside the
 * runner that deadlock answers 500 for a request where nothing was wrong;
 * inside, it is retried and at worst becomes a 503.
 */
export class LogoutUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const tokenHash = this.tokenDigest.hash(command.refreshToken)
    const now = this.clock.now()

    await this.uow(async ({ refreshTokens }) => {
      const current = await refreshTokens.findByHashForUpdate(tokenHash)

      // An unknown token is not an error: reporting that it does not exist is a
      // free oracle, and "you are logged out" is already true.
      if (current === null) return

      // The whole family, not the single row: inside the grace window a family
      // legitimately holds more than one live token, and revoking one would
      // leave the session standing.
      await refreshTokens.revokeFamily(current.familyId, now)
    })
  }
}
