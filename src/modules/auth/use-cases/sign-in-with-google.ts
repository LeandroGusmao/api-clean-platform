import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { User } from '#modules/auth/entities/user'
import { GoogleLinkRequiresPasswordError } from '#modules/auth/errors/google-link-requires-password-error'
import { GoogleSignInConflictError } from '#modules/auth/errors/google-sign-in-conflict-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import { googleAccountLinkedEmail } from '#modules/auth/notifications/emails'
import type { IGoogleIdentityVerifier } from '#modules/auth/ports/google-identity-verifier'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. */
export interface SignInWithGoogleCommand {
  idToken: string
  /** Present only when linking over an existing password account. */
  password?: string
}

export interface SignInWithGoogleResult {
  accessToken: string
  refreshToken: string
}

/**
 * Verifies a Google ID token and hands back the project's own session, creating
 * or linking a local account.
 *
 * Five branches (design §5): an already-linked subject fast-paths with a single
 * write and no transaction, like `login`; a new email creates a verified
 * passwordless account, clears any pending registrations for the address, links,
 * and issues — all in one `uow`; an email that already has a PASSWORD account is
 * refused until the password proves ownership, and only then linked; a
 * federated-only account whose subject does not match is a conflict.
 *
 * argon2 runs only on the link path, and OUTSIDE the transaction (§8 of the unit
 * of work design). No decoy hash on the other branches: unlike `confirm`, the
 * outcomes here are public by design — the caller knows whether it sent a
 * password — so there is no timing signal to mask.
 */
export class SignInWithGoogleUseCase {
  constructor(
    private readonly googleVerifier: IGoogleIdentityVerifier,
    private readonly usersRepository: Pick<IUsersRepository, 'findById' | 'findByEmail'>,
    private readonly federatedIdentities: Pick<
      IFederatedIdentitiesRepository,
      'findByProviderUserId'
    >,
    private readonly refreshTokensRepository: Pick<IRefreshTokensRepository, 'save'>,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly hashProvider: IHashProvider,
    private readonly idGenerator: IIdGenerator,
    private readonly clock: IClock,
    private readonly emailSender: IEmailSender,
  ) {}

  async execute(command: SignInWithGoogleCommand): Promise<SignInWithGoogleResult> {
    const identity = await this.googleVerifier.verify(command.idToken)
    const email = Email.create(identity.email)
    // Read ONCE (R7): stamps the user, its verification, the link row and the
    // first refresh token — columns a transaction makes atomic on the new-email
    // branch.
    const now = this.clock.now()

    const linked = await this.federatedIdentities.findByProviderUserId(
      GOOGLE_PROVIDER,
      identity.subject,
    )
    if (linked !== null) {
      // Fast path: one write, no transaction, exactly like `login`.
      const user = await this.usersRepository.findById(linked.userId)
      if (user === null) throw new GoogleSignInConflictError()
      return this.#issueSession(user.id, now)
    }

    const existing = await this.usersRepository.findByEmail(email)

    if (existing === null) {
      return this.#createAccountAndLink(email, identity.subject, now)
    }

    if (existing.passwordHash === null) {
      // A federated-only account for this address whose subject did not match
      // above: recreated Google account, or a second subject for one address.
      // No password to require, no safe merge.
      throw new GoogleSignInConflictError()
    }

    // The email has a PASSWORD account: no silent merge (design §5, §6 item 3).
    if (command.password === undefined) throw new GoogleLinkRequiresPasswordError()

    // argon2, outside any transaction.
    const matches = await this.hashProvider.compare(
      command.password,
      existing.passwordHash,
    )
    if (!matches) throw new InvalidCredentialsError()

    const link = FederatedIdentity.create({
      id: this.idGenerator.generate(),
      userId: existing.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: identity.subject,
      emailAtLink: email,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      existing.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ federatedIdentities, refreshTokens }) => {
      await federatedIdentities.save(link)
      await refreshTokens.save(issued.entity)
    })

    // After the commit, best-effort: the link is already made and a failed send
    // must not undo it (the composition root hands this a best-effort sender).
    await this.emailSender.send(googleAccountLinkedEmail(existing.email))

    return {
      accessToken: await this.tokenSigner.sign({ sub: existing.id }),
      refreshToken: issued.token,
    }
  }

  async #createAccountAndLink(
    email: Email,
    subject: string,
    now: Date,
  ): Promise<SignInWithGoogleResult> {
    const user = User.createFederated({ id: this.idGenerator.generate(), email, now })
    const link = FederatedIdentity.create({
      id: this.idGenerator.generate(),
      userId: user.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: subject,
      emailAtLink: email,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(
      async ({ users, pendingRegistrations, federatedIdentities, refreshTokens }) => {
        // A concurrent confirm/google that won the unique index on `email`
        // surfaces here as EmailAlreadyInUseError, leaves the uow (rollback),
        // and maps to 409 EMAIL_ALREADY_IN_USE. No remap: Google proved the
        // email, so the specific 409 leaks nothing new.
        await users.save(user)
        await pendingRegistrations.deleteAllByEmail(email)
        await federatedIdentities.save(link)
        await refreshTokens.save(issued.entity)
      },
    )

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }

  async #issueSession(userId: string, now: Date): Promise<SignInWithGoogleResult> {
    const issued = this.refreshTokenIssuer.issue(
      userId,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )
    await this.refreshTokensRepository.save(issued.entity)

    return {
      accessToken: await this.tokenSigner.sign({ sub: userId }),
      refreshToken: issued.token,
    }
  }
}
