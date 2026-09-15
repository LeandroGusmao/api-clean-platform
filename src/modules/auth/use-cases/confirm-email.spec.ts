import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { User } from '#modules/auth/entities/user'
import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { InMemoryPendingRegistrationsRepository } from '#modules/auth/infra/in-memory/in-memory-pending-registrations-repository'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import {
  type ConfirmEmailCommand,
  ConfirmEmailUseCase,
} from '#modules/auth/use-cases/confirm-email'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

const GENERATED_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const PENDING_ID = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091'
const OLD_PENDING_ID = '11111111-1111-4111-8111-111111111111'
const NEW_PENDING_ID = '22222222-2222-4222-8222-222222222222'
const EMAIL = 'joao@example.com'

const CODE = '123456'
const OTHER_CODE = '111111'
const WRONG_CODE = '654321'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const HASH_PREFIX = 'hashed:'
const DIGEST_PREFIX = 'digest:'

const PASSWORD = 'sup3r-s3cr3t!'
const WEAK_PASSWORD = 'abcdefghij'

const MILLISECONDS_PER_SECOND = 1000
const VERIFICATION_TTL_SECONDS = 900
const MAX_ATTEMPTS = 5
const NO_ATTEMPTS_SPENT = 0
const FRESH_AGE_MS = 0
const OLDER_AGE_MS = 120_000
const EXPIRED_AGE_MS = VERIFICATION_TTL_SECONDS * MILLISECONDS_PER_SECOND

const ACCESS_TOKEN = 'signed-access-token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
const NUMERIC_CODE = '000000'
const REFRESH_TOKEN_TTL_SECONDS = 3600

/**
 * The wire contract of the single error, spelled out rather than imported:
 * importing the constants would make the assertion tautological — it would pass
 * whatever the error file happened to say, including a message that named which
 * branch failed.
 */
const FAILURE_MESSAGE = 'Email verification failed'
const FAILURE_CODE = 'EMAIL_VERIFICATION_FAILED'

const NO_FAILURE_MESSAGE = 'expected the confirmation to fail, and it resolved'
const USER_MISSING_MESSAGE = 'the repository stored no user'

/** Records the order in which collaborators were touched. */
const CONSUME_CALL = 'pendingRegistrations.consume'
const USERS_SAVE_CALL = 'users.save'
const SAVE_TOKEN_CALL = 'refreshTokens.save'
const REGISTER_FAILED_ATTEMPT_CALL = 'pendingRegistrations.registerFailedAttempt'
const COMMIT = 'COMMIT'

const WON_RACE = true
const LOST_RACE = false

const digest: ITokenDigest = { hash: (value) => `${DIGEST_PREFIX}${value}` }
const clock: IClock = { now: () => NOW }

let callLog: string[]
let consumeOutcome: boolean
let hashedPlaintexts: string[]
let usersRepository: InMemoryUsersRepository
let pendingRepo: InMemoryPendingRegistrationsRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let useCase: ConfirmEmailUseCase
let registerFailedAttemptSpy: Mock<
  IPendingRegistrationsRepository['registerFailedAttempt']
>
let signSpy: Mock<ITokenSigner['sign']>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>

const hashProvider: IHashProvider = {
  hash: (plain) => {
    hashedPlaintexts.push(plain)
    return Promise.resolve(`${HASH_PREFIX}${plain}`)
  },
  compare: () => Promise.resolve(false),
  dummyHash: 'unused-by-confirm-tests',
}

/**
 * The repositories as the transaction hands them out, wrapping the SAME
 * in-memory instances — one database, two handles. Only the writes the flow
 * makes inside the transaction are logged; everything else is passthrough.
 */
function trackedRepos(): AuthRepos {
  return {
    ...noopAuthRepos(),
    users: {
      save: async (user) => {
        await usersRepository.save(user)
        // Logged AFTER the delegate: a save that throws is the collision path,
        // and logging it there would make the collision log indistinguishable
        // from the success log.
        callLog.push(USERS_SAVE_CALL)
      },
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) =>
        usersRepository.updatePasswordHash(id, passwordHash, updatedAt),
    },
    refreshTokens: {
      save: (token) => {
        callLog.push(SAVE_TOKEN_CALL)
        return refreshTokensRepository.save(token)
      },
      findByHashForUpdate: (hash) => refreshTokensRepository.findByHashForUpdate(hash),
      markRotated: (id, replacedBy, revokedAt) =>
        refreshTokensRepository.markRotated(id, replacedBy, revokedAt),
      revoke: (id, revokedAt) => refreshTokensRepository.revoke(id, revokedAt),
      revokeFamily: (familyId, revokedAt) =>
        refreshTokensRepository.revokeFamily(familyId, revokedAt),
      revokeAllForUser: (userId, revokedAt) =>
        refreshTokensRepository.revokeAllForUser(userId, revokedAt),
      deleteExpiredBefore: (cutoff) =>
        refreshTokensRepository.deleteExpiredBefore(cutoff),
    },
    pendingRegistrations: {
      save: (pending) => pendingRepo.save(pending),
      findUnconsumedByEmail: (email) => pendingRepo.findUnconsumedByEmail(email),
      reissueCode: (id, codeHash, codeIssuedAt, expiresAt) =>
        pendingRepo.reissueCode(id, codeHash, codeIssuedAt, expiresAt),
      registerFailedAttempt: (id, maxAttempts) =>
        pendingRepo.registerFailedAttempt(id, maxAttempts),
      consume: async (id, at) => {
        callLog.push(CONSUME_CALL)
        if (consumeOutcome === LOST_RACE) return LOST_RACE

        return pendingRepo.consume(id, at)
      },
      deleteExpiredByEmail: (email, at) => pendingRepo.deleteExpiredByEmail(email, at),
      deleteAllByEmail: (email) => pendingRepo.deleteAllByEmail(email),
      deleteExpiredBefore: (cutoff) => pendingRepo.deleteExpiredBefore(cutoff),
    },
  }
}

