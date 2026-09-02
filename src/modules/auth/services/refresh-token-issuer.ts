import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/**
 * The plaintext token and the row that remembers it. The plaintext exists only
 * long enough to reach the client — nothing persists it, and the server can
 * never reproduce it, which is why the grace window issues a NEW pair instead
 * of replaying the old one (decision 11).
 */
export interface IssuedRefreshToken {
  token: string
  entity: RefreshToken
}

/**
 * Mints one link of a refresh chain. A domain service rather than a method on
 * the entity: the entity must not know about ports, and this operation is the
 * same in `login` and in both branches of the rotation — inlining it three
 * times is how one of them ends up hashing with the wrong digest.
 *
 * It is also what keeps the constructors readable. Without it `LoginUserUseCase`
 * would take nine collaborators.
 */
export class RefreshTokenIssuer {
  constructor(
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly idGenerator: IIdGenerator,
    private readonly ttlSeconds: number,
  ) {}

  issue(userId: string, familyId: string, now: Date): IssuedRefreshToken {
    const token = this.tokenGenerator.opaque()

    return {
      token,
      entity: RefreshToken.create({
        id: this.idGenerator.generate(),
        userId,
        tokenHash: this.tokenDigest.hash(token),
        familyId,
        now,
        ttlSeconds: this.ttlSeconds,
      }),
    }
  }

  /** A login starts a new chain, so revoking one device never touches another. */
  newFamilyId(): string {
    return this.idGenerator.generate()
  }
}
