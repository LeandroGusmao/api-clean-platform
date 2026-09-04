import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { accountAlreadyExistsEmail } from '#modules/auth/notifications/verification-email'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  DeliverVerification,
  EmailVerificationIssuer,
} from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. The value objects validate it. */
export interface RegisterUserCommand {
  email: string
  password: string
}

/**
 * Nothing truthful to send, and silence must cost the same as sending.
 *
 * A branch that returned nothing at all would make the caller write `if
 * (deliver !== undefined)`, and every such branch is a place where the response
 * could start to differ by case. One uniform `await deliver()` cannot.
 */
const NO_DELIVERY: DeliverVerification = async () => {}

/**
 * Creates an account and emails a verification code — and **answers the same
 * way whether or not the address was already taken**.
 *
 * That is the point of the rewrite. The endpoint used to answer 201 for a free
 * address and 409 for a taken one, which made it an oracle: any anonymous
 * caller could test whether an address had an account here. Now every path ends
 * in a resolved promise, and what differs is the email the address receives —
 * which only its owner can read.
 *
 * `EmailAlreadyInUseError` is still thrown by the repository, and still comes
 * from the database's unique index rather than a prior lookup: checking and
 * then inserting races, and two simultaneous requests would both pass the
 * check. It simply loses its HTTP consumer and gains the `catch` below.
 *
 * The order matters. Both value objects run before the hash, so a bad payload
 * never pays argon2's cost; the hash runs before the transaction, because §8 of
 * the unit of work design forbids argon2 inside one; and the send runs after
 * the transaction has committed, because the runner re-executes its callback on
 * a deadlock and a rollback after a send means an email about an account that
 * does not exist.
 */
export class RegisterUserUseCase {
  constructor(
    /**
     * `Pick`, and the narrowing IS the rule (§9 of the unit of work design):
     * with the full interface, a `save` outside the transaction would compile.
     * The read is here for the collision path only — after a 23505 the
     * transaction is gone, and the decision of WHICH email to send needs to know
     * whether the existing account is already verified.
     */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    /** Narrowed for the same reason: the cooldown needs a read, never a write. */
    private readonly emailVerifications: Pick<
      IEmailVerificationsRepository,
      'findActiveByUserId'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly issuer: EmailVerificationIssuer,
    private readonly emailSender: IEmailSender,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
  ) {}

  async execute(command: RegisterUserCommand): Promise<void> {
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    // Before the transaction: §8 forbids argon2 inside one.
    const passwordHash = await this.hashProvider.hash(password.value)

    // Read ONCE — the same instant stamps the user, the code and its expiry.
    const now = this.clock.now()

    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now,
    })

    let deliver: DeliverVerification
    try {
      deliver = await this.uow(async ({ users, emailVerifications }) => {
        await users.save(user)

        // Returned, never called, inside the callback: `issueFor` hands the send
        // back precisely so nothing in here can put an email on the wire.
        return this.issuer.issueFor(user, emailVerifications, now)
      })
    } catch (error) {
      // Narrow, and rethrow everything else. A bare `catch` here would swallow a
      // deadlock, a connection failure or a bug into a silent 202 — the endpoint
      // would tell the caller the registration was accepted and nothing would
      // have been written.
      if (!(error instanceof EmailAlreadyInUseError)) throw error

      deliver = await this.#deliverForExistingAccount(email, now)
    }

    // One line, one call, for every branch: this is where "indistinguishable"
    // stops being a comment and becomes the control flow.
    await deliver()
  }

  /**
   * The address is taken, and the response must not say so — so the decision of
   * what the owner is told moves into the mail.
   *
   * The unverified branch is what keeps 202 honest. Without it, someone who
   * registered, lost the email, and tried again would be told they already have
   * an account and would be stuck forever. With it, registering again IS
   * resending — subject to the same cooldown, so it cannot be used to flood.
   */
  async #deliverForExistingAccount(
    email: Email,
    now: Date,
  ): Promise<DeliverVerification> {
    const existing = await this.usersRepository.findByEmail(email)

    // Raced: the row was deleted between the violation and this read. Nothing
    // truthful to send.
    if (existing === null) return NO_DELIVERY

    if (existing.emailVerifiedAt !== null) {
      // `existing.email`, not the request's `email`: the two agree today only
      // by accident. The lookup matched through Postgres `lower()`, while
      // `Email.create` normalises with JavaScript's `toLowerCase()`, and the
      // two can disagree on exotic codepoints (see the comment on
      // `in-memory-users-repository.ts`). Mail the address that is stored.
      return () => this.emailSender.send(accountAlreadyExistsEmail(existing.email))
    }

    const active = await this.emailVerifications.findActiveByUserId(existing.id)
    if (
      active !== null &&
      now.getTime() - active.createdAt.getTime() < this.resendCooldownMs
    ) {
      return NO_DELIVERY
    }

    // A second unit of work, opened after the first one has already unwound —
    // sequential, not nested, so the AsyncLocalStorage guard of §4.2 does not
    // fire. Measured, not assumed: `runAttempt` closes its box in `finally`,
    // which runs when the transaction SETTLES, so the flag is already false
    // when the rejection reaches the `catch` above — and the `catch` resumes in
    // the caller's own async context, which never had a store to begin with.
    // Both halves are asserted in `transaction-runner.spec.ts`.
    //
    // Still a transaction, and not two autocommit writes: the two writes inside
    // `issueFor` invalidate the previous code and insert the new one, and a
    // failure between them would leave the account with no live code at all.
    return this.uow((repos) =>
      this.issuer.issueFor(existing, repos.emailVerifications, now),
    )
  }
}
