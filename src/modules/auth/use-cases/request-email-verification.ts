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
 * That is the whole point, same as `RegisterUserUseCase`: a status that told
 * the four cases apart would turn this endpoint into the account oracle
 * Task 8's rewrite of `register` spent a wire-contract change closing. Every
 * branch below is a plain `return`, and the one branch that does something
 * ends in the same `await deliver()` as every other route out.
 *
 * **This closes the response, not the timing.** The branch that actually
 * sends pays a transaction and a full SMTP round trip that the other three do
 * not — a real, unmeasured latency gap, not a status or a body difference.
 * See §12 of the design spec for the accepted cost, and the outbox in §5.3
 * for the actual fix.
 *
 * The send happens after the transaction commits, through the thunk
 * `issueFor` returns — §8 of the unit of work design forbids I/O inside the
 * callback, because the runner re-executes it on a deadlock and a rollback
 * after a send means an email about a code that was never persisted.
 */
export class RequestEmailVerificationUseCase {
  constructor(
    /**
     * `Pick`, and the narrowing IS the rule (§9 of the unit of work design):
     * this use case only ever reads a user, never writes one.
     */
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
    // response must not say which. The STATUS and BODY are identical to every
    // other branch — but not the latency: this branch returns after one
    // indexed SELECT, while the branch that actually sends pays a second
    // SELECT, a transaction, and a full SMTP round trip. That gap is real and
    // unmeasured; closing it means taking the send off the request path
    // entirely (the outbox deferred in §5.3 of the design). See §12 of the
    // design spec for the accepted cost.
    if (user === null || user.emailVerifiedAt !== null) return

    // Read ONCE — R7 — and used for both the cooldown comparison and the new
    // code's timestamps, so the two cannot drift apart.
    const now = this.clock.now()

    const active = await this.emailVerifications.findActiveByUserId(user.id)
    // Strictly less than: a resend at EXACTLY the cooldown's age is allowed.
    // A code minted a moment ago must not be reissued on demand, or the
    // cooldown would mint fresh attempt budget for free.
    if (active !== null && now.getTime() - active.createdAt.getTime() < this.cooldownMs) {
      return
    }

    // Returned, never called, inside the callback: `issueFor` hands the send
    // back precisely so nothing in here can put an email on the wire.
    const deliver = await this.uow(({ emailVerifications }) =>
      this.issuer.issueFor(user, emailVerifications, now),
    )

    await deliver()
  }
}
