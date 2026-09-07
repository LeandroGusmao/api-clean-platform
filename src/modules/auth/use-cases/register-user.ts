import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { accountAlreadyExistsEmail } from '#modules/auth/notifications/verification-email'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  DeliverVerification,
  EmailVerificationIssuer,
} from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. The value object validates it. */
export interface RegisterUserCommand {
  email: string
}

/**
 * Nothing truthful to send. A no-op rather than an absent value, so every branch
 * ends in the same `await deliver()` and none can start to differ (§5.4).
 */
const NO_DELIVERY: DeliverVerification = async () => {}

/**
 * Starts sign-up for an email address: writes a pending registration carrying a
 * six-digit code, and emails the code. The account is created later, at
 * confirmation, with the password supplied then (§1 of the slice 11 design) — so
 * this use case never hashes a password and never opens a transaction.
 *
 * It **answers the same way** whether the address is free, already has a pending
 * registration, or belongs to a verified account: what differs is the email the
 * address receives, and only its owner can read it.
 *
 * The order is normative: the value object before anything else, so a bad
 * payload never reaches a repository; the prune and the insert are plain
 * autocommit statements; the send after the write (§8 — a rollback after a send
 * would describe a registration that does not exist, and here there is no
 * rollback at all).
 */
export class RegisterUserUseCase {
  constructor(
    /** `Pick`, and the narrowing IS the rule (§9): this path only ever reads. */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'save' | 'deleteExpiredByEmail'
    >,
    private readonly issuer: EmailVerificationIssuer,
    private readonly emailSender: IEmailSender,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
    private readonly maxAttempts: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RegisterUserCommand): Promise<void> {
    const email = Email.create(command.email)

    // Read ONCE — the same instant stamps the pending row, its code and its
    // expiry.
    const now = this.clock.now()

    const deliver = await this.#planDelivery(email, now)

    // One call for every branch — the control flow is what makes the responses
    // indistinguishable.
    await deliver()
  }

  async #planDelivery(email: Email, now: Date): Promise<DeliverVerification> {
    const existingUser = await this.usersRepository.findByEmail(email)
    if (existingUser !== null) {
      // The account is only ever born verified, so this is the "you already have
      // an account" branch. The STORED address, not the request's: the lookup
      // matched through Postgres `lower()` while `Email.create` folds with
      // JavaScript's `toLowerCase()`, and the two can disagree on exotic
      // codepoints.
      return () => this.emailSender.send(accountAlreadyExistsEmail(existingUser.email))
    }

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const mostRecentUsable = pendings.find((each) => each.isUsable(this.maxAttempts, now))
    if (
      mostRecentUsable !== undefined &&
      now.getTime() - mostRecentUsable.codeIssuedAt.getTime() < this.resendCooldownMs
    ) {
      // Registering again inside the cooldown IS resending — it must not put a
      // second email in the address's inbox, and it must not mint fresh attempt
      // budget on demand.
      return NO_DELIVERY
    }

    await this.pendingRegistrations.deleteExpiredByEmail(email, now)

    const { codeHash, deliver } = this.issuer.issue(email)
    await this.pendingRegistrations.save(
      PendingRegistration.create({
        id: this.idGenerator.generate(),
        email,
        codeHash,
        now,
        ttlSeconds: this.ttlSeconds,
      }),
    )

    return deliver
  }
}
