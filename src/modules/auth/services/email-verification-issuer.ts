import { EmailVerification } from '#modules/auth/entities/email-verification'
import type { User } from '#modules/auth/entities/user'
import { verificationEmail } from '#modules/auth/notifications/verification-email'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
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
 * **Returning the send is the whole point, and it is what makes the first line
 * of §8 of the unit of work design structural instead of advisory.** The rule
 * says external I/O must happen AFTER the commit, for two independent reasons:
 * the transaction runner re-executes its callback on a deadlock, so a send in
 * there goes out up to three times; and a rollback after a send means an email
 * about an account that does not exist. Because this method hands the send back
 * rather than performing it, there is nothing inside the callback that could
 * send — the caller has to reach the returned function, outside, to do it.
 *
 * `verifications` is a PARAMETER and not a constructor dependency, so the caller
 * chooses which one: pass the transaction-bound repository from the `uow`
 * callback, and the writes join the transaction; pass the autocommit singleton,
 * and they stand alone.
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
}
