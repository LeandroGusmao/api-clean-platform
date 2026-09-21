import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { PasswordResetFailedError } from '#modules/auth/errors/password-reset-failed-error'
import { passwordResetCompletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { SessionDevice } from '#modules/auth/services/refresh-token-issuer'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface ResetPasswordCommand {
  token: string
  newPassword: string
  /** Resolved at the edge by `buildDeviceContext`; the trail records where this came from. */
  device: SessionDevice
}

/**
 * Redeems a reset token for a new password: replaces the hash, revokes every
 * session and burns the token — all in one transaction — and answers with
 * nothing. The caller is not authenticated, so it goes to login afterwards.
 *
 * **One error for every failure mode**, with the same message: unknown token,
 * expired, already consumed, and losing the race to consume. Branches that
 * reported differently would make this a token oracle for an anonymous caller.
 *
 * argon2 runs ONLY on the valid-token branch, unlike `confirm`. A timing
 * signal for "that token was valid" is worth something only to a caller who
 * can enumerate tokens, and nobody enumerates 256 bits — so paying argon2 on
 * every garbage token would buy nothing.
 *
 * The order of the steps is normative, not stylistic. See the comments inline.
 */
export class ResetPasswordUseCase {
  constructor(
    /**
     * `Pick`, and that narrowing IS the rule: with the full interface,
     * `usersRepository.updatePasswordHash(...)` outside the transaction would
     * compile. Declaring only the read that is used makes the violation a
     * compile error rather than a convention.
     */
    private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
    /** `consume` is deliberately absent: it comes from the `uow` repo bag. */
    private readonly passwordResetTokens: Pick<
      IPasswordResetTokensRepository,
      'findByHash'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<void> {
    // First, so a bad payload pays neither a lookup nor argon2 — and no token
    // is spent by a request that never had a usable password to set.
    const newPassword = Password.create(command.newPassword)

    // Read ONCE. The same instant decides usability and then stamps
    // `updated_at` and every `revoked_at`, across two tables one transaction
    // makes atomic.
    const now = this.clock.now()

    const tokenHash = this.tokenDigest.hash(command.token)
    const token = await this.passwordResetTokens.findByHash(tokenHash)

    // Unknown, expired or already consumed: one throw, and no argon2 above it.
    if (token === null || !token.isUsable(now)) throw new PasswordResetFailedError()

    // Reachable only in theory — the foreign key cascades, so a deleted user
    // takes its token row with it and the guard above would have thrown. Still
    // generic, never a new error type. The address is what the enqueue below needs.
    const user = await this.usersRepository.findById(token.userId)
    if (user === null) throw new PasswordResetFailedError()

    // argon2 outside the transaction, where it would hold a pooled connection,
    // and only on this branch.
    const passwordHash = await this.hashProvider.hash(newPassword.value)

    await this.uow(
      async ({
        users,
        refreshTokens,
        passwordResetTokens,
        outboxMessages,
        auditEvents,
      }) => {
        // First inside, always. `consume` is a conditional UPDATE, and losing it
        // means a concurrent reset already burned this token — so the throw has
        // to happen INSIDE the callback, where it aborts the transaction; a
        // `return` would leave the password written against a spent token.
        if (!(await passwordResetTokens.consume(token.id, now))) {
          throw new PasswordResetFailedError()
        }

        await users.updatePasswordHash(token.userId, passwordHash, now)
        await refreshTokens.revokeAllForUser(token.userId, now)

        // The notice, in the SAME transaction as the state it describes: a
        // crash right after this still loses nothing.
        await outboxMessages.save(
          OutboxMessage.create({
            id: this.idGenerator.generate(),
            message: passwordResetCompletedEmail(user.email),
            now,
          }),
        )

        await auditEvents.save(
          AuditEvent.create({
            id: this.idGenerator.generate(),
            type: AuditEventType.PasswordResetCompleted,
            userId: token.userId,
            device: command.device,
            now,
          }),
        )
      },
    )
  }
}
