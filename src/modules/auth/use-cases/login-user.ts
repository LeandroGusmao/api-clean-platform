import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import type { ITokenSigner } from '#modules/auth/providers/token-signer'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { Email } from '#modules/auth/value-objects/email'

/** Raw, untrusted input. */
export interface LoginUserCommand {
  email: string
  password: string
}

export interface LoginUserResult {
  accessToken: string
}

/**
 * Authenticates by email and password, issuing a short-lived access token.
 *
 * Issues no refresh token: that one is opaque, persisted and rotating, and it
 * arrives with the slice that can redeem it. Does not check `emailVerifiedAt`
 * either — nothing can verify an email yet, so the gate would lock every
 * account out. It arrives with the verification path that opens it.
 */
export class LoginUserUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
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

    return { accessToken: await this.tokenSigner.sign({ sub: user.id }) }
  }
}
