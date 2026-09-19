import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { User } from '#modules/auth/entities/user'
import { GoogleLinkRequiresPasswordError } from '#modules/auth/errors/google-link-requires-password-error'
import { GoogleSignInConflictError } from '#modules/auth/errors/google-sign-in-conflict-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import { InMemoryFederatedIdentitiesRepository } from '#modules/auth/infra/in-memory/in-memory-federated-identities-repository'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { googleAccountLinkedEmail } from '#modules/auth/notifications/emails'
import type {
  GoogleIdentity,
  IGoogleIdentityVerifier,
} from '#modules/auth/ports/google-identity-verifier'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { SignInWithGoogleUseCase } from '#modules/auth/use-cases/sign-in-with-google'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const EMAIL = 'ana@example.com'
const SUBJECT = 'google-subject-1234567890'
const ID_TOKEN = 'the.raw.id-token'
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const
const OTHER_DEVICE_IP = '198.51.100.42'
const OTHER_DEVICE_LABEL = 'Firefox on Windows'
const APP_PASSWORD = 'sup3r-s3cr3t!'
const STORED_HASH = 'hashed:sup3r-s3cr3t!'
const DUMMY_HASH = 'hashed:dummy'
const NOW = new Date('2026-09-08T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const ACCESS_TOKEN = 'signed.access.token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
const REFRESH_TTL_SECONDS = 5_184_000

const VERIFY = 'verify'
const COMPARE = 'compare'
const UOW = 'uow'
const COMMIT = 'commit'
const SAVE_OUTBOX = 'saveOutbox'

const DIGEST_PREFIX = 'digest:'
const NUMERIC_CODE = '000000'

let callLog: string[]
let identity: GoogleIdentity
let verifyResult: () => Promise<GoogleIdentity>
let compareResult: boolean
let outboxMessagesRepository: InMemoryOutboxMessagesRepository
let usersRepository: InMemoryUsersRepository
let federatedIdentitiesRepository: InMemoryFederatedIdentitiesRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let deleteAllByEmailSpy: Mock<(email: Email) => Promise<void>>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let useCase: SignInWithGoogleUseCase

const verifier: IGoogleIdentityVerifier = { verify: () => verifyResult() }

const hashProvider: IHashProvider = {
  hash: async () => STORED_HASH,
  compare: async () => {
    callLog.push(COMPARE)
    return compareResult
  },
  dummyHash: DUMMY_HASH,
}

const tokenSigner: ITokenSigner = {
  sign: async () => ACCESS_TOKEN,
  verify: async () => ({ sub: USER_ID }),
}

// Counted rather than random, so ids stay distinct and deterministic.
let generated: number
const idGenerator = {
  generate: () => {
    generated += 1
    return `id-${generated}`
  },
}
const clock = { now: () => NOW }

const refreshTokenIssuer = new RefreshTokenIssuer(
  { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
  { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
  idGenerator,
  REFRESH_TTL_SECONDS,
)

const trackedOutboxMessages = (): IOutboxMessagesRepository => ({
  save: (message) => {
    callLog.push(SAVE_OUTBOX)
    return outboxMessagesRepository.save(message)
  },
  findPendingBatch: (limit) => outboxMessagesRepository.findPendingBatch(limit),
  markDispatched: (id, at) => outboxMessagesRepository.markDispatched(id, at),
  recordFailure: (id, at, error, maxAttempts) =>
    outboxMessagesRepository.recordFailure(id, at, error, maxAttempts),
  deleteDispatchedOrFailedBefore: (cutoff) =>
    outboxMessagesRepository.deleteDispatchedOrFailedBefore(cutoff),
})

const storePasswordUser = () =>
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: STORED_HASH,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

const storeFederatedUser = () =>
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

const linkFor = (userId: string) =>
  FederatedIdentity.create({
    id: 'existing-link',
    userId,
    provider: GOOGLE_PROVIDER,
    providerUserId: SUBJECT,
    emailAtLink: Email.fromTrusted(EMAIL),
    now: CREATED_AT,
  })

const existingSessionFor = (userId: string) =>
  RefreshToken.create({
    id: 'existing-session',
    userId,
    tokenHash: 'digest:some-other-device-token',
    familyId: 'existing-family',
    now: CREATED_AT,
    ttlSeconds: REFRESH_TTL_SECONDS,
    ip: OTHER_DEVICE_IP,
    deviceLabel: OTHER_DEVICE_LABEL,
    sessionStartedAt: CREATED_AT,
  })

beforeEach(() => {
  callLog = []
  outboxMessagesRepository = new InMemoryOutboxMessagesRepository()
  generated = 0
  identity = { subject: SUBJECT, email: EMAIL }
  verifyResult = async () => {
    callLog.push(VERIFY)
    return identity
  }
  compareResult = true
  usersRepository = new InMemoryUsersRepository()
  federatedIdentitiesRepository = new InMemoryFederatedIdentitiesRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()
  deleteAllByEmailSpy = vi.fn(async () => {})

  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW)
    const repos: AuthRepos = {
      ...noopAuthRepos(),
      users: usersRepository,
      refreshTokens: refreshTokensRepository,
      federatedIdentities: federatedIdentitiesRepository,
      outboxMessages: trackedOutboxMessages(),
      pendingRegistrations: {
        ...noopAuthRepos().pendingRegistrations,
        deleteAllByEmail: deleteAllByEmailSpy,
      },
    }
    const result = await work(repos)
    callLog.push(COMMIT)
    return result
  })

  useCase = new SignInWithGoogleUseCase(
    verifier,
    usersRepository,
    federatedIdentitiesRepository,
    refreshTokensRepository,
    // Cast: `IAuthUnitOfWork` is generic in the callback's return type and
    // `vi.fn` cannot produce a generic function. The spy's own signature is
    // checked at its declaration; only the generic instantiation is waived.
    uowSpy as unknown as IAuthUnitOfWork,
    refreshTokenIssuer,
    tokenSigner,
    hashProvider,
    idGenerator,
    clock,
  )
})

