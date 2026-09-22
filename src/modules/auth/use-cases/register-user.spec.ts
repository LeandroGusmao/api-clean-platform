import { beforeEach, describe, expect, it } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { User } from '#modules/auth/entities/user'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { InMemoryAccountExistsNoticesRepository } from '#modules/auth/infra/in-memory/in-memory-account-exists-notices-repository'
import { InMemoryPendingRegistrationsRepository } from '#modules/auth/infra/in-memory/in-memory-pending-registrations-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IAccountExistsNoticesRepository } from '#modules/auth/repositories/account-exists-notices-repository'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { RegisterUserUseCase } from '#modules/auth/use-cases/register-user'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EXISTING_USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const OTHER_USER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const EXISTING_PENDING_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const HASH_PREFIX = 'hashed:'
const DIGEST_PREFIX = 'digest:'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const INVALID_EMAIL = 'not-an-email'
const EXISTING_PASSWORD_HASH = `${HASH_PREFIX}whatever-they-chose`

/** Six digits, like the real generator's. Its presence in a body is asserted. */
const CODE = '123456'
const TTL_SECONDS = 900
const MAX_ATTEMPTS = 5
const MILLISECONDS_PER_SECOND = 1000
const RESEND_COOLDOWN_MS = 60_000
/** Younger than the cooldown, so a fresh registration must not send. */
const INSIDE_COOLDOWN_AGE_MS = 1
/**
 * EXACTLY the cooldown, which pins the boundary as exclusive: `now - codeIssuedAt
 * < cooldown` refuses, so an age equal to it must issue.
 */
const OUTSIDE_COOLDOWN_AGE_MS = RESEND_COOLDOWN_MS

/**
 * The wire contract of the two templates, spelled out rather than imported:
 * importing them would make the assertion tautological.
 */
const VERIFICATION_SUBJECT = 'Confirm your email address'
const ALREADY_EXISTS_SUBJECT = 'Someone tried to register with your address'

/** Records the order in which collaborators were touched. */
const PRUNE = 'pendingRegistrations.deleteExpiredByEmail'
const PENDING_SAVE = 'pendingRegistrations.save'
const EMAIL_SEND = 'email.send'
const NOTICE_CLAIM = 'accountExistsNotices.claim'

// One-method ports do not deserve their own file.
const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => ID }

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let pendingRepo: InMemoryPendingRegistrationsRepository
let noticesRepo: InMemoryAccountExistsNoticesRepository
let emailSender: IEmailSender
let issuer: EmailVerificationIssuer
let useCase: RegisterUserUseCase

/** Wraps the in-memory pending repo so a test can assert the write order. */
function trackedPending(): Pick<
  IPendingRegistrationsRepository,
  'findUnconsumedByEmail' | 'save' | 'deleteExpiredByEmail'
> {
  return {
    findUnconsumedByEmail: (email) => pendingRepo.findUnconsumedByEmail(email),
    save: (pending) => {
      callLog.push(PENDING_SAVE)
      return pendingRepo.save(pending)
    },
    deleteExpiredByEmail: (email, now) => {
      callLog.push(PRUNE)
      return pendingRepo.deleteExpiredByEmail(email, now)
    },
  }
}

/** Wraps the in-memory notices repo so a test can assert the write order. */
function trackedNotices(): IAccountExistsNoticesRepository {
  return {
    claim: (params) => {
      callLog.push(NOTICE_CLAIM)
      return noticesRepo.claim(params)
    },
  }
}

function buildUseCase(): RegisterUserUseCase {
  return new RegisterUserUseCase(
    usersRepository,
    trackedPending(),
    trackedNotices(),
    issuer,
    emailSender,
    clock,
    idGenerator,
    RESEND_COOLDOWN_MS,
    TTL_SECONDS,
  )
}

beforeEach(() => {
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  pendingRepo = new InMemoryPendingRegistrationsRepository()
  noticesRepo = new InMemoryAccountExistsNoticesRepository()

  emailSender = {
    send: async (message) => {
      callLog.push(EMAIL_SEND)
      sent.push(message)
    },
  }

  // The REAL issuer, not a double: what is under test is that the use case
  // defers the send it is handed.
  issuer = new EmailVerificationIssuer(
    emailSender,
    { opaque: () => CODE, numericCode: () => CODE },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    TTL_SECONDS,
  )

  useCase = buildUseCase()
})

