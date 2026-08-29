import { beforeEach, describe, expect, it, vi } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import type { ITokenSigner } from '#modules/auth/providers/token-signer'
import { LoginUserUseCase } from '#modules/auth/use-cases/login-user'
import { Email } from '#modules/auth/value-objects/email'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'wr0ng-p4ssword!'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const DUMMY_HASH = 'dummy-hash'
const ACCESS_TOKEN = 'signed.access.token'
const NOW = new Date('2026-08-27T12:00:00.000Z')

const hashOf = (plain: string) => `hashed:${plain}`

let usersRepository: InMemoryUsersRepository
let hashProvider: IHashProvider
let tokenSigner: ITokenSigner
let useCase: LoginUserUseCase

beforeEach(async () => {
  usersRepository = new InMemoryUsersRepository()
  hashProvider = {
    dummyHash: DUMMY_HASH,
    hash: async (plain) => hashOf(plain),
    compare: async (plain, hashed) => hashed === hashOf(plain),
  }
  tokenSigner = {
    sign: async () => ACCESS_TOKEN,
    verify: async () => ({ sub: USER_ID }),
  }
  useCase = new LoginUserUseCase(usersRepository, hashProvider, tokenSigner)

  await usersRepository.save(
    User.create({
      id: USER_ID,
      email: Email.create(EMAIL),
      passwordHash: hashOf(PASSWORD),
      now: NOW,
    }),
  )
})

describe('LoginUserUseCase', () => {
  it('returns an access token for valid credentials', async () => {
    const result = await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN })
  })

  it('signs the token with the user id as the subject', async () => {
    const sign = vi.spyOn(tokenSigner, 'sign')

    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(sign).toHaveBeenCalledWith({ sub: USER_ID })
  })

  it('matches the email case-insensitively', async () => {
    const result = await useCase.execute({
      email: 'JOAO@EXAMPLE.COM',
      password: PASSWORD,
    })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN })
  })

  it('rejects a wrong password', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('rejects an unknown email with the very same error', async () => {
    // Same class, same code, same message: the two failures must be
    // indistinguishable from outside.
    await expect(
      useCase.execute({ email: 'ninguem@example.com', password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('compares against the decoy hash when no user exists', async () => {
    // The assertion that matters, and the one the tests above cannot make.
    // A future `if (user === null) throw` placed BEFORE the compare keeps every
    // other assertion in this file green while silently restoring the timing
    // oracle: same error, different response time.
    const compare = vi.spyOn(hashProvider, 'compare')

    await expect(
      useCase.execute({ email: 'ninguem@example.com', password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(compare).toHaveBeenCalledWith(PASSWORD, DUMMY_HASH)
  })

  it('issues no token when authentication fails', async () => {
    const sign = vi.spyOn(tokenSigner, 'sign')

    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(sign).not.toHaveBeenCalled()
  })
})
