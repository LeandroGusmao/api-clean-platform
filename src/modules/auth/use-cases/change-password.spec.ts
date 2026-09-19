import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { PasswordUnchangedError } from '#modules/auth/errors/password-unchanged-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { passwordChangedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
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
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const
const WRONG_PASSWORD = 'n0t-the-one!'
const WEAK_PASSWORD = 'short'

/** The fake hashes by prefixing, so a hash is recognisable and reversible. */
const HASH_PREFIX = 'hashed:'
const CURRENT_HASH = `${HASH_PREFIX}${CURRENT_PASSWORD}`
const NEW_HASH = `${HASH_PREFIX}${NEW_PASSWORD}`
const DUMMY_HASH = `${HASH_PREFIX}dummy`

const ACCESS_TOKEN = 'signed-access-token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
/** Unused by this suite; required only to satisfy `ITokenGenerator`. */
const NUMERIC_CODE = '000000'
const GENERATED_ID = 'generated-id'
const DIGEST_PREFIX = 'digest:'
const TTL_SECONDS = 3600

const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
/** Enough to make two readings distinguishable; nothing depends on the size. */
const CLOCK_STEP_MS = 1

/** Records the order in which collaborators were called. */
const COMPARE_CALL = 'compare'
const HASH_CALL = 'hash'
const UOW_CALL = 'uow'
const UPDATE_CALL = 'updatePasswordHash'
const REVOKE_ALL_CALL = 'revokeAllForUser'
const SAVE_TOKEN_CALL = 'saveToken'
/** Pushed by the `uow` fake only when its callback RESOLVES — never on a rollback. */
const COMMIT_CALL = 'commit'
const SAVE_OUTBOX_CALL = 'saveOutboxMessage'

let callLog: string[]
let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let outboxMessages: InMemoryOutboxMessagesRepository
let useCase: ChangePasswordUseCase
// Typed with the real signatures rather than a bare `ReturnType<typeof vi.fn>`,
// which erases them: the erased form compiles at the declaration and then fails
// where the spy is handed to a port, several lines away.
let findByIdSpy: Mock<IUsersRepository['findById']>
let compareSpy: Mock<IHashProvider['compare']>
let hashSpy: Mock<IHashProvider['hash']>
let signSpy: Mock<ITokenSigner['sign']>
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
  outboxMessages = new InMemoryOutboxMessagesRepository()

  // Wrapped so the log records the order the repositories were touched INSIDE
  // the transaction. Order is the whole point of two of the tests below.
  const trackedRepos: AuthRepos = {
    ...noopAuthRepos(),
    users: {
      save: (user) => usersRepository.save(user),
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) => {
        callLog.push(UPDATE_CALL)
        return usersRepository.updatePasswordHash(id, passwordHash, updatedAt)
      },
      deleteById: (id) => usersRepository.deleteById(id),
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
      findActiveByUserId: (userId, now) =>
        refreshTokensRepository.findActiveByUserId(userId, now),
      deleteExpiredBefore: (cutoff) =>
        refreshTokensRepository.deleteExpiredBefore(cutoff),
    },
    outboxMessages: {
      save: (message) => {
        callLog.push(SAVE_OUTBOX_CALL)
        return outboxMessages.save(message)
      },
      claimNext: (now, leaseUntil) => outboxMessages.claimNext(now, leaseUntil),
      markDispatched: (id, at) => outboxMessages.markDispatched(id, at),
      recordFailure: (id, at, error, maxAttempts) =>
        outboxMessages.recordFailure(id, at, error, maxAttempts),
      deleteDispatchedOrFailedBefore: (cutoff) =>
        outboxMessages.deleteDispatchedOrFailedBefore(cutoff),
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
    deleteById: (id) => usersRepository.deleteById(id),
  }

  // Pushes COMMIT only once `work` has resolved — never on a rejection — which
  // is what makes the ordering assertions below a statement about §8 rather
  // than a fixed sequence that happens to be true today.
  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW_CALL)
    const result = await work(trackedRepos)
    callLog.push(COMMIT_CALL)
    return result
  })

  compareSpy = vi.fn(async (plain, hashed) => {
    callLog.push(COMPARE_CALL)
    return `${HASH_PREFIX}${plain}` === hashed
  })

  hashSpy = vi.fn(async (plain) => {
    callLog.push(HASH_CALL)
    return `${HASH_PREFIX}${plain}`
  })

  // Records the payload. A fake that ignores it would let the use case sign for
  // any subject at all with every assertion in this file still green — and on
  // an endpoint that MINTS a credential, "which subject did we sign for" is
  // exactly what turns a wiring slip into an authorization bug.
  signSpy = vi.fn(async () => ACCESS_TOKEN)

  useCase = new ChangePasswordUseCase(
    readRepository,
    // Cast because `IAuthUnitOfWork` is generic in the callback's return type
    // and `vi.fn` cannot produce a generic function. The spy's own signature is
    // still checked above; only the generic instantiation is waived here.
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: compareSpy, dummyHash: DUMMY_HASH },
    { sign: signSpy, verify: async () => ({ sub: USER_ID }) },
    new RefreshTokenIssuer(
      { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
      { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
      { generate: () => GENERATED_ID },
      TTL_SECONDS,
    ),
    { now: () => NOW },
    { generate: () => GENERATED_ID },
  )
})

