import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { PasswordUnchangedError } from '#modules/auth/errors/password-unchanged-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { passwordChangedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  RefreshTokenIssuer,
  SessionDevice,
} from '#modules/auth/services/refresh-token-issuer'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. `userId` comes from the verified token, never the body. */
export interface ChangePasswordCommand {
  userId: string
  currentPassword: string
  newPassword: string
  /** Resolved at the edge by `buildDeviceContext`. */
  device: SessionDevice
}

export interface ChangePasswordResult {
  accessToken: string
  refreshToken: string
}

/**
 * Changes a user's own password, ends every session, and hands the current
 * device a fresh pair.
 *
 * **It takes the unit of work AND a repository directly, which §9 of the unit
 * of work design used to forbid outright.** That rule now forbids a direct
 * WRITE, and the reason for the amendment is visible in the ordering below:
 * `compare` needs the stored hash, so the read must precede it — and argon2 may
 * not run inside a transaction (§8). No ordering satisfies both rules with a
 * single `uow`. Every write goes through `repos`, and the constructor's `Pick`
 * is what makes that a compile error rather than a convention.
 *
 * The order of the steps is normative, not stylistic. See the comments inline.
 */
export class ChangePasswordUseCase {
  constructor(
    /**
     * `Pick`, and that narrowing IS the rule: with the full interface,
     * `usersRepository.updatePasswordHash(...)` outside the transaction would
     * compile, and the amendment below would rest entirely on someone reading
     * this comment. Declaring only what is used makes the violation a compile
     * error — the same move as `RateLimitEnv` in `infra/http/rate-limit.ts`
     * (decision 23), and the same reasoning that chose `updatePasswordHash`
     * over a broad `update(user)`.
     */
    private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    // First, so a bad payload pays neither a database read nor argon2 — the
    // same ordering `RegisterUserUseCase` documents.
    const newPassword = Password.create(command.newPassword)

    const user = await this.usersRepository.findById(command.userId)

    // Reachable: the account was deleted while an unexpired access token was
    // still in the wild. No enumeration concern — the caller owns the account.
    if (user === null) throw new UserNotFoundError()

    // A federated-only account has no current password to confirm. Run the
    // decoy so the timing matches a wrong-password attempt, then refuse.
    // "Set a first password" is a future slice.
    if (user.passwordHash === null) {
      await this.hashProvider.compare(
        command.currentPassword,
        this.hashProvider.dummyHash,
      )
      throw new InvalidCurrentPasswordError()
    }

    // Argon2 #1, outside any transaction.
    const matches = await this.hashProvider.compare(
      command.currentPassword,
      user.passwordHash,
    )
    if (!matches) throw new InvalidCurrentPasswordError()

    // Plaintext, and deliberately so: the body carries both secrets and the
    // current one was just confirmed correct, so this is exact. Running the new
    // password through `compare` against the stored hash would spend another
    // ~7ms of argon2 to answer the same question.
    //
    // After the check above, never before: a caller who mistyped the current
    // password deserves to hear that, not "it did not change".
    if (newPassword.value === command.currentPassword) throw new PasswordUnchangedError()

    // Argon2 #2, still outside.
    const passwordHash = await this.hashProvider.hash(newPassword.value)

    // Read ONCE. The same instant stamps `updated_at`, every `revoked_at`, and
    // the new token's `created_at`/`expires_at` — three columns across two
    // tables that a transaction makes atomic and three clock reads would not.
    const now = this.clock.now()

    // Cheap (random bytes plus a digest), so it could go either side; it stays
    // out because it only depends on what is already computed, and moving work
    // into a transaction without a reason is the same mistake in miniature.
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

    await this.uow(async ({ users, refreshTokens, outboxMessages }) => {
      await users.updatePasswordHash(user.id, passwordHash, now)

      // BEFORE the insert, always. `revokeAllForUser` revokes every row of this
      // user whose `revoked_at` is null — inserting first would let it catch
      // the token minted one line below, which would be born revoked. The
      // endpoint would answer 200 and the very next refresh would answer 401.
      await refreshTokens.revokeAllForUser(user.id, now)

      await refreshTokens.save(issued.entity)

      // The notice, in the SAME transaction as the state it describes: a
      // crash right after this still loses nothing (design §5).
      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: passwordChangedEmail(user.email),
          now,
        }),
      )
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