function storeVerifiedUser(id = EXISTING_USER_ID, email = EMAIL): void {
  usersRepository.users.push(
    User.fromTrusted({
      id,
      email: Email.fromTrusted(email),
      passwordHash: EXISTING_PASSWORD_HASH,
      emailVerifiedAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

function storePending({
  ageMs,
  attempts = 0,
}: {
  ageMs: number
  attempts?: number
}): void {
  const issuedAt = new Date(NOW.getTime() - ageMs)
  pendingRepo.rows.push(
    PendingRegistration.fromTrusted({
      id: EXISTING_PENDING_ID,
      email: Email.fromTrusted(EMAIL),
      codeHash: `${DIGEST_PREFIX}${CODE}`,
      attempts,
      codeIssuedAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: issuedAt,
    }),
  )
}

describe('RegisterUserUseCase', () => {
  it('prunes, writes a pending registration, and only then sends the code', async () => {
    await useCase.execute({ email: EMAIL })

    // toEqual on the whole log: kills a deleted deliver(), a send before the
    // write, and a missing prune.
    expect(callLog).toEqual([PRUNE, PENDING_SAVE, EMAIL_SEND])
    expect(pendingRepo.rows).toHaveLength(1)
    expect(pendingRepo.rows[0]?.email.value).toBe(EMAIL)
    expect(pendingRepo.rows[0]?.codeHash).toBe(`${DIGEST_PREFIX}${CODE}`)
    expect(usersRepository.users).toHaveLength(0)
  })

  it('resolves with nothing', async () => {
    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()
  })

  it('emails the six-digit code to the address', async () => {
    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
  })

  it('normalizes the email before storing it', async () => {
    await useCase.execute({ email: MIXED_CASE_EMAIL })

    expect(pendingRepo.rows[0]?.email.value).toBe(EMAIL)
  })

  it('takes the id from the generator and both timestamps from the clock', async () => {
    await useCase.execute({ email: EMAIL })
    const pending = pendingRepo.rows[0]

    expect(pending?.id).toBe(ID)
    expect(pending?.createdAt).toEqual(NOW)
    expect(pending?.codeIssuedAt).toEqual(NOW)
  })

  it('emails "you already have an account" when the address is a VERIFIED user', async () => {
    storeVerifiedUser()

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(ALREADY_EXISTS_SUBJECT)
    expect(sent[0]?.text).not.toContain(CODE)
    expect(pendingRepo.rows).toHaveLength(0)
    expect(callLog).toEqual([NOTICE_CLAIM, EMAIL_SEND])
  })

  it('sends no second "already have an account" notice inside the cooldown', async () => {
    storeVerifiedUser()

    await useCase.execute({ email: EMAIL })
    await useCase.execute({ email: EMAIL })
    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(callLog).toEqual([NOTICE_CLAIM, EMAIL_SEND, NOTICE_CLAIM, NOTICE_CLAIM])
  })

  it('stamps the notice with the clock and claims it against the resend cooldown', async () => {
    storeVerifiedUser()

    await useCase.execute({ email: EMAIL })

    expect(noticesRepo.sentAt.get(EXISTING_USER_ID)).toEqual(NOW)
  })

  it('sends the notice again once the previous one leaves the cooldown', async () => {
    storeVerifiedUser()
    noticesRepo.sentAt.set(
      EXISTING_USER_ID,
      new Date(NOW.getTime() - OUTSIDE_COOLDOWN_AGE_MS),
    )

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(ALREADY_EXISTS_SUBJECT)
  })

  it('holds the notice while the previous one is inside the cooldown', async () => {
    storeVerifiedUser()
    noticesRepo.sentAt.set(
      EXISTING_USER_ID,
      new Date(NOW.getTime() - INSIDE_COOLDOWN_AGE_MS),
    )

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(0)
  })

  it('keeps the notice cooldown per account', async () => {
    storeVerifiedUser()
    storeVerifiedUser(OTHER_USER_ID, OTHER_EMAIL)

    await useCase.execute({ email: EMAIL })
    await useCase.execute({ email: OTHER_EMAIL })

    expect(sent.map((message) => message.to)).toEqual([EMAIL, OTHER_EMAIL])
  })

  it('sends nothing when a usable pending got a code inside the cooldown', async () => {
    storePending({ ageMs: INSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(0)
    expect(pendingRepo.rows).toHaveLength(1)
    expect(callLog).toEqual([])
  })

  it('issues a fresh pending once the previous code leaves the cooldown', async () => {
    storePending({ ageMs: OUTSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(pendingRepo.rows).toHaveLength(2)
    expect(callLog).toEqual([PRUNE, PENDING_SAVE, EMAIL_SEND])
  })

  it('holds the cooldown even after the pending has exhausted its attempts', async () => {
    storePending({ ageMs: INSIDE_COOLDOWN_AGE_MS, attempts: MAX_ATTEMPTS })

    await useCase.execute({ email: EMAIL })

    // Otherwise an attacker spread across many IPs mints a fresh five-guess
    // budget on demand, the instant the previous one is spent.
    expect(sent).toHaveLength(0)
    expect(pendingRepo.rows).toHaveLength(1)
    expect(callLog).toEqual([])
  })

  it('issues a fresh pending once an exhausted one leaves the cooldown', async () => {
    storePending({ ageMs: OUTSIDE_COOLDOWN_AGE_MS, attempts: MAX_ATTEMPTS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(pendingRepo.rows).toHaveLength(2)
    expect(callLog).toEqual([PRUNE, PENDING_SAVE, EMAIL_SEND])
  })

  it('answers the same way whether the address is free or already pending', async () => {
    const free = await useCase.execute({ email: EMAIL })
    const pendingAlready = await useCase.execute({ email: EMAIL })

    expect(free).toBe(pendingAlready)
    expect(pendingAlready).toBeUndefined()
  })

  it('rejects an invalid email', async () => {
    await expect(useCase.execute({ email: INVALID_EMAIL })).rejects.toBeInstanceOf(
      InvalidEmailError,
    )

    expect(pendingRepo.rows).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})
