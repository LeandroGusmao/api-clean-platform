import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import {
  BestEffortEmailSender,
  type ErrorLogger,
} from '#infra/providers/best-effort-email-sender'
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import { User } from '#modules/auth/entities/user'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { PasswordResetFailedError } from '#modules/auth/errors/password-reset-failed-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { passwordResetCompletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { ResetPasswordUseCase } from '#modules/auth/use-cases/reset-password'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const TOKEN_ID = 'a1a1a1a1-1111-4111-8111-111111111111'
const EMAIL = 'joao@example.com'

const RAW_TOKEN = 'opaque-256-bit-token-value'
/** The fake digests by prefixing, so a digest is recognisable and reversible. */
const DIGEST_PREFIX = 'digest:'
const TOKEN_HASH = `${DIGEST_PREFIX}${RAW_TOKEN}`

/** Same trick for argon2: a hash stays readable and tied to its plaintext. */
const HASH_PREFIX = 'hashed:'
const OLD_HASH = `${HASH_PREFIX}old`
const DUMMY_HASH = `${HASH_PREFIX}dummy`
const NEW_PASSWORD = 'ev3n-b3tter!'
const NEW_HASH = `${HASH_PREFIX}${NEW_PASSWORD}`
const WEAK_PASSWORD = 'short'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const TTL_SECONDS = 1800
const MILLISECONDS_PER_SECOND = 1000
const TTL_MS = TTL_SECONDS * MILLISECONDS_PER_SECOND

/** Records the order in which collaborators were called. */
const HASH_CALL = 'hash'
const UOW_CALL = 'uow'
const CONSUME_CALL = 'consume'
const UPDATE_CALL = 'updatePasswordHash'
const REVOKE_ALL_CALL = 'revokeAllForUser'
/** Pushed by the `uow` fake only when its callback RESOLVES — never on a rollback. */
const COMMIT_CALL = 'commit'
const SEND_EMAIL_CALL = 'sendEmail'

const NOTIFICATION_FAILURE_MESSAGE = 'delivery unavailable'
/** Discards everything: what the decorator logs is covered on its own spec. */
const silentLogger: ErrorLogger = { error: () => {} }

let callLog: string[]
let sentEmails: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let consumeResult: boolean
// Typed with the real signatures rather than a bare `ReturnType<typeof vi.fn>`,
// which erases them: the erased form compiles at the declaration and then fails
// where the spy is handed to a port, several lines away.
let hashSpy: Mock<IHashProvider['hash']>
let findByHashSpy: Mock<() => Promise<PasswordResetToken | null>>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let emailSender: IEmailSender
let useCase: ResetPasswordUseCase

const storeUser = () => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: OLD_HASH,
      emailVerifiedAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

const storedUser = () => usersRepository.users.find((user) => user.id === USER_ID)

const liveToken = () =>
  PasswordResetToken.fromTrusted({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + TTL_MS),
    consumedAt: null,
    createdAt: NOW,
  })

const makeUseCase = (sender: IEmailSender) =>
  new ResetPasswordUseCase(
    usersRepository,
    { findByHash: findByHashSpy },
    // Cast because `IAuthUnitOfWork` is generic in the callback's return type
    // and `vi.fn` cannot produce a generic function. The spy's own signature is
    // still checked at its declaration; only the generic instantiation is waived.
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: async () => false, dummyHash: DUMMY_HASH },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    { now: () => NOW },
    sender,
  )

beforeEach(() => {
  callLog = []
  sentEmails = []
  usersRepository = new InMemoryUsersRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()
  consumeResult = true

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
      save: (token) => refreshTokensRepository.save(token),
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
    // Nothing in this suite reads pending registrations; the shape only has to
    // satisfy AuthRepos.
    pendingRegistrations: {
      save: async () => {},
      findUnconsumedByEmail: async () => [],
      reissueCode: async () => {},
      registerFailedAttempt: async () => false,
      consume: async () => false,
      deleteExpiredByEmail: async () => {},
    },
    passwordResetTokens: {
      issueOrRefresh: async () => true,
      // The `reset` lookup happens OUTSIDE the transaction, so this member of
      // the bag must never be the one that answers it: `findByHashSpy` is
      // injected separately and this stub returning null would fail the suite.
      findByHash: async () => null,
      consume: async () => {
        callLog.push(CONSUME_CALL)
        return consumeResult
      },
    },
  }

  hashSpy = vi.fn(async (plain) => {
    callLog.push(HASH_CALL)
    return `${HASH_PREFIX}${plain}`
  })

  findByHashSpy = vi.fn(async () => liveToken())

  // Pushes COMMIT only once `work` has resolved — never on a rejection — which
  // is what makes the ordering assertions below a statement about the
  // transaction boundary rather than a sequence that happens to be true today.
  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW_CALL)
    const result = await work(trackedRepos)
    callLog.push(COMMIT_CALL)
    return result
  })

  emailSender = {
    send: async (message) => {
      callLog.push(SEND_EMAIL_CALL)
      sentEmails.push(message)
    },
  }

  useCase = makeUseCase(emailSender)
})

