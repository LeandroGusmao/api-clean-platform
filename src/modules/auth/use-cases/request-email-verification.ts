import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'

/** Raw, untrusted input. The value object validates it. */
export interface RequestEmailVerificationCommand {
  email: string
}

/**
 * Resends the six-digit verification code — and **answers with the same
 * status and body for an unknown address, an already-verified account, a
 * request inside the cooldown, and a code that is actually sent.**
 *
 * A status that told the four cases apart would make this an account oracle,
 * which is what `register` gave up its 409 to close.
 *
 * **This closes the response, not the timing** — the sending branch pays a
 * transaction and an SMTP round trip the others do not. §12 of the design spec
 * records that gap; the outbox in §5.3 is the fix.
 *
 * The send happens after the commit, through the thunk `issueFor` returns (§8).
 */
export class RequestEmailVerificationUseCase {
  constructor(
    /** `Pick`, and the narrowing IS the rule (§9): this only ever reads. */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    /** Narrowed for the same reason: the cooldown needs a read, never a write. */
    private readonly emailVerifications: Pick<
      IEmailVerificationsRepository,
      'findActiveByUserId'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly issuer: EmailVerificationIssuer,
    private readonly clock: IClock,
    private readonly cooldownMs: number,
  ) {}

  async execute(command: RequestEmailVerificationCommand): Promise<void> {
    const user = await this.usersRepository.findByEmail(Email.create(command.email))

    // Unknown address, or already verified: nothing truthful to send, and the
    // response must not say which. Status and body match every other branch;
    // the latency does not — see the class comment.
    if (user === null || user.emailVerifiedAt !== null) return

    // Read ONCE — R7 — and used for both the cooldown comparison and the new
    // code's timestamps, so the two cannot drift apart.
    const now = this.clock.now()

    const active = await this.emailVerifications.findActiveByUserId(user.id)
    // Strictly less than: a resend at EXACTLY the cooldown's age is allowed.
    // Reissuing on demand would mint fresh attempt budget for free.
    if (active !== null && now.getTime() - active.createdAt.getTime() < this.cooldownMs) {
      return
    }

    // Returned, never called: nothing in here can put an email on the wire.
    const deliver = await this.uow(({ emailVerifications }) =>
      this.issuer.issueFor(user, emailVerifications, now),
    )

    await deliver()
  }
}
