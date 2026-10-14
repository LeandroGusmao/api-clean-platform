import { passwordResetEmail } from '#modules/auth/emails/messages'
import type { Email } from '#modules/auth/value-objects/email'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** The send, deferred. Calling it is what puts an email on the wire. */
export type DeliverPasswordReset = () => Promise<void>

/**
 * Mints a 256-bit opaque reset token and returns its digest plus the deferred
 * send. Nothing here persists or sends: the `forgot` use case writes the digest
 * onto a `password_reset_tokens` row and awaits `deliver()` after the write, so
 * no email ever carries a token that failed to persist.
 */
export class PasswordResetIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly ttlSeconds: number,
  ) {}

  issue(email: Email): { tokenHash: string; deliver: DeliverPasswordReset } {
    const token = this.tokenGenerator.opaque()

    return {
      tokenHash: this.tokenDigest.hash(token),
      deliver: () =>
        this.emailSender.send(passwordResetEmail(email, token, this.ttlSeconds)),
    }
  }
}
