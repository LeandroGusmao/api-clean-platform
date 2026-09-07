import { beforeEach, describe, expect, it } from 'vitest'
import { EmailVerification } from '#modules/auth/entities/email-verification'
import { User } from '#modules/auth/entities/user'
import { InMemoryEmailVerificationsRepository } from '#modules/auth/infra/in-memory/in-memory-email-verifications-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { RequestEmailVerificationUseCase } from '#modules/auth/use-cases/request-email-verification'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const VERIFICATION_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const HASH_PREFIX = 'hashed:'
const DIGEST_PREFIX = 'digest:'

const EMAIL = 'joao@example.com'
const UNKNOWN_EMAIL = 'ninguem@example.com'
const PASSWORD_HASH = `${HASH_PREFIX}whatever-they-chose`

/** Six digits, like the real generator's. Its presence in a body is asserted. */
const CODE = '123456'
const VERIFICATION_TTL_SECONDS = 900
const COOLDOWN_MS = 60_000
/** Younger than the cooldown, so a resend must be refused. */
const INSIDE_COOLDOWN_AGE_MS = 1
/**
 * EXACTLY the cooldown, which pins the boundary as exclusive:
 * `now - createdAt < cooldown` refuses, so an age equal to it must send. A
 * test using a comfortably older code would leave `<=` and `<` indistinguishable.
 */
const OUTSIDE_COOLDOWN_AGE_MS = COOLDOWN_MS

const VERIFICATION_SUBJECT = 'Confirm your email address'

const idGenerator: IIdGenerator = { generate: () => VERIFICATION_ID }
const clock: IClock = { now: () => NOW }

/** Records the order in which collaborators were touched. */
const VERIFICATIONS_INVALIDATE = 'verifications.invalidateActiveForUser'
const VERIFICATIONS_SAVE = 'verifications.save'
const COMMIT = 'COMMIT'
const EMAIL_SEND = 'email.send'

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let verificationsRepository: InMemoryEmailVerificationsRepository
let emailSender: IEmailSender
let issuer: EmailVerificationIssuer
let useCase: RequestEmailVerificationUseCase

/**
 * The repositories as the transaction hands them out, wrapping the SAME
 * in-memory instance the use case reads directly for the cooldown check —
 * one database, two handles.
 */
function trackedRepos(): AuthRepos {
  return {
    users: usersRepository,
    refreshTokens: {
      save: async () => {},
      findByHashForUpdate: async () => null,
      markRotated: async () => {},
      revoke: async () => {},
      revokeFamily: async () => {},
      revokeAllForUser: async () => {},
    },
    emailVerifications: {
      save: (verification) => {
        callLog.push(VERIFICATIONS_SAVE)
        return verificationsRepository.save(verification)
      },
      findActiveByUserId: (userId) => verificationsRepository.findActiveByUserId(userId),
      invalidateActiveForUser: (userId, at) => {
        callLog.push(VERIFICATIONS_INVALIDATE)
        return verificationsRepository.invalidateActiveForUser(userId, at)
      },
      registerFailedAttempt: (id, maxAttempts) =>
        verificationsRepository.registerFailedAttempt(id, maxAttempts),
      consume: (id, at) => verificationsRepository.consume(id, at),
    },
    pendingRegistrations: {
      save: async () => {},
      findUnconsumedByEmail: async () => [],
      reissueCode: async () => {},
      registerFailedAttempt: async () => false,
      consume: async () => false,
      deleteExpiredByEmail: async () => {},
    },
  }
}

/**
 * The `uow` fake appends `COMMIT` when — and only when — the callback
 * resolves. That marker is what turns the order assertion below into a
 * statement about §8: a send recorded before it would be a send inside the
 * transaction.
 */