const change = (overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
  useCase.execute({
    userId: USER_ID,
    currentPassword: CURRENT_PASSWORD,
    newPassword: NEW_PASSWORD,
    device: DEVICE,
    ...overrides,
  })

describe('ChangePasswordUseCase', () => {
  it('replaces the hash, revokes every session and issues a new pair', async () => {
    storeUser(CURRENT_HASH)

    const result = await change()

    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
  })

  /**
   * The whole sequence, as one equality, and NOT a pair of
   * `indexOf(a) < indexOf(b)` comparisons.
   *
   * `indexOf` returns -1 for a call that never happened, and -1 is less than
   * every real index — so an ordering assertion written that way passes
   * VACUOUSLY when the step it guards is deleted rather than moved. Measured:
   * with the earlier form, deleting `revokeAllForUser` outright left all ten
   * tests in this file green, including the one whose name promised it.
   *
   * One equality kills three mutations at once: deleting a step, swapping two,
   * and moving either argon2 call inside the transaction (§8 of the unit of
   * work design — 15ms of CPU with a pooled connection, of ten, standing
   * still) — plus the one guarantee this task adds: the outbox row must land
   * before the commit, not after it.
   */
  it('writes the outbox row INSIDE the transaction, before it commits', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog).toEqual([
      COMPARE_CALL,
      HASH_CALL,
      // Everything below this line runs inside the transaction; everything
      // above it must not.
      UOW_CALL,
      UPDATE_CALL,
      REVOKE_ALL_CALL,
      SAVE_TOKEN_CALL,
      // The outbox row, before the commit: a crash right after this line still
      // loses nothing, because the row and the state change are one fact.
      SAVE_OUTBOX_CALL,
      COMMIT_CALL,
    ])
  })

  it('enqueues the password-changed notice for the outbox to dispatch later', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(outboxMessages.messages.map((message) => message.toEmailMessage())).toEqual([
      passwordChangedEmail(Email.fromTrusted(EMAIL)),
    ])
  })

  it('leaves the new token alive after the revocation', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(issuedToken()?.revokedAt).toBeNull()
  })

  it('records the device context on the session it re-opens', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(issuedToken()?.ip).toBe(DEVICE.ip)
    expect(issuedToken()?.deviceLabel).toBe(DEVICE.label)
    // The old family died with the password, so this IS a new session.
    expect(issuedToken()?.sessionStartedAt).toEqual(NOW)
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

  it('refuses a federated-only account (null hash) after a decoy compare, writing nothing', async () => {
    // No current password to confirm. The decoy keeps the timing level with a
    // wrong-password attempt; "set a first password" is a future slice.
    usersRepository.users.push(
      User.fromTrusted({
        id: USER_ID,
        email: Email.fromTrusted(EMAIL),
        passwordHash: null,
        emailVerifiedAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }),
    )

    await expect(change({ currentPassword: 'x' })).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(compareSpy).toHaveBeenCalledWith('x', DUMMY_HASH)
    expect(storedUser()?.passwordHash).toBeNull()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('stamps updatedAt from the injected clock', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(storedUser()?.updatedAt).toEqual(NOW)
  })

  it('signs the access token for the user who changed the password', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(signSpy).toHaveBeenCalledWith({ sub: USER_ID })
  })

  /**
   * The clock ADVANCES one millisecond per reading, and that is what makes this
   * falsifiable. A fixed stub returns the same instant however many times it is
   * asked, so the test would be green by construction — decoration, by this
   * project's own rule that a test surviving its own mutation is not a test.
   *
   * An advancing stub is a double in the same sense as `HASH_PREFIX`: it makes
   * readings DISTINGUISHABLE, so a behaviour that would otherwise be invisible
   * becomes observable. Three `clock.now()` calls put different instants on
   * `updated_at` and on the token's `created_at`, across writes one transaction
   * makes atomic.
   */
  it('reads the clock once, so every write shares one instant', async () => {
    let reading = NOW.getTime()
    const advancingClock = () => {
      reading += CLOCK_STEP_MS
      return new Date(reading)
    }
    const advancingUseCase = new ChangePasswordUseCase(
      usersRepository,
      uowSpy as unknown as IAuthUnitOfWork,
      { hash: hashSpy, compare: compareSpy, dummyHash: DUMMY_HASH },
      { sign: signSpy, verify: async () => ({ sub: USER_ID }) },
      new RefreshTokenIssuer(
        { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
        { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
        { generate: () => GENERATED_ID },
        TTL_SECONDS,
      ),
      { now: advancingClock },
      { generate: () => GENERATED_ID },
    )
    storeUser(CURRENT_HASH)

    await advancingUseCase.execute({
      userId: USER_ID,
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    })

    expect(storedUser()?.updatedAt).toEqual(issuedToken()?.createdAt)
  })
})