function buildUseCase(): ConfirmEmailUseCase {
  return new ConfirmEmailUseCase(
    {
      findUnconsumedByEmail: (email) => pendingRepo.findUnconsumedByEmail(email),
      registerFailedAttempt: registerFailedAttemptSpy,
    },
    uowSpy as unknown as IAuthUnitOfWork,
    new RefreshTokenIssuer(
      { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
      digest,
      { generate: () => GENERATED_ID },
      REFRESH_TOKEN_TTL_SECONDS,
    ),
    { sign: signSpy, verify: async () => ({ sub: GENERATED_ID }) },
    digest,
    hashProvider,
    clock,
    { generate: () => GENERATED_ID },
    MAX_ATTEMPTS,
  )
}

beforeEach(() => {
  callLog = []
  consumeOutcome = WON_RACE
  hashedPlaintexts = []
  usersRepository = new InMemoryUsersRepository()
  pendingRepo = new InMemoryPendingRegistrationsRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()

  registerFailedAttemptSpy = vi.fn(async (id, maxAttempts) => {
    callLog.push(REGISTER_FAILED_ATTEMPT_CALL)
    return pendingRepo.registerFailedAttempt(id, maxAttempts)
  })

  // Records the payload: on an endpoint that MINTS a session, "which subject
  // did we sign for" is exactly what turns a wiring slip into an auth bug.
  signSpy = vi.fn(async () => ACCESS_TOKEN)

  const repos = trackedRepos()
  uowSpy = vi.fn(async (work) => {
    const result = await work(repos)
    callLog.push(COMMIT)

    return result
  })

  useCase = buildUseCase()
})

function storeUsablePending({
  id = PENDING_ID,
  ageMs = FRESH_AGE_MS,
  codeHash = `${DIGEST_PREFIX}${CODE}`,
  attempts = NO_ATTEMPTS_SPENT,
}: {
  id?: string
  ageMs?: number
  codeHash?: string
  attempts?: number
} = {}): void {
  const issuedAt = new Date(NOW.getTime() - ageMs)
  pendingRepo.rows.push(
    PendingRegistration.fromTrusted({
      id,
      email: Email.fromTrusted(EMAIL),
      codeHash,
      attempts,
      codeIssuedAt: issuedAt,
      expiresAt: new Date(
        issuedAt.getTime() + VERIFICATION_TTL_SECONDS * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      createdAt: issuedAt,
    }),
  )
}

const confirm = (overrides: Partial<ConfirmEmailCommand> = {}) =>
  useCase.execute({ email: EMAIL, code: CODE, password: PASSWORD, ...overrides })

const storedUser = () => {
  const [user] = usersRepository.users
  if (user === undefined) throw new Error(USER_MISSING_MESSAGE)

  return user
}

const pendingById = (id: string) => pendingRepo.rows.find((p) => p.id === id)

async function failureFrom(promise: Promise<unknown>): Promise<{
  message: string
  code: string
}> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EmailVerificationFailedError) {
      return { message: error.message, code: error.code }
    }
    throw error
  }

  throw new Error(NO_FAILURE_MESSAGE)
}

/**
 * The failure modes, as a TABLE run through one body — because what is under
 * test is that they are INDISTINGUISHABLE: six bodies would each be free to
 * grow their own assertion, and the account-and-code oracle would come back one
 * maintenance at a time.
 */
const FAILURE_SCENARIOS: ReadonlyArray<
  [name: string, arrange: () => void, overrides: Partial<ConfirmEmailCommand>]
