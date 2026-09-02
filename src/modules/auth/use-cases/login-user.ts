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
 * Does not check `emailVerifiedAt`: nothing can verify an email yet, so the
 * gate would lock every account out. It arrives with the verification path.
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
    const hashed = user?.passwordHash ?? this.hashProvider.dummyHash
    const matches = await this.hashProvider.compare(command.password, hashed)

    // One `throw`, not two branches: separate branches start identical and
    // drift apart at the first maintenance — one gains a log, the other a
    // message — and the oracle comes back.
    if (user === null || !matches) throw new InvalidCredentialsError()

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
