import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import { RefreshTokenReusedError } from '#modules/auth/errors/refresh-token-reused-error'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type {
  IssuedRefreshToken,
  RefreshTokenIssuer,
} from '#modules/auth/services/refresh-token-issuer'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface RefreshTokenCommand {
  refreshToken: string
}

export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
}

/**
 * What the transaction decided. Reuse is DATA on the way out and not an
 * exception, and that distinction is load-bearing — see the comment on the
 * branch that returns it.
 */
type RotationOutcome =
  | { readonly reused: true }
  | { readonly reused: false; readonly issued: IssuedRefreshToken }

const REUSE_DETECTED: RotationOutcome = { reused: true }

/**
 * Rotates a refresh token (decision 11): the presented token is spent, a
 * successor is issued in the same family, and a token presented after it was
 * already spent revokes the entire family.
 *
 * Receives the unit of work and NO repository directly — the rule of §9 of the
 * unit of work design, which neither the compiler nor the linter can enforce:
 * an injected singleton writes on an autocommit connection, so calling one
 * inside the callback compiles, passes its unit test against the passthrough
 * fake, and silently breaks atomicity in production.
 */
export class RefreshTokenUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly issuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly graceWindowMs: number,
  ) {}

  async execute(command: RefreshTokenCommand): Promise<RefreshTokenResult> {
    const tokenHash = this.tokenDigest.hash(command.refreshToken)
    // Read ONCE, outside the callback. The transaction runner re-executes the
    // callback on a deadlock retry, and a reading taken inside would give each
    // attempt a different instant — so the grace window would be measured
    // against whichever attempt happened to win.
    const now = this.clock.now()

    const outcome: RotationOutcome = await this.uow(async ({ refreshTokens }) => {
      // The row lock is what makes reuse detection possible at all: without it
      // two simultaneous refreshes of the same token both read it as active,
      // both rotate, and nothing is ever detected.
      const current = await refreshTokens.findByHashForUpdate(tokenHash)

      if (current === null) throw new InvalidRefreshTokenError()

      // Revoked BEFORE expired, and the order is normative. A client that
      // rotates one second before `expiresAt` and loses the response arrives
      // with a token that is revoked AND expired; answering on expiry first
      // would log it out — the very random logout the grace window removes.
      if (current.isRevoked()) {
        const supersededId = current.replacedBy

        // `replacedBy` is null exactly when the revocation came from a logout,
        // which must never be forgiven. `isWithinGraceWindow` checks that too —
        // it is read again here because the compiler cannot narrow a nullable
        // field through a method call, and the branch below needs the id.
        const withinGrace =
          supersededId !== null && current.isWithinGraceWindow(now, this.graceWindowMs)

        if (!withinGrace) {
          await refreshTokens.revokeFamily(current.familyId, now)

          // RETURNED, not thrown, and this is the whole point: throwing here
          // would roll the transaction back and undo the revocation just made.
          // Detection would fire, answer 401, and leave the stolen family alive
          // for the rest of its sixty days — the exact opposite of what it is
          // for. The failure is invisible to a passthrough unit-of-work fake,
          // because that fake models no rollback.
          return REUSE_DETECTED
        }

        // The successor already issued dies here, and dies WITHOUT a
        // `replacedBy` of its own — so presenting it lands in the branch above
        // instead of being forgiven again. That is what closes the fork: before
        // this, a stolen token replayed inside the window minted a second live
        // chain in the same family, neither chain ever presented a spent token,
        // and detection never fired again for that family.
        //
        // It costs nothing in the case the window exists for: when the response
        // was lost in a tunnel, the successor killed here is the one that
        // reached nobody. It DOES require the client to serialise its refresh
        // calls — two concurrent refreshes of the same token would leave it
        // holding a successor this line killed (decision 11).
        //
        // Revoked BEFORE the replacement is issued, so "at most one live token
        // per family" holds even in the middle of the transaction.
        await refreshTokens.revoke(supersededId, now)

        // `current` itself is left untouched: its `revokedAt` must not move, or
        // a client stuck in a retry loop would hold an eternal session.
        return {
          reused: false,
          issued: await this.#issueInto(
            refreshTokens,
            current.userId,
            current.familyId,
            now,
          ),
        }
      }

      if (current.isExpired(now)) throw new InvalidRefreshTokenError()

      const next = await this.#issueInto(
        refreshTokens,
        current.userId,
        current.familyId,
        now,
      )
      await refreshTokens.markRotated(current.id, next.entity.id, now)

      return { reused: false, issued: next }
    })

    // Thrown AFTER the commit, so the revocation survives the refusal.
    if (outcome.reused) throw new RefreshTokenReusedError()

    return {
      // Signed AFTER the commit: it depends on the user id, not on the
      // transaction, and everything that does not need the transaction stays
      // outside it.
      accessToken: await this.tokenSigner.sign({ sub: outcome.issued.entity.userId }),
      refreshToken: outcome.issued.token,
    }
  }

  /**
   * The token is generated INSIDE the transaction on purpose: the runner may
   * re-execute this callback, and generating outside would hand the client a
   * value produced before an attempt that rolled back. `randomBytes` costs
   * microseconds, so the "compute before" rule — which exists against argon2
   * and network I/O — does not reach it.
   */
  async #issueInto(
    refreshTokens: IRefreshTokensRepository,
    userId: string,
    familyId: string,
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const issued = this.issuer.issue(userId, familyId, now)
    await refreshTokens.save(issued.entity)

    return issued
  }
}
