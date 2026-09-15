import { EmailNotVerifiedError } from '#modules/auth/errors/email-not-verified-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'

/** Raw, untrusted input. */
export interface LoginUserCommand {
  email: string
  password: string
}

export interface LoginUserResult {
  accessToken: string
  refreshToken: string
}

/**
 * Authenticates by email and password, issuing a short-lived access token and
 * the opaque refresh token that carries the session (decision 11).
 *
 * Takes the refresh repository DIRECTLY and not the unit of work, and that is
 * deliberate on both counts: it writes to one repository, so there is no
 * atomicity to protect — and it runs argon2, which §8 of the unit of work
 * design forbids inside a transaction, because a 100ms hash with the
 * transaction open is a pooled connection standing still.
 *
 * Also gates on `emailVerifiedAt`, but only AFTER the credential check below
 * has already passed. That order is the whole defence: the "unverified"
 * signal may only ever reach a caller who has already proved they know the
 * password. Checking it earlier — even though it would still read as a
 * simplification — would hand any anonymous caller an account oracle, the
 * very thing the decoy hash exists to deny them.
 */
export class LoginUserUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
    private readonly refreshTokensRepository: IRefreshTokensRepository,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly clock: IClock,
  ) {}

  async execute(command: LoginUserCommand): Promise<LoginUserResult> {
    const email = Email.create(command.email)
    const user = await this.usersRepository.findByEmail(email)

    // Always compares, decoy included, so a missing account and a wrong
    // password cost the same. Returning early here would let the response time
    // answer "does this account exist?".
    //
    // A federated-only account has `passwordHash === null`; `??` funnels it to
    // the decoy too, so it fails as `InvalidCredentialsError` like any other
    // wrong credential — no separate branch, no oracle.
    const hashed = user?.passwordHash ?? this.hashProvider.dummyHash
    const matches = await this.hashProvider.compare(command.password, hashed)

    // One `throw`, not two branches: separate branches start identical and
    // drift apart at the first maintenance — one gains a log, the other a
    // message — and the oracle comes back.
    if (user === null || !matches) throw new InvalidCredentialsError()

    // AFTER the credential check, never before: the "unverified" signal must
    // only ever reach someone who already proved they know the password.
    // Checking first would hand any anonymous caller an account oracle — the
    // very thing the decoy hash above exists to deny them.
    //
    // Every `users` row is born verified — the account is created at
    // confirmation (slice 11) or at the first Google sign-in (slice 14) — so
    // this branch has no producer. It stays as defence in depth for any
    // unverified path a later slice reintroduces, and needs the same column and
    // gate (§4.3 of the pre-hijacking design).
    if (user.emailVerifiedAt === null) throw new EmailNotVerifiedError()

    // A fresh family per login: each device owns its chain, so logging out on
    // the phone leaves the tablet signed in.
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      this.clock.now(),
    )

    await this.refreshTokensRepository.save(issued.entity)

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
