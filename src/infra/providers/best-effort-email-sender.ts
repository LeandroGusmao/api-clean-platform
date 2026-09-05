import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const SEND_FAILED_MESSAGE = 'best-effort email delivery failed'

/**
 * Its own shape rather than `Pick<AppLogger, 'error'>`, for the reason
 * `WarnLogger` documents: pino's methods are overloaded, and picking one drags
 * every overload along, leaving nothing a hand-written double can satisfy.
 */
export interface ErrorLogger {
  error(details: Record<string, unknown>, message: string): void
}

/**
 * Swallows a delivery failure instead of letting it fail the request.
 *
 * For a notice about something that ALREADY happened — "your password was
 * changed" — a 500 would say the change failed while the old password no longer
 * works, which is worse than silence. A verification code is the opposite case
 * and must keep propagating, so this wraps only the senders that carry notices.
 *
 * A decorator applied by wiring, not a branch inside the use case, because
 * decision 15 leaves the pure layer with no logger to report the failure to.
 */
export class BestEffortEmailSender implements IEmailSender {
  constructor(
    private readonly inner: IEmailSender,
    private readonly logger: ErrorLogger,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.inner.send(message)
    } catch (error) {
      // The subject, never the body: a body can carry a code, and `to` is
      // already an address the log has no reason to repeat in full.
      this.logger.error({ err: error, subject: message.subject }, SEND_FAILED_MESSAGE)
    }
  }
}
