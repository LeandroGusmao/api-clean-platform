import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type {
  RefreshTokenIssuer,
  SessionDevice,
} from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface ConfirmEmailCommand {
  email: string
  code: string
  password: string
  /** Resolved at the edge by `buildDeviceContext`. */
  device: SessionDevice
}

export interface ConfirmEmailResult {
  accessToken: string
  refreshToken: string
}

/**
 * Redeems a six-digit code for an address together with a chosen password,
 * creates the verified account with THAT password, and opens a session — so
 * confirming does not cost a second round trip and a second password prompt.
 *
 * **One error for every failure mode**, with the same message: no usable
 * pending, expired, attempts exhausted, wrong code, and losing the race to
 * consume the code or to insert the user. Branches that reported differently
 * would make this an account-and-code oracle for an anonymous caller.
 *
 * The password is hashed BEFORE the code is checked, and unconditionally: if
 * argon2 only ran on a match, the response time would tell an attacker "that
 * code was valid for some pending" — the same reason `login-user.ts` compares a
 * decoy hash. The hash is discarded on a no-match.
 */
export class ConfirmEmailUseCase {
  constructor(
    /**
     * `registerFailedAttempt` is a WRITE in this `Pick` on purpose: a
     * brute-force counter has to live outside the transaction, because inside
     * one it is erased by the rollback that always follows on that path.
     */
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'registerFailedAttempt'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly maxAttempts: number,
  ) {}

  async execute(command: ConfirmEmailCommand): Promise<ConfirmEmailResult> {
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    // Before the transaction, where argon2 would hold a pooled connection, and
    // unconditional: match and no-match must cost the same argon2, or the
    // timing itself answers "was that code valid?".
    const passwordHash = await this.hashProvider.hash(password.value)

    // Read ONCE. The same instant stamps the user, its `email_verified_at` and
    // the new refresh token's `created_at` — three columns across three tables
    // that one transaction makes atomic.
    const now = this.clock.now()

    // Only the most recent pending is redeemable, and an older one does NOT
    // step in when it is exhausted. Testing a guess against every live code
    // while charging it to one would multiply the five-guess cap by the number
    // of codes an anonymous caller can mint — one per resend cooldown, for the
    // whole TTL.
    const [mostRecent] = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const target = mostRecent?.isUsable(this.maxAttempts, now) ? mostRecent : undefined
    const codeHash = this.tokenDigest.hash(command.code)

    if (!target?.matches(codeHash)) {
      // Unknown address, no usable pending, expired, exhausted, or wrong code:
      // all collapse into the same throw.
      if (target !== undefined) {
        // Autocommit, outside the transaction: this counter must
        // survive the throw below. Not branched on — a wrong guess reports the
        // same way whether or not it spent the last slot.
        await this.pendingRegistrations.registerFailedAttempt(target.id, this.maxAttempts)
      }
      throw new EmailVerificationFailedError()
    }

    // Before the transaction: only depends on what is already known.
    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
      {
        ip: command.device.ip,
        deviceLabel: command.device.label,
        // The family is being born, so this IS the start.
        sessionStartedAt: now,
      },
    )

    await this.uow(async ({ users, pendingRegistrations, refreshTokens }) => {
      // `consume` is a conditional UPDATE — losing it means a concurrent confirm
      // already burned this code, so the throw must happen INSIDE the callback:
      // a `return` would leave state half-written.
      if (!(await pendingRegistrations.consume(target.id, now))) {
        throw new EmailVerificationFailedError()
      }

      try {
        await users.save(user)
      } catch (error) {
        // A concurrent confirm of a DIFFERENT pending for the same email won the
        // unique index. Generic error, no oracle; the rollback un-consumes this
        // pending.
        if (error instanceof EmailAlreadyInUseError) {
          throw new EmailVerificationFailedError()
        }
        throw error
      }

      // Inside, so "verified" and "logged in" are one atom.
      await refreshTokens.save(issued.entity)
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
