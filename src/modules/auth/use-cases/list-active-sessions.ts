import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IClock } from '#shared/ports/clock'

/**
 * The `family_id` IS the session id — a login opens one, rotation stays
 * inside it. `createdAt` is the active token's own timestamp, so it reflects
 * the last rotation, not necessarily when the session first opened.
 */
export interface ActiveSessionResult {
  id: string
  createdAt: Date
  expiresAt: Date
}

/**
 * Lists the authenticated user's active sessions, one entry per refresh-token
 * family that still has a live row.
 *
 * The id always comes from the verified access token, never from client
 * input — the endpoint reads it with `getPrincipal`.
 */
export class ListActiveSessionsUseCase {
  constructor(
    private readonly refreshTokensRepository: Pick<
      IRefreshTokensRepository,
      'findActiveByUserId'
    >,
    private readonly clock: IClock,
  ) {}

  async execute(userId: string): Promise<ActiveSessionResult[]> {
    const now = this.clock.now()

    const tokens = await this.refreshTokensRepository.findActiveByUserId(userId, now)

    return tokens.map((token) => ({
      id: token.familyId,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
    }))
  }
}