> = [
  ['the address has no pending registration', () => {}, {}],
  ['the code has expired', () => storeUsablePending({ ageMs: EXPIRED_AGE_MS }), {}],
  [
    'the attempts are exhausted',
    () => storeUsablePending({ attempts: MAX_ATTEMPTS }),
    {},
  ],
  ['the code is wrong', () => storeUsablePending(), { code: WRONG_CODE }],
  [
    'a concurrent confirm won the race',
    () => {
      storeUsablePending()
      consumeOutcome = LOST_RACE
    },
    {},
  ],
]

describe('ConfirmEmailUseCase', () => {
  it.each(FAILURE_SCENARIOS)(
    'fails identically when %s',
    async (_name, arrange, overrides) => {
      arrange()

      expect(await failureFrom(confirm(overrides))).toEqual({
        message: FAILURE_MESSAGE,
        code: FAILURE_CODE,
      })
    },
  )

  it('creates the verified user with THIS request password, opens a session, consumes the pending — one transaction', async () => {
    storeUsablePending()

    const result = await confirm()

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
    const user = storedUser()
    expect(user.email.value).toBe(EMAIL)
    expect(user.passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
    expect(user.emailVerifiedAt).toEqual(NOW)
    expect(user.id).toBe(GENERATED_ID)

    // toEqual on the whole log: consume, then user save, then token save, all
    // before COMMIT — deleting or reordering any of them fails this.
    expect(callLog).toEqual([CONSUME_CALL, USERS_SAVE_CALL, SAVE_TOKEN_CALL, COMMIT])
    expect(signSpy).toHaveBeenCalledWith({ sub: GENERATED_ID })
    expect(pendingById(PENDING_ID)?.consumedAt).toEqual(NOW)
  })

  it('redeems whichever usable pending the code matches, not the most recent', async () => {
    // Attacker pending is newer; the victim types the code of the OLDER one.
    storeUsablePending({
      id: OLD_PENDING_ID,
      ageMs: OLDER_AGE_MS,
      codeHash: `${DIGEST_PREFIX}${CODE}`,
    })
    storeUsablePending({
      id: NEW_PENDING_ID,
      ageMs: FRESH_AGE_MS,
      codeHash: `${DIGEST_PREFIX}${OTHER_CODE}`,
    })

    await confirm({ code: CODE, password: PASSWORD })

    // The account has the password from THIS confirm request, and the OLD
    // pending — the one whose code was typed — is the one consumed.
    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
    expect(pendingById(OLD_PENDING_ID)?.consumedAt).toEqual(NOW)
    expect(pendingById(NEW_PENDING_ID)?.consumedAt).toBeNull()
  })

  it('hashes the password even when no code matches, so match and no-match cost the same', async () => {
    storeUsablePending()

    await failureFrom(confirm({ code: WRONG_CODE }))

    expect(hashedPlaintexts).toEqual([PASSWORD])
  })

  it('on no match with usable pendings, burns one attempt on the most recent and never opens the transaction', async () => {
    storeUsablePending({ id: OLD_PENDING_ID, ageMs: OLDER_AGE_MS })
    storeUsablePending({ id: NEW_PENDING_ID, ageMs: FRESH_AGE_MS })

    await failureFrom(confirm({ code: WRONG_CODE }))

    expect(registerFailedAttemptSpy).toHaveBeenCalledTimes(1)
    expect(registerFailedAttemptSpy).toHaveBeenCalledWith(NEW_PENDING_ID, MAX_ATTEMPTS)
    expect(callLog).toEqual([REGISTER_FAILED_ATTEMPT_CALL])
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('on no usable pending at all, throws without burning an attempt', async () => {
    await failureFrom(confirm())

    expect(registerFailedAttemptSpy).not.toHaveBeenCalled()
  })

  it('rejects a password that breaks the policy before touching the code', async () => {
    storeUsablePending()

    await expect(confirm({ password: WEAK_PASSWORD })).rejects.toBeInstanceOf(
      InvalidPasswordError,
    )

    expect(hashedPlaintexts).toHaveLength(0)
    expect(registerFailedAttemptSpy).not.toHaveBeenCalled()
  })

  it('throws inside the transaction when it loses the consume race, writing no user', async () => {
    storeUsablePending()
    consumeOutcome = LOST_RACE

    await failureFrom(confirm())

    expect(callLog).toEqual([CONSUME_CALL]) // no USERS_SAVE_CALL, no COMMIT
    expect(usersRepository.users).toHaveLength(0)
  })

  it('turns a users.save unique violation into the generic failure and rolls back', async () => {
    storeUsablePending()
    usersRepository.users.push(
      User.fromTrusted({
        id: 'someone-else',
        email: Email.fromTrusted(EMAIL),
        passwordHash: 'x',
        emailVerifiedAt: NOW,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }),
    )

    expect(await failureFrom(confirm())).toEqual({
      message: FAILURE_MESSAGE,
      code: FAILURE_CODE,
    })
    // Rejected before the token save and the COMMIT.
    expect(callLog).toEqual([CONSUME_CALL])
  })
})
