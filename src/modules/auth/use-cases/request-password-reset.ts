import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  DeliverPasswordReset,
  PasswordResetIssuer,
} from '#modules/auth/services/password-reset-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. The value object validates it. */
export interface RequestPasswordResetCommand {
  email: string
}

const MILLISECONDS_PER_SECOND = 1000

/**
 * Nothing truthful to send. A no-op rather than an absent value, so every
 * branch ends in the same `await deliver()` and none can start to differ.
 */
const NO_DELIVERY: DeliverPasswordReset = async () => {}

/**
 * Starts password recovery for an address. Writes (or refreshes in place) the
 * account's single reset token and emails it. Never opens a transaction — a
 * single upsert, like `register`.
 *
 * It answers the same way whether the address has an account, is inside the
 * resend cooldown, or has no account at all: what differs is the email, and
 * only its owner can read it. The order is normative — value object first so a
 * bad payload never reaches a repository; the send after the write (§8).
 */
export class RequestPasswordResetUseCase {
  constructor(
    /** `Pick`, and the narrowing IS the rule (§9): this path only reads. */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly passwordResetTokens: Pick<
      IPasswordResetTokensRepository,
      'issueOrRefresh'
    >,
    private readonly issuer: PasswordResetIssuer,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RequestPasswordResetCommand): Promise<void> {
    const email = Email.create(command.email)

    // Read ONCE — the same instant stamps issued_at and expires_at.
    const now = this.clock.now()

    const deliver = await this.#planDelivery(email, now)

    // One call for every branch — the control flow is what makes the responses
    // indistinguishable.
    await deliver()
  }

  async #planDelivery(email: Email, now: Date): Promise<DeliverPasswordReset> {
    const user = await this.usersRepository.findByEmail(email)
    if (user === null) return NO_DELIVERY

    // The STORED address, not the request's: the lookup matched through
    // Postgres `lower()` while `Email.create` folds with JavaScript's
    // `toLowerCase()`, and the two can disagree on exotic codepoints.
    const { tokenHash, deliver } = this.issuer.issue(user.email)

    const wrote = await this.passwordResetTokens.issueOrRefresh({
      id: this.idGenerator.generate(),
      userId: user.id,
      tokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * MILLISECONDS_PER_SECOND),
      cooldownCutoff: new Date(now.getTime() - this.resendCooldownMs),
    })

    // wrote === false: inside the cooldown. The minted token is discarded —
    // random bytes plus a digest, noise — the same way `confirm` discards its
    // decoy hash on a no-match.
    return wrote ? deliver : NO_DELIVERY
  }
}
