import { EmailVerification } from '#modules/auth/entities/email-verification'
import type { User } from '#modules/auth/entities/user'
import { verificationEmail } from '#modules/auth/notifications/verification-email'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { Email } from '#modules/auth/value-objects/email'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** Six digits: what a person can retype from a phone without copy and paste. */
export const VERIFICATION_CODE_DIGITS = 6

/**
 * The send, deferred. Calling it is what puts an email on the wire.
 */
export type DeliverVerification = () => Promise<void>

/**
 * Mints a verification code, persists its digest, and returns the send.
 *
 * **Returning the send is what makes §8 structural instead of advisory:** with
 * nothing here that sends, a caller cannot put an email on the wire from inside
 * a transaction — where a deadlock retry would send it up to three times, and a
 * rollback would describe an account that does not exist.
 *
 * `verifications` is a parameter so the caller picks: the transaction-bound
 * repository joins the writes to its transaction, the singleton does not.
 */
export class EmailVerificationIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly idGenerator: IIdGenerator,
    private readonly ttlSeconds: number,
  ) {}

  async issueFor(
    user: User,
    verifications: IEmailVerificationsRepository,
    now: Date,
  ): Promise<DeliverVerification> {
    // Before the insert, always: only one code may be live per user, and a
    // reissue that left the previous one usable would multiply the attempt
    // budget an attacker gets by the number of resends they can trigger.
    await verifications.invalidateActiveForUser(user.id, now)

    const code = this.tokenGenerator.numericCode(VERIFICATION_CODE_DIGITS)

    await verifications.save(
      EmailVerification.create({
        id: this.idGenerator.generate(),
        userId: user.id,
        codeHash: this.tokenDigest.hash(code),
        now,
        ttlSeconds: this.ttlSeconds,
      }),
    )

    // Returned, NOT awaited. See the class comment.
    return () =>
      this.emailSender.send(verificationEmail(user.email, code, this.ttlSeconds))
  }

  /**
   * Mints a fresh six-digit code, returns its digest for the caller to persist,
   * and the deferred send. Nothing here persists or sends — one `await
   * deliver()` per branch is what keeps the 202 responses indistinguishable in
   * the caller's control flow (§5.4 of the slice 11 design).
   */
  issue(email: Email): { codeHash: string; deliver: DeliverVerification } {
    const code = this.tokenGenerator.numericCode(VERIFICATION_CODE_DIGITS)

    return {
      codeHash: this.tokenDigest.hash(code),
      deliver: () =>
        this.emailSender.send(verificationEmail(email, code, this.ttlSeconds)),
    }
  }
}
