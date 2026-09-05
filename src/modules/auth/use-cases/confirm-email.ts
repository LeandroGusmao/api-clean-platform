import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface ConfirmEmailCommand {
  email: string
  code: string
}

export interface ConfirmEmailResult {
  accessToken: string
  refreshToken: string
}

/**
 * Redeems a six-digit verification code, marks the account verified, and logs
 * it in — the code is spent for one session, not just for a "verified" flag,
 * which saves the caller a second round trip and a second password prompt
 * (§6.6 of the design spec).
 *
 * **One error for every failure mode.** Unknown email, no active code,
 * expired, attempts exhausted, wrong code, and losing the race to consume the
 * code all throw the same `EmailVerificationFailedError`, with the same
 * message. Six branches reporting differently would turn this endpoint into an
 * account-and-code oracle for an anonymous caller — the same reasoning
 * `LoginUserUseCase` documents for its single `InvalidCredentialsError` throw.
 */
export class ConfirmEmailUseCase {
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    /**
     * `registerFailedAttempt` is a WRITE, and it is in this Pick on purpose.
     *
     * §9 of the unit of work design tells a use case holding the UoW to declare
     * its direct repository with the READ methods it uses. This is the first
     * justified exception, and the third line of §8 is the justification: a
     * brute-force counter written inside a transaction that rolls back is erased
     * exactly when it matters. The rule is therefore not "reads only" but "what
     * the use case uses, and a write only where §8 puts it outside".
     */
    private readonly verifications: Pick<
      IEmailVerificationsRepository,
      'findActiveByUserId' | 'registerFailedAttempt'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly maxAttempts: number,
  ) {}

  async execute(command: ConfirmEmailCommand): Promise<ConfirmEmailResult> {
    const user = await this.usersRepository.findByEmail(Email.create(command.email))
    const verification =
      user === null ? null : await this.verifications.findActiveByUserId(user.id)

    // Read ONCE. The same instant stamps `consumed_at`, `email_verified_at` and
    // the new refresh token's `created_at` — three columns across three tables
    // that one transaction makes atomic, and three clock reads would not.
    const now = this.clock.now()

    // Unknown email, no active code, expired, or attempts already spent: all
    // four collapse into the same throw, before any digest is even computed.
    if (
      user === null ||
      verification === null ||
      !verification.isUsable(this.maxAttempts, now)
    ) {
      throw new EmailVerificationFailedError()
    }

    if (!verification.matches(this.tokenDigest.hash(command.code))) {
      // Outside the transaction, autocommit — §8, line 3: this counter has to
      // survive the throw two lines below, and a write inside a transaction
      // that always rolls back on this path would be erased exactly when it
      // matters, turning the attempt cap into a no-op.
      //
      // The return is not branched on. A wrong guess throws the same error
      // whether or not this call was the one that spent the cap's last slot —
      // that is what keeps this endpoint from distinguishing "still has
      // guesses left" from "just ran out" for an anonymous caller. What makes
      // the cap actually hold under N concurrent guesses is the atomic
      // `WHERE ... AND attempts < maxAttempts` inside `registerFailedAttempt`
      // itself, not anything done with its result here.
      await this.verifications.registerFailedAttempt(verification.id, this.maxAttempts)
      throw new EmailVerificationFailedError()
    }

    // Cheap (random bytes plus a digest), computed before the transaction like
    // `ChangePasswordUseCase` does — it only depends on what is already known,
    // and nothing here needs it to be atomic with the writes below.
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ users, emailVerifications, refreshTokens }) => {
      // The conditional `UPDATE` behind `consume` is what makes single use
      // race-proof without an explicit lock. Losing it means some OTHER request
      // already burned this code between the read above and this call, so the
      // throw has to happen INSIDE the callback — a `return` here would leave
      // the account verified by a code a concurrent confirm had already spent,
      // with no session to show for it.
      if (!(await emailVerifications.consume(verification.id, now))) {
        throw new EmailVerificationFailedError()
      }

      await users.markEmailVerified(user.id, now, now)

      // `refreshTokens` is already in `AuthRepos`, so this costs nothing extra
      // to keep inside — and it is what makes "verified" and "logged in" one
      // atom: a session-issuing failure rolls the verification back too, and
      // the SAME code still works on retry.
      await refreshTokens.save(issued.entity)
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