function committingUow(): IAuthUnitOfWork {
  const repos = trackedRepos()

  const uow = async (work: (repos: AuthRepos) => Promise<unknown>) => {
    const result = await work(repos)
    callLog.push(COMMIT)

    return result
  }

  // Cast because `IAuthUnitOfWork` is generic in the callback's return type
  // and a plain function cannot be generic here. Only the generic
  // instantiation is waived; the callback's parameter type is still checked
  // above.
  return uow as unknown as IAuthUnitOfWork
}

/**
 * A `uow` that must never be reached: every early-return branch resolves
 * before the transaction opens, and calling this proves that boundary broke.
 */
const NEVER_CALLED_UOW_MESSAGE = 'the use case opened a transaction it should not have'
const untouchableUow: IAuthUnitOfWork = (() => {
  throw new Error(NEVER_CALLED_UOW_MESSAGE)
}) as unknown as IAuthUnitOfWork

function buildUseCase(uow: IAuthUnitOfWork): RequestEmailVerificationUseCase {
  return new RequestEmailVerificationUseCase(
    usersRepository,
    verificationsRepository,
    uow,
    issuer,
    clock,
    COOLDOWN_MS,
  )
}

function storeUser(emailVerifiedAt: Date | null) {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

function storeActiveVerification(ageMs: number) {
  verificationsRepository.verifications.push(
    EmailVerification.create({
      id: VERIFICATION_ID,
      userId: USER_ID,
      codeHash: `${DIGEST_PREFIX}${CODE}`,
      now: new Date(NOW.getTime() - ageMs),
      ttlSeconds: VERIFICATION_TTL_SECONDS,
    }),
  )
}

beforeEach(() => {
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  verificationsRepository = new InMemoryEmailVerificationsRepository()

  emailSender = {
    send: async (message) => {
      callLog.push(EMAIL_SEND)
      sent.push(message)
    },
  }

  // The REAL issuer, not a double: what is under test here is that the use
  // case defers the send it is handed, and a fake issuer would let the use
  // case pass while the deferral it depends on was gone.
  issuer = new EmailVerificationIssuer(
    emailSender,
    { opaque: () => CODE, numericCode: () => CODE },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    idGenerator,
    VERIFICATION_TTL_SECONDS,
  )

  useCase = buildUseCase(committingUow())
})

describe('RequestEmailVerificationUseCase', () => {
  it('resolves and sends nothing for an unknown address', async () => {
    await expect(
      buildUseCase(untouchableUow).execute({ email: UNKNOWN_EMAIL }),
    ).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
  })

  it('resolves and sends nothing for an already-verified account', async () => {
    storeUser(NOW)

    await expect(
      buildUseCase(untouchableUow).execute({ email: EMAIL }),
    ).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
  })

  it('resolves and sends nothing when the active code is inside the cooldown', async () => {
    storeUser(null)
    storeActiveVerification(INSIDE_COOLDOWN_AGE_MS)

    await expect(
      buildUseCase(untouchableUow).execute({ email: EMAIL }),
    ).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
    // The stale code is still the only one on file: nothing new was minted.
    expect(verificationsRepository.verifications).toHaveLength(1)
  })

  it('issues and sends once the active code has left the cooldown', async () => {
    storeUser(null)
    storeActiveVerification(OUTSIDE_COOLDOWN_AGE_MS)

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
    // toEqual and not toContain: this single assertion kills a deleted
    // `deliver()`, a send moved inside the callback, and any reordering of
    // the two writes.
    expect(callLog).toEqual([
      VERIFICATIONS_INVALIDATE,
      VERIFICATIONS_SAVE,
      COMMIT,
      EMAIL_SEND,
    ])
  })

  it('issues and sends when there is no active code at all', async () => {
    storeUser(null)

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
  })

  it('sends AFTER the transaction commits, never before', async () => {
    storeUser(null)

    await useCase.execute({ email: EMAIL })

    // The marker only `committingUow` appends, once the callback has
    // resolved: a send recorded before it would be a send inside the
    // transaction, which §8 of the unit of work design forbids.
    expect(callLog.indexOf(COMMIT)).toBeLessThan(callLog.indexOf(EMAIL_SEND))
  })
})
