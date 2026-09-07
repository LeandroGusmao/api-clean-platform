import { verificationEmail } from '#modules/auth/notifications/emails'
import type { Email } from '#modules/auth/value-objects/email'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** Six digits: what a person can retype from a phone without copy and paste. */
export const VERIFICATION_CODE_DIGITS = 6

/**
 * The send, deferred. Calling it is what puts an email on the wire.
 */
export type DeliverVerification = () => Promise<void>

/**
 * Mints a verification code and returns its digest plus the deferred send.
 *
 * **Returning the send is what makes §8 structural instead of advisory:** with
 * nothing here that sends, a caller cannot put an email on the wire from inside
 * a transaction — where a deadlock retry would send it up to three times, and a
 * rollback would describe a registration that does not exist. Persistence is the
 * caller's job: the `register` and `resend` use cases write the digest onto a
 * `pending_registrations` row.
 */
export class EmailVerificationIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly ttlSeconds: number,
  ) {}

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
