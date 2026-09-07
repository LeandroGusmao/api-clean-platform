import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
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
     * `registerFailedAttempt` is a WRITE in this `Pick` on purpose, and §9
     * allows it because §8 line 3 puts it outside the transaction: a
     * brute-force counter inside one is erased by the rollback that always
     * follows on that path.
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

    // Before the transaction (§8) and unconditional: match and no-match must
    // cost the same argon2, or the timing itself answers "was that code valid?".
    const passwordHash = await this.hashProvider.hash(password.value)

    // Read ONCE. The same instant stamps the user, its `email_verified_at` and
    // the new refresh token's `created_at` — three columns across three tables
    // that one transaction makes atomic.
    const now = this.clock.now()

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const usable = pendings.filter((each) => each.isUsable(this.maxAttempts, now))
    const codeHash = this.tokenDigest.hash(command.code)
    const match = usable.find((each) => each.matches(codeHash))

    if (match === undefined) {
      // Unknown address, no usable pending, expired, exhausted, or wrong code:
      // all collapse into the same throw.
      const [mostRecentUsable] = usable
      if (mostRecentUsable !== undefined) {
        // Autocommit, outside the transaction (§8 line 3): this counter must
        // survive the throw below. Not branched on — a wrong guess reports the
        // same way whether or not it spent the last slot.
        await this.pendingRegistrations.registerFailedAttempt(
          mostRecentUsable.id,
          this.maxAttempts,
        )
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
    )

    await this.uow(async ({ users, pendingRegistrations, refreshTokens }) => {
      // `consume` is a conditional UPDATE — losing it means a concurrent confirm
      // already burned this code, so the throw must happen INSIDE the callback:
      // a `return` would leave state half-written.
      if (!(await pendingRegistrations.consume(match.id, now))) {
        throw new EmailVerificationFailedError()
      }

      try {
        await users.save(user)
      } catch (error) {
        // A concurrent confirm of a DIFFERENT pending for the same email won the
        // unique index. Generic error, no oracle; the rollback un-consumes this
        // pending (§5.1 of the slice 11 design).
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
