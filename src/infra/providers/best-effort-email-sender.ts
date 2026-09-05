import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const SEND_FAILED_MESSAGE = 'best-effort email delivery failed'

/**
 * The only thing this decorator needs from a logger, declared as its own shape
 * for the same reason `WarnLogger` is: pino's methods are overloaded, and
 * picking one drags every overload along, which would make this untestable
 * without a full pino instance.
 */
export interface ErrorLogger {
  error(details: Record<string, unknown>, message: string): void
}

/**
 * Swallows a delivery failure instead of letting it fail the request.
 *
 * It exists because the two families of email in this system want OPPOSITE
 * policies. A verification code that fails to send should propagate: the
 * account is unusable without it, and whether registering again heals it
 * depends on timing, not just on the collision path existing. OUTSIDE the
 * resend cooldown, a retry issues a fresh code and resends for real. INSIDE
 * it — the likely case for a retry attempted right away — the failed
 * attempt's code row is already persisted, its `createdAt` still suppresses a
 * fresh one, and the retry answers 202 and sends nothing until the cooldown
 * lapses (§12 of the design spec records this as an accepted cost). A "your
 * password was changed" notice must not propagate at all: the password has
 * ALREADY changed, so a 500 would tell the user the change failed while their
 * old password no longer works — active misinformation, and worse than
 * silence.
 *
 * The policy lives here, in infrastructure, and is applied by wiring, because
 * decision 15 forbids the use case from receiving a logger — and a use case that
 * caught this itself would have nowhere to report it. The composition root wraps
 * the sender for the notification and passes the bare one everywhere else, which
 * puts the choice where decision 08 says it belongs.
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
