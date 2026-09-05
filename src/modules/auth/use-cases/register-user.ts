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
 * Nothing truthful to send. A no-op rather than an absent value, so every
 * branch ends in the same `await deliver()` and none can start to differ.
 *
 * It does NOT make silence cost the same as a send — the sending branch still
 * pays a transaction and an SMTP round trip. §12 of the design spec records
 * that gap as an accepted cost.
 */
const NO_DELIVERY: DeliverVerification = async () => {}

/**
 * Creates an account and emails a verification code — and **answers the same
 * way whether or not the address was already taken**, so it cannot be used to
 * test which addresses have accounts. What differs is the email the address
 * receives, which only its owner can read.
 *
 * Uniqueness comes from the database's unique index, never a prior lookup:
 * checking and then inserting races. `EmailAlreadyInUseError` still marks it;
 * the `catch` below is now its only consumer.
 *
 * The order is normative: value objects before the hash, so a bad payload never
 * pays argon2; the hash before the transaction (§8 forbids argon2 inside one);
 * the send after the commit (§8 again — the runner re-executes its callback on
 * a deadlock, and a rollback after a send describes an account that does not
 * exist).
 */
export class RegisterUserUseCase {
  constructor(
    /**
     * `Pick`, and the narrowing IS the rule (§9): with the full interface a
     * write outside the transaction would compile. Read only, for the collision
     * path — the transaction is gone by then, and choosing WHICH email to send
     * needs to know whether the existing account is verified.
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

        // Returned, never called: `issueFor` hands the send back so nothing in
        // here can put an email on the wire.
        return this.issuer.issueFor(user, emailVerifications, now)
      })
    } catch (error) {
      // Rethrow everything else. A bare `catch` would turn a deadlock or a bug
      // into a silent 202, telling the caller a registration was accepted when
      // nothing was written.
      if (!(error instanceof EmailAlreadyInUseError)) throw error

      deliver = await this.#deliverForExistingAccount(email, passwordHash, now)
    }

    // One call for every branch — the control flow is what makes the responses
    // indistinguishable.
    await deliver()
  }

  /**
   * The address is taken, and the response must not say so — so the decision of
   * what the owner is told moves into the mail.
   *
   * The unverified branch is what keeps 202 honest: without it, someone who
   * registered, lost the email and tried again would be told they already have
   * an account and be stuck forever. With it, registering again IS resending,
   * under the same cooldown so it cannot be used to flood.
   */
  async #deliverForExistingAccount(
    email: Email,
    passwordHash: string,
    now: Date,
  ): Promise<DeliverVerification> {
    const existing = await this.usersRepository.findByEmail(email)

    // Raced: the row was deleted between the violation and this read. Nothing
    // truthful to send.
    if (existing === null) return NO_DELIVERY

    if (existing.emailVerifiedAt !== null) {
      // The STORED address, not the request's: the lookup matched through
      // Postgres `lower()` while `Email.create` folds with JavaScript's
      // `toLowerCase()`, and the two can disagree on exotic codepoints.
      return () => this.emailSender.send(accountAlreadyExistsEmail(existing.email))
    }

    const active = await this.emailVerifications.findActiveByUserId(existing.id)
    if (
      active !== null &&
      now.getTime() - active.createdAt.getTime() < this.resendCooldownMs
    ) {
      return NO_DELIVERY
    }

    // Sequential, not nested: the first unit of work has already unwound, so
    // the guard of §4.2 does not fire. A transaction rather than two autocommit
    // writes because `issueFor` invalidates the old code and inserts the new
    // one, and a failure between them would leave no live code at all.
    return this.uow(async (repos) => {
      // The password and the live code MUST come from the same registration.
      // An unverified account has no proven owner, so the latest registrant's
      // password is the one to keep — and writing it in the SAME transaction
      // that issues the code is what binds the two.
      //
      // Do NOT move this write to the cooldown branch, where no code is issued:
      // that decouples them, and an attacker registering inside the victim's
      // cooldown would set their own password onto a code already sitting in
      // the victim's inbox.
      await repos.users.updatePasswordHash(existing.id, passwordHash, now)

      return this.issuer.issueFor(existing, repos.emailVerifications, now)
    })
  }
}
