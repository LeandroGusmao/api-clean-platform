import { User } from '#modules/auth/entities/user'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { Email } from '#modules/auth/value-objects/email'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/providers/clock'
import type { IIdGenerator } from '#shared/providers/id-generator'

/** Raw, untrusted input. The value objects validate it. */
export interface RegisterUserCommand {
  email: string
  password: string
}

export interface RegisterUserResult {
  id: string
}

/**
 * Creates an account. Pure orchestration: the policy lives in `Email` and
 * `Password`, uniqueness in the database index behind `IUsersRepository`, and
 * hashing behind `IHashProvider`.
 *
 * Issues no session tokens — login is a separate use case. Sends no
 * verification code either: that belongs to a dedicated endpoint, which has to
 * exist anyway for "resend". Keeping it out is what lets this use case survive
 * the email verification slice untouched.
 *
 * The order matters. Both value objects run before the hash, so a bad payload
 * never pays argon2's cost. The hash then runs before the insert, because the
 * row needs it.
 */
export class RegisterUserUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    const passwordHash = await this.hashProvider.hash(password.value)

    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now: this.clock.now(),
    })

    await this.usersRepository.save(user)

    return { id: user.id }
  }
}
