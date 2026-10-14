import { accountDeletedEmail } from '#modules/auth/emails/messages'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { SessionDevice } from '#modules/auth/services/refresh-token-issuer'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. `userId` comes from the verified token, never the body. */
export interface DeleteAccountCommand {
  userId: string
  /**
   * Absent for a federated-only account, which has no password to confirm.
   * `| undefined` spelled out for `exactOptionalPropertyTypes`, like
   * `SignInWithGoogleCommand`.
   */
  password?: string | undefined
  /** Resolved at the edge by `buildDeviceContext`; the trail records where this came from. */
  device: SessionDevice
}

/**
 * Deletes the caller's own account, for good.
 *
 * The row in `users` goes, and the `onDelete: 'cascade'` foreign keys take
 * `refresh_tokens`, `federated_identities` and `password_reset_tokens` with it
 * — which is what ends every session without a revocation step of its own.
 *
 * Two things the cascade cannot reach happen explicitly, inside the same
 * transaction. `pending_registrations` is keyed by email and has no foreign
 * key, and a surviving live code there would confirm a BRAND NEW account for
 * the address. The notice has no foreign key either, and that is what lets it
 * outlive the account it describes.
 *
 * The id always comes from the verified access token — the endpoint reads it
 * with `getPrincipal`. Taking it from the body would let any authenticated
 * caller delete anyone.
 */
export class DeleteAccountUseCase {
  constructor(
    /** Reads only: the `Pick` makes a delete outside the uow a compile error. */
    private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: DeleteAccountCommand): Promise<void> {
    const user = await this.usersRepository.findById(command.userId)

    // Reachable: the account was deleted while an unexpired access token was
    // still in the wild — including by a second call to this very use case.
    if (user === null) throw new UserNotFoundError()

    // Outside any transaction, where argon2 would hold a pooled connection. No
    // decoy on the federated branch, unlike `change-password.ts`: the caller
    // already proved, with the token, that the account is theirs, so no timing
    // here answers a question they cannot already answer.
    if (user.passwordHash !== null) {
      const confirmed =
        command.password !== undefined &&
        (await this.hashProvider.compare(command.password, user.passwordHash))

      if (!confirmed) throw new InvalidCurrentPasswordError()
    }

    // Read ONCE, and the address captured BEFORE the delete: after it, the
    // entity is the only place either still exists.
    const now = this.clock.now()
    const email = user.email

    await this.uow(async (repos) => {
      const { users, pendingRegistrations, outboxMessages, auditEvents } = repos

      // Before the delete, in the same transaction. The trail has no foreign key
      // to the account, so the cascade below does not reach it.
      await auditEvents.save(
        AuditEvent.create({
          id: this.idGenerator.generate(),
          type: AuditEventType.AccountDeleted,
          userId: user.id,
          device: command.device,
          now,
        }),
      )

      await users.deleteById(user.id)

      await pendingRegistrations.deleteAllByEmail(email)

      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: accountDeletedEmail(email),
          now,
        }),
      )
    })
  }
}