const reset = (overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
  useCase.execute({ token: RAW_TOKEN, newPassword: NEW_PASSWORD, ...overrides })

describe('ResetPasswordUseCase', () => {
  /**
   * The whole sequence, as one equality, and NOT a pair of
   * `indexOf(a) < indexOf(b)` comparisons: `indexOf` returns -1 for a call that
   * never happened, and -1 is less than every real index, so an ordering
   * assertion written that way passes VACUOUSLY when the step it guards is
   * deleted rather than moved.
   *
   * One equality kills four mutations at once: deleting a step, swapping two,
   * moving argon2 inside the transaction, and moving the notification inside it
   * — the send must follow the commit, never a rollback.
   */
  it('hashes, consumes, writes the password, revokes every session, then emails — in that order', async () => {
    storeUser()

    await reset()

    expect(callLog).toEqual([
      // Everything below UOW_CALL runs inside the transaction; argon2 above it
      // must not.
      HASH_CALL,
      UOW_CALL,
      // First inside, always: a lost conditional UPDATE must abort before any
      // write, not after them.
      CONSUME_CALL,
      UPDATE_CALL,
      REVOKE_ALL_CALL,
      COMMIT_CALL,
      SEND_EMAIL_CALL,
    ])
    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
  })

  it('looks the token up by its digest', async () => {
    storeUser()

    await reset()

    expect(findByHashSpy).toHaveBeenCalledWith(TOKEN_HASH)
  })

  it('notifies the owner with the reset-completed email', async () => {
    storeUser()

    await reset()

    expect(sentEmails).toEqual([passwordResetCompletedEmail(Email.fromTrusted(EMAIL))])
  })

  it('stamps updatedAt from the injected clock', async () => {
    storeUser()

    await reset()

    expect(storedUser()?.updatedAt).toEqual(NOW)
  })

  it('rejects a weak new password before any lookup or hash', async () => {
    storeUser()

    await expect(reset({ newPassword: WEAK_PASSWORD })).rejects.toBeInstanceOf(
      InvalidPasswordError,
    )
    // `findByHash` and not only the hash provider: the policy must run before
    // ANY I/O, or a payload that never had a chance still spends a lookup.
    expect(findByHashSpy).not.toHaveBeenCalled()
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  /**
   * argon2 is skipped on every rejected branch, and asserting it NEVER ran is
   * what keeps that a decision rather than an accident of statement order: the
   * cheapest way to "fix" a future failure here is to hash unconditionally, and
   * that would put ~7ms of CPU behind an unauthenticated endpoint.
   */
  it('rejects an unknown token with the generic failure and NO argon2', async () => {
    findByHashSpy.mockResolvedValueOnce(null)

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects an expired token with the generic failure and NO argon2', async () => {
    findByHashSpy.mockResolvedValueOnce(
      PasswordResetToken.fromTrusted({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        issuedAt: new Date(NOW.getTime() - TTL_MS),
        // An instant that has arrived is spent — `isUsable` is inclusive here.
        expiresAt: NOW,
        consumedAt: null,
        createdAt: new Date(NOW.getTime() - TTL_MS),
      }),
    )

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects an already consumed token with the generic failure and NO argon2', async () => {
    findByHashSpy.mockResolvedValueOnce(
      PasswordResetToken.fromTrusted({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + TTL_MS),
        consumedAt: NOW,
        createdAt: NOW,
      }),
    )

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects when it loses the consume race, writing neither the password nor a revocation', async () => {
    storeUser()
    consumeResult = false

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    // Truncated at CONSUME: no UPDATE, no REVOKE, and no COMMIT — the throw
    // happens inside the callback, so the transaction aborts. No SEND either.
    expect(callLog).toEqual([HASH_CALL, UOW_CALL, CONSUME_CALL])
    expect(storedUser()?.passwordHash).toBe(OLD_HASH)
    expect(sentEmails).toEqual([])
  })

  it('still resolves when the completion email cannot be delivered', async () => {
    storeUser()

    // The REAL policy, not a mock of it: a sender that always rejects, wrapped
    // by the same decorator the composition root uses for this notification. If
    // `execute` still throws with this wiring, the use case — not just the
    // decorator in isolation — is what is broken.
    const resilient = makeUseCase(
      new BestEffortEmailSender(
        {
          send: async () => {
            throw new Error(NOTIFICATION_FAILURE_MESSAGE)
          },
        },
        silentLogger,
      ),
    )

    await expect(
      resilient.execute({ token: RAW_TOKEN, newPassword: NEW_PASSWORD }),
    ).resolves.toBeUndefined()
    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
  })
})