describe('SignInWithGoogleUseCase — already linked (fast path)', () => {
  it('loads the user, issues a session, and does NOT open a transaction', async () => {
    storePasswordUser()
    await federatedIdentitiesRepository.save(linkFor(USER_ID))

    const result = await useCase.execute({ idToken: ID_TOKEN, device: DEVICE })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
    expect(refreshTokensRepository.tokens).toHaveLength(1)
    expect(callLog).toEqual([VERIFY])
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('records the device context on the session it opens', async () => {
    storePasswordUser()
    await federatedIdentitiesRepository.save(linkFor(USER_ID))

    await useCase.execute({ idToken: ID_TOKEN, device: DEVICE })

    const [stored] = refreshTokensRepository.tokens
    expect(stored?.ip).toBe(DEVICE.ip)
    expect(stored?.deviceLabel).toBe(DEVICE.label)
    expect(stored?.sessionStartedAt).toEqual(NOW)
  })
})

describe('SignInWithGoogleUseCase — new email', () => {
  it('creates a verified passwordless account, links it, clears pendings, issues a session — all in one uow', async () => {
    const result = await useCase.execute({ idToken: ID_TOKEN, device: DEVICE })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    const [created] = usersRepository.users
    expect(created?.passwordHash).toBeNull()
    expect(created?.emailVerifiedAt).toEqual(NOW)
    expect(federatedIdentitiesRepository.rows).toHaveLength(1)
    expect(federatedIdentitiesRepository.rows[0]?.userId).toBe(created?.id)
    expect(federatedIdentitiesRepository.rows[0]?.providerUserId).toBe(SUBJECT)
    expect(deleteAllByEmailSpy).toHaveBeenCalledOnce()
    expect(refreshTokensRepository.tokens).toHaveLength(1)
    expect(callLog).toEqual([VERIFY, UOW, COMMIT])
  })

  it('records the device context on the session it opens', async () => {
    await useCase.execute({ idToken: ID_TOKEN, device: DEVICE })

    const [stored] = refreshTokensRepository.tokens
    expect(stored?.ip).toBe(DEVICE.ip)
    expect(stored?.deviceLabel).toBe(DEVICE.label)
    expect(stored?.sessionStartedAt).toEqual(NOW)
  })

  it('reads the clock once — the user, its verification and the link share one instant', async () => {
    await useCase.execute({ idToken: ID_TOKEN, device: DEVICE })

    const [created] = usersRepository.users
    expect(created?.createdAt).toEqual(NOW)
    expect(federatedIdentitiesRepository.rows[0]?.createdAt).toEqual(NOW)
  })
})

describe('SignInWithGoogleUseCase — email has a password account', () => {
  it('refuses without a password, writing nothing', async () => {
    storePasswordUser()

    await expect(
      useCase.execute({ idToken: ID_TOKEN, device: DEVICE }),
    ).rejects.toBeInstanceOf(GoogleLinkRequiresPasswordError)
    expect(federatedIdentitiesRepository.rows).toHaveLength(0)
    expect(refreshTokensRepository.tokens).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects a wrong password after running argon2 OUTSIDE the uow, writing nothing', async () => {
    storePasswordUser()
    compareResult = false

    await expect(
      useCase.execute({ idToken: ID_TOKEN, password: 'wrong', device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
    expect(callLog).toEqual([VERIFY, COMPARE])
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('records the device context on the session it opens', async () => {
    storePasswordUser()

    await useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD, device: DEVICE })

    const [stored] = refreshTokensRepository.tokens
    expect(stored?.ip).toBe(DEVICE.ip)
    expect(stored?.deviceLabel).toBe(DEVICE.label)
    expect(stored?.sessionStartedAt).toEqual(NOW)
  })

  it('revokes every other session before issuing the fresh one', async () => {
    storePasswordUser()
    const stolenSession = existingSessionFor(USER_ID)
    await refreshTokensRepository.save(stolenSession)

    await useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD, device: DEVICE })

    const stored = refreshTokensRepository.tokens
    expect(stored.find((each) => each.id === stolenSession.id)?.revokedAt).toEqual(NOW)
    // The session this very call just issued must survive its own revocation.
    expect(stored.find((each) => each.id !== stolenSession.id)?.revokedAt).toBeNull()
  })

  it('links on the right password: identity + refresh token + outbox row in one uow, before the commit', async () => {
    storePasswordUser()

    const result = await useCase.execute({
      idToken: ID_TOKEN,
      password: APP_PASSWORD,
      device: DEVICE,
    })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
    expect(federatedIdentitiesRepository.rows).toHaveLength(1)
    expect(federatedIdentitiesRepository.rows[0]?.userId).toBe(USER_ID)
    expect(refreshTokensRepository.tokens).toHaveLength(1)
    expect(usersRepository.users).toHaveLength(1)
    expect(outboxMessagesRepository.messages.map((m) => m.toEmailMessage())).toEqual([
      googleAccountLinkedEmail(Email.fromTrusted(EMAIL)),
    ])
    expect(callLog).toEqual([VERIFY, COMPARE, UOW, SAVE_OUTBOX, COMMIT])
  })
})

describe('SignInWithGoogleUseCase — federated-only account with a mismatched subject', () => {
  it('fails with GoogleSignInConflictError, writing nothing', async () => {
    storeFederatedUser() // no federated_identities row for SUBJECT

    await expect(
      useCase.execute({ idToken: ID_TOKEN, device: DEVICE }),
    ).rejects.toBeInstanceOf(GoogleSignInConflictError)
    expect(federatedIdentitiesRepository.rows).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })
})

describe('SignInWithGoogleUseCase — bad identity', () => {
  it('propagates InvalidGoogleIdentityError and touches nothing', async () => {
    verifyResult = async () => {
      throw new InvalidGoogleIdentityError()
    }

    await expect(
      useCase.execute({ idToken: ID_TOKEN, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidGoogleIdentityError)
    expect(usersRepository.users).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })
})
