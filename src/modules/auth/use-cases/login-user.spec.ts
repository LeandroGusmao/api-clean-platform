import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS } from '#modules/auth/config'
import { User } from '#modules/auth/entities/user'
import { EmailNotVerifiedError } from '#modules/auth/errors/email-not-verified-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { LoginUserUseCase } from '#modules/auth/use-cases/login-user'
import { Email } from '#modules/auth/value-objects/email'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'wr0ng-p4ssword!'
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const DUMMY_HASH = 'dummy-hash'
const ACCESS_TOKEN = 'signed.access.token'
/** Unused by this suite; required only to satisfy `ITokenGenerator`. */
const NUMERIC_CODE = '000000'
const NOW = new Date('2026-08-27T12:00:00.000Z')
const REFRESH_TTL_SECONDS = 60
const MILLISECONDS_PER_SECOND = 1000

const hashOf = (plain: string) => `hashed:${plain}`
const digestOf = (value: string) => `digest:${value}`

let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
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
  refreshTokensRepository = new InMemoryRefreshTokensRepository()

  // Counted rather than random, so every assertion below is deterministic.
  let generated = 0
  const nextValue = () => {
    generated += 1
    return generated
  }

  const issuer = new RefreshTokenIssuer(
    { opaque: () => `opaque-${nextValue()}`, numericCode: () => NUMERIC_CODE },
    { hash: digestOf },
    { generate: () => `id-${nextValue()}` },
    REFRESH_TTL_SECONDS,
    DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,
  )

  useCase = new LoginUserUseCase(
    usersRepository,
    hashProvider,
    tokenSigner,
    refreshTokensRepository,
    issuer,
    { now: () => NOW },
  )

  // Verified by default: most tests in this file are not about the gate, and
  // an unverified fixture would make every one of them fail on
  // `EmailNotVerifiedError` instead of on whatever they actually assert.
  await usersRepository.save(
    User.fromTrusted({
      id: USER_ID,
      email: Email.create(EMAIL),
      passwordHash: hashOf(PASSWORD),
      emailVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
})

/** Replaces the fixture with an otherwise-identical, unverified account. */
function makeAccountUnverified(): void {
  usersRepository.users[0] = User.fromTrusted({
    id: USER_ID,
    email: Email.create(EMAIL),
    passwordHash: hashOf(PASSWORD),
    emailVerifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('LoginUserUseCase', () => {
  it('returns an access token for valid credentials', async () => {
    const result = await useCase.execute({
      email: EMAIL,
      password: PASSWORD,
      device: DEVICE,
    })

    // Exact shape, not just the fields we care about: an extra key here would
    // mean something leaked into the response — the entity, or the digest.
    expect(result).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: expect.any(String),
    })
  })

  it('signs the token with the user id as the subject', async () => {
    const sign = vi.spyOn(tokenSigner, 'sign')

    await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })

    expect(sign).toHaveBeenCalledWith({ sub: USER_ID })
  })

  it('matches the email case-insensitively', async () => {
    const result = await useCase.execute({
      email: 'JOAO@EXAMPLE.COM',
      password: PASSWORD,
      device: DEVICE,
    })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
  })

  it('rejects a wrong password', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('rejects an unknown email with the very same error', async () => {
    // Same class, same code, same message: the two failures must be
    // indistinguishable from outside.
    await expect(
      useCase.execute({
        email: 'ninguem@example.com',
        password: PASSWORD,
        device: DEVICE,
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('compares against the decoy hash when no user exists', async () => {
    // The assertion that matters, and the one the tests above cannot make.
    // A future `if (user === null) throw` placed BEFORE the compare keeps every
    // other assertion in this file green while silently restoring the timing
    // oracle: same error, different response time.
    const compare = vi.spyOn(hashProvider, 'compare')

    await expect(
      useCase.execute({
        email: 'ninguem@example.com',
        password: PASSWORD,
        device: DEVICE,
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(compare).toHaveBeenCalledWith(PASSWORD, DUMMY_HASH)
  })

  it('issues no token when authentication fails', async () => {
    const sign = vi.spyOn(tokenSigner, 'sign')

    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(sign).not.toHaveBeenCalled()
  })

  it('issues a refresh token alongside the access token', async () => {
    const result = await useCase.execute({
      email: EMAIL,
      password: PASSWORD,
      device: DEVICE,
    })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken.length).toBeGreaterThan(0)
  })

  it('persists the DIGEST of the refresh token, never the token itself', async () => {
    // The single most important assertion in this file. A stored plaintext
    // token is a stored password.
    const { refreshToken } = await useCase.execute({
      email: EMAIL,
      password: PASSWORD,
      device: DEVICE,
    })

    const [stored] = refreshTokensRepository.tokens

    expect(stored?.tokenHash).toBe(digestOf(refreshToken))
    expect(stored?.tokenHash).not.toBe(refreshToken)
  })

  it('records the device context of the request that logged in', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })

    const [stored] = refreshTokensRepository.tokens

    expect(stored?.ip).toBe(DEVICE.ip)
    expect(stored?.deviceLabel).toBe(DEVICE.label)
    // The family is being born, so this login IS the start of the session.
    expect(stored?.sessionStartedAt).toEqual(NOW)
  })

  it('starts a NEW family on every login', async () => {
    // One chain per device. Sharing a family would make logging out on the
    // phone log the tablet out too.
    await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })
    await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })

    const [first, second] = refreshTokensRepository.tokens

    expect(first?.familyId).not.toBe(second?.familyId)
  })

  it('takes expiresAt from the injected clock, not from the wall clock', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })

    const [stored] = refreshTokensRepository.tokens

    expect(stored?.expiresAt).toEqual(
      new Date(NOW.getTime() + REFRESH_TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('stores no refresh token when the credentials are wrong', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(refreshTokensRepository.tokens).toHaveLength(0)
  })

  it('refuses an unverified account with EmailNotVerifiedError', async () => {
    makeAccountUnverified()

    await expect(
      useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(EmailNotVerifiedError)
  })

  // THE test of this task. Deleting the gate breaks the test above; moving it
  // ABOVE the credential check breaks only this one — and moving it up is
  // exactly the "simplification" a future reader will be tempted by, because
  // it reads as tidier while quietly reopening the enumeration hole the decoy
  // hash exists to close.
  it('reports bad credentials, not the gate, when the password is wrong on an unverified account', async () => {
    makeAccountUnverified()

    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('issues a session for a verified account', async () => {
    const result = await useCase.execute({
      email: EMAIL,
      password: PASSWORD,
      device: DEVICE,
    })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
  })

  it('rejects a federated-only account (null hash) as invalid credentials, via the decoy', async () => {
    // A federated account has no password. The `?? dummyHash` on the compare
    // funnels it here, so any password fails as `InvalidCredentialsError` — no
    // separate branch, no oracle.
    usersRepository.users[0] = User.fromTrusted({
      id: USER_ID,
      email: Email.create(EMAIL),
      passwordHash: null,
      emailVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })
})
