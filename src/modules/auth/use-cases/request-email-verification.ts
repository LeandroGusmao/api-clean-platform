import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'

const MILLISECONDS_PER_SECOND = 1000

/** Raw, untrusted input. The value object validates it. */
export interface RequestEmailVerificationCommand {
  email: string
}

/**
 * Resends the six-digit verification code — and **answers with the same status
 * and body** for an unknown address, a real account, a request inside the
 * cooldown, and a code that is actually sent. A status that told the cases apart
 * would be an account oracle.
 *
 * **This closes the response, not the timing:** the sending branch pays an
 * `UPDATE` and an SMTP round trip the others do not, and one timed request
 * tells "unverified address with no recent code" apart from the rest. Closing
 * it means taking the send off the request path, through the outbox. Accepted
 * as a known cost.
 *
 * The send happens after the write, through the thunk `issue` returns.
 */
export class RequestEmailVerificationUseCase {
  constructor(
    /** `Pick`: this only ever reads users. */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'reissueCode'
    >,
    private readonly issuer: EmailVerificationIssuer,
    private readonly clock: IClock,
    private readonly cooldownMs: number,
    private readonly maxAttempts: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RequestEmailVerificationCommand): Promise<void> {
    const email = Email.create(command.email)

    // A real account only ever exists verified: nothing to
    // resend, and the response must not say which address that was.
    const user = await this.usersRepository.findByEmail(email)
    if (user !== null) return

    // Read ONCE — R7 — for both the cooldown comparison and the new code's
    // timestamps, so the two cannot drift apart.
    const now = this.clock.now()

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const target = pendings.find((each) => each.isUsable(this.maxAttempts, now))
    if (target === undefined) return

    // Strictly less than: a resend at EXACTLY the cooldown's age is allowed.
    // Reissuing on demand would mint fresh attempt budget for free.
    if (now.getTime() - target.codeIssuedAt.getTime() < this.cooldownMs) return

    const { codeHash, deliver } = this.issuer.issue(email)
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * MILLISECONDS_PER_SECOND)
    await this.pendingRegistrations.reissueCode(target.id, codeHash, now, expiresAt)

    await deliver()
  }
}
