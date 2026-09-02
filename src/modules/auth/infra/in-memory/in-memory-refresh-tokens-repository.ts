import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It models NO row lock, because there is nothing to lock: a unit test runs one
 * call at a time. Concurrency is proved against real Postgres, in
 * `tests/integration/drizzle-refresh-tokens-repository.spec.ts` — treating this
 * class as evidence that the locking works would be exactly the mistake
 * `FOR UPDATE` exists to prevent.
 */
export class InMemoryRefreshTokensRepository implements IRefreshTokensRepository {
  readonly tokens: RefreshToken[] = []

  async save(token: RefreshToken): Promise<void> {
    this.tokens.push(token)
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    return this.tokens.find((token) => token.tokenHash === tokenHash) ?? null
  }

  async markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void> {
    this.#replace((token) => token.id === id, { revokedAt, replacedBy })
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    this.#replace((token) => token.id === id && token.revokedAt === null, { revokedAt })
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    this.#replace((token) => token.familyId === familyId && token.revokedAt === null, {
      revokedAt,
    })
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    this.#replace((token) => token.userId === userId && token.revokedAt === null, {
      revokedAt,
    })
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replace(
    matches: (token: RefreshToken) => boolean,
    changes: { revokedAt: Date; replacedBy?: string },
  ): void {
    this.tokens.forEach((token, index) => {
      if (!matches(token)) return

      this.tokens[index] = RefreshToken.fromTrusted({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        familyId: token.familyId,
        expiresAt: token.expiresAt,
        revokedAt: changes.revokedAt,
        replacedBy: changes.replacedBy ?? token.replacedBy,
        createdAt: token.createdAt,
      })
    })
  }
}
