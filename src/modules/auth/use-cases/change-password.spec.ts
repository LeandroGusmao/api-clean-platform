import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { PasswordUnchangedError } from '#modules/auth/errors/password-unchanged-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { ChangePasswordUseCase } from '#modules/auth/use-cases/change-password'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const EMAIL = 'joao@example.com'

const CURRENT_PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const WRONG_PASSWORD = 'n0t-the-one!'
const WEAK_PASSWORD = 'short'

/** The fake hashes by prefixing, so a hash is recognisable and reversible. */
const HASH_PREFIX = 'hashed:'
const CURRENT_HASH = `${HASH_PREFIX}${CURRENT_PASSWORD}`
const NEW_HASH = `${HASH_PREFIX}${NEW_PASSWORD}`
const DUMMY_HASH = `${HASH_PREFIX}dummy`

const ACCESS_TOKEN = 'signed-access-token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
const GENERATED_ID = 'generated-id'
const DIGEST_PREFIX = 'digest:'
const TTL_SECONDS = 3600

const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')

/** Records the order in which collaborators were called. */
const COMPARE_CALL = 'compare'
const HASH_CALL = 'hash'
const UOW_CALL = 'uow'
const UPDATE_CALL = 'updatePasswordHash'
const REVOKE_ALL_CALL = 'revokeAllForUser'
const SAVE_TOKEN_CALL = 'saveToken'

let callLog: string[]
let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let useCase: ChangePasswordUseCase
// Typed with the real signatures rather than a bare `ReturnType<typeof vi.fn>`,
// which erases them: the erased form compiles at the declaration and then fails
// where the spy is handed to a port, several lines away.
let findByIdSpy: Mock<IUsersRepository['findById']>
let compareSpy: Mock<IHashProvider['compare']>
let hashSpy: Mock<IHashProvider['hash']>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>

const storeUser = (passwordHash: string) => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash,
      emailVerifiedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

const storedUser = () => usersRepository.users.find((user) => user.id === USER_ID)

const issuedToken = () =>
  refreshTokensRepository.tokens.find(
    (token) => token.tokenHash === `${DIGEST_PREFIX}${OPAQUE_TOKEN}`,
  )

beforeEach(() => {
  callLog = []
  usersRepository = new InMemoryUsersRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()

  // Wrapped so the log records the order the repositories were touched INSIDE
  // the transaction. Order is the whole point of two of the tests below.
  const trackedRepos: AuthRepos = {
    users: {
      save: (user) => usersRepository.save(user),
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) => {
        callLog.push(UPDATE_CALL)
        return usersRepository.updatePasswordHash(id, passwordHash, updatedAt)
      },
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
      revokeAllForUser: (userId, revokedAt) => {
        callLog.push(REVOKE_ALL_CALL)
        return refreshTokensRepository.revokeAllForUser(userId, revokedAt)
      },
    },
  }

  // The read the use case makes OUTSIDE the transaction, spied separately: it
  // is what proves the policy check runs before any I/O at all.
  findByIdSpy = vi.fn((id) => usersRepository.findById(id))

  const readRepository: IUsersRepository = {
    save: (user) => usersRepository.save(user),
    findByEmail: (email) => usersRepository.findByEmail(email),
    findById: findByIdSpy,
    updatePasswordHash: (id, passwordHash, updatedAt) =>
      usersRepository.updatePasswordHash(id, passwordHash, updatedAt),
  }

  uowSpy = vi.fn((work) => {
    callLog.push(UOW_CALL)
    return work(trackedRepos)
  })

  compareSpy = vi.fn(async (plain, hashed) => {
    callLog.push(COMPARE_CALL)
    return `${HASH_PREFIX}${plain}` === hashed
  })

  hashSpy = vi.fn(async (plain) => {
    callLog.push(HASH_CALL)
    return `${HASH_PREFIX}${plain}`
  })

  useCase = new ChangePasswordUseCase(
    readRepository,
    // Cast because `IAuthUnitOfWork` is generic in the callback's return type
    // and `vi.fn` cannot produce a generic function. The spy's own signature is
    // still checked above; only the generic instantiation is waived here.
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: compareSpy, dummyHash: DUMMY_HASH },
    { sign: async () => ACCESS_TOKEN, verify: async () => ({ sub: USER_ID }) },
    new RefreshTokenIssuer(
      { opaque: () => OPAQUE_TOKEN },
      { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
      { generate: () => GENERATED_ID },
      TTL_SECONDS,
    ),
    { now: () => NOW },
  )
})

const change = (overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
  useCase.execute({
    userId: USER_ID,
    currentPassword: CURRENT_PASSWORD,
    newPassword: NEW_PASSWORD,
    ...overrides,
  })

describe('ChangePasswordUseCase', () => {
  it('replaces the hash, revokes every session and issues a new pair', async () => {
    storeUser(CURRENT_HASH)

    const result = await change()

    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
  })

  it('runs both argon2 calls BEFORE opening the transaction', async () => {
    // The assertion is the ORDER, not the outcome. Moving either hash call
    // inside the callback keeps every other test in this file green while
    // parking a pooled connection on 15ms of CPU — §8 of the unit of work
    // design, and the one mistake this slice was warned about.
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog.indexOf(COMPARE_CALL)).toBeLessThan(callLog.indexOf(UOW_CALL))
    expect(callLog.indexOf(HASH_CALL)).toBeLessThan(callLog.indexOf(UOW_CALL))
  })

  it('revokes every session BEFORE inserting the new token', async () => {
    // revokeAllForUser revokes every row of the user whose revoked_at is null.
    // Inserting first means the brand new token is caught by that same UPDATE
    // and is born revoked: the endpoint answers 200 and the first refresh
    // answers 401.
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog.indexOf(REVOKE_ALL_CALL)).toBeLessThan(
      callLog.indexOf(SAVE_TOKEN_CALL),
    )
  })

  it('leaves the new token alive after the revocation', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(issuedToken()?.revokedAt).toBeNull()
  })

  it('rejects a wrong current password and writes nothing', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ currentPassword: WRONG_PASSWORD })).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
    expect(storedUser()?.passwordHash).toBe(CURRENT_HASH)
  })

  it('rejects a new password equal to the current one without hashing it', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ newPassword: CURRENT_PASSWORD })).rejects.toBeInstanceOf(
      PasswordUnchangedError,
    )
    expect(hashSpy).not.toHaveBeenCalled()
  })

  it('rejects a weak new password before touching the repository', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ newPassword: WEAK_PASSWORD })).rejects.toBeInstanceOf(
      InvalidPasswordError,
    )
    // `findById` and not only `compare`: the policy must run before ANY I/O,
    // and asserting the hash provider alone leaves the read free to move ahead
    // of it — which is exactly what the falsification of this test found.
    expect(findByIdSpy).not.toHaveBeenCalled()
    expect(compareSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('reports a missing user rather than writing', async () => {
    await expect(change({ userId: MISSING_USER_ID })).rejects.toBeInstanceOf(
      UserNotFoundError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('stamps updatedAt from the injected clock', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(storedUser()?.updatedAt).toEqual(NOW)
  })

  it('reads the clock once, so every write shares one instant', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(storedUser()?.updatedAt).toEqual(issuedToken()?.createdAt)
  })
})
