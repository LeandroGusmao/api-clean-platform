import { beforeEach, describe, expect, it } from 'vitest'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import { RegisterUserUseCase } from '#modules/auth/use-cases/register-user'
import type { IClock } from '#shared/providers/clock'
import type { IIdGenerator } from '#shared/providers/id-generator'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const NOW = new Date('2026-08-26T12:00:00.000Z')
const HASH_PREFIX = 'hashed:'

const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const PASSWORD = 'sup3r-s3cr3t!'
const INVALID_EMAIL = 'not-an-email'
const WEAK_PASSWORD = 'abcdefghij'

const USER_MISSING_MESSAGE = 'the repository stored no user'

// One-method ports do not deserve their own file: an object literal here keeps
// the double next to the assertions it serves, and out of `dist/`.
const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => ID }

let hashedPlaintexts: string[]

// Records rather than just returning, so a test can assert that hashing did
// NOT happen. A literal that only returns cannot prove absence.
const hashProvider: IHashProvider = {
  hash: (plain) => {
    hashedPlaintexts.push(plain)
    return Promise.resolve(`${HASH_PREFIX}${plain}`)
  },
}

let usersRepository: InMemoryUsersRepository
let useCase: RegisterUserUseCase

beforeEach(() => {
  hashedPlaintexts = []
  usersRepository = new InMemoryUsersRepository()
  useCase = new RegisterUserUseCase(usersRepository, hashProvider, clock, idGenerator)
})

function storedUser() {
  const [user] = usersRepository.users
  if (user === undefined) throw new Error(USER_MISSING_MESSAGE)
  return user
}

describe('RegisterUserUseCase', () => {
  it('persists the user and returns its id', async () => {
    const result = await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(result).toEqual({ id: ID })
    expect(usersRepository.users).toHaveLength(1)
  })

  it('normalizes the email before storing it', async () => {
    await useCase.execute({ email: MIXED_CASE_EMAIL, password: PASSWORD })

    // Normalization is what makes the stored value match the functional unique
    // index on `lower(email)`.
    expect(storedUser().email.value).toBe(EMAIL)
  })

  it('stores the hash, never the plaintext', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })
    const user = storedUser()

    // R7: nothing in the pure layer produces these on its own.
    expect(user.id).toBe(ID)
    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })

  it('propagates the conflict when the email is taken', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    await expect(
      useCase.execute({ email: MIXED_CASE_EMAIL, password: PASSWORD }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)
  })

  it('rejects an invalid email before hashing anything', async () => {
    await expect(
      useCase.execute({ email: INVALID_EMAIL, password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidEmailError)

    // The reason the value objects run first: argon2 costs ~100ms, and an
    // invalid payload must not pay it. Without this assertion, reordering the
    // use case to hash first would keep every test in this file green.
    expect(hashedPlaintexts).toHaveLength(0)
    expect(usersRepository.users).toHaveLength(0)
  })

  it('rejects a password that breaks the policy before hashing anything', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WEAK_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidPasswordError)

    expect(hashedPlaintexts).toHaveLength(0)
    expect(usersRepository.users).toHaveLength(0)
  })
})
