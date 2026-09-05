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
 * Redeems a six-digit verification code, marks the account verified, and issues
 * a session — so confirming does not cost a second round trip and a second
 * password prompt.
 *
 * **One error for every failure mode**, with the same message: unknown email,
 * no active code, expired, attempts exhausted, wrong code, and losing the race
 * to consume it. Branches that reported differently would make this an
 * account-and-code oracle for an anonymous caller.
 */
export class ConfirmEmailUseCase {
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    /**
     * `registerFailedAttempt` is a WRITE in this `Pick` on purpose, and §9
     * allows it because §8 line 3 puts it outside the transaction: a
     * brute-force counter inside one is erased by the rollback that always
     * follows on this path.
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
      // Autocommit, outside the transaction (§8 line 3): this counter must
      // survive the throw below.
      //
      // The result is deliberately not branched on — a wrong guess reports the
      // same way whether or not it spent the last slot. What holds the cap under
      // concurrent guesses is the atomic `WHERE ... AND attempts < maxAttempts`
      // inside the method, not anything done with its return here.
      await this.verifications.registerFailedAttempt(verification.id, this.maxAttempts)
      throw new EmailVerificationFailedError()
    }

    // Before the transaction: it only depends on what is already known, and
    // nothing needs it atomic with the writes below.
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ users, emailVerifications, refreshTokens }) => {
      // `consume` is a conditional UPDATE, which is what makes single use
      // race-proof without a lock. Losing it means a concurrent confirm already
      // burned this code, so the throw must happen INSIDE the callback — a
      // `return` would leave the account verified with no session to show.
      if (!(await emailVerifications.consume(verification.id, now))) {
        throw new EmailVerificationFailedError()
      }

      await users.markEmailVerified(user.id, now, now)

      // Inside, so "verified" and "logged in" are one atom: a failure here rolls
      // the verification back and the same code still works on retry.
      await refreshTokens.save(issued.entity)
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
