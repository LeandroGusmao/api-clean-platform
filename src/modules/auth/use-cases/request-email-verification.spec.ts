import { beforeEach, describe, expect, it } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { User } from '#modules/auth/entities/user'
import { InMemoryPendingRegistrationsRepository } from '#modules/auth/infra/in-memory/in-memory-pending-registrations-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { RequestEmailVerificationUseCase } from '#modules/auth/use-cases/request-email-verification'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const ISSUER_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
const PENDING_ID = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091'
const OLD_PENDING_ID = '11111111-1111-4111-8111-111111111111'
const NEW_PENDING_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const HASH_PREFIX = 'hashed:'
const DIGEST_PREFIX = 'digest:'

const EMAIL = 'joao@example.com'
const UNKNOWN_EMAIL = 'ninguem@example.com'
const PASSWORD_HASH = `${HASH_PREFIX}whatever-they-chose`

const CODE = '123456'
const OLD_CODE = 'aaa'
const TTL_SECONDS = 900
const MAX_ATTEMPTS = 5
const MILLISECONDS_PER_SECOND = 1000
const COOLDOWN_MS = 60_000
/** Younger than the cooldown, so a resend must be refused. */
const INSIDE_COOLDOWN_AGE_MS = 1
/**
 * EXACTLY the cooldown, which pins the boundary as exclusive: `now -
 * codeIssuedAt < cooldown` refuses, so an age equal to it must send.
 */
const OUTSIDE_COOLDOWN_AGE_MS = COOLDOWN_MS
const OLDER_AGE_MS = 300_000

const VERIFICATION_SUBJECT = 'Confirm your email address'

/** Records the order in which collaborators were touched. */
const REISSUE_CALL = 'pendingRegistrations.reissueCode'
const EMAIL_SEND = 'email.send'

const idGenerator: IIdGenerator = { generate: () => ISSUER_ID }
const clock: IClock = { now: () => NOW }

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let pendingRepo: InMemoryPendingRegistrationsRepository
let emailSender: IEmailSender
let issuer: EmailVerificationIssuer
let useCase: RequestEmailVerificationUseCase

function buildUseCase(): RequestEmailVerificationUseCase {
  return new RequestEmailVerificationUseCase(
    usersRepository,
    {
      findUnconsumedByEmail: (email) => pendingRepo.findUnconsumedByEmail(email),
      reissueCode: (id, codeHash, codeIssuedAt, expiresAt) => {
        callLog.push(REISSUE_CALL)
        return pendingRepo.reissueCode(id, codeHash, codeIssuedAt, expiresAt)
      },
    },
    issuer,
    clock,
    COOLDOWN_MS,
    MAX_ATTEMPTS,
    TTL_SECONDS,
  )
}

function storeUser(): void {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

function storePending({
  id = PENDING_ID,
  ageMs,
  codeHash = `${DIGEST_PREFIX}${OLD_CODE}`,
  attempts = 0,
}: {
  id?: string
  ageMs: number
  codeHash?: string
  attempts?: number
}): void {
  const issuedAt = new Date(NOW.getTime() - ageMs)
  pendingRepo.rows.push(
    PendingRegistration.fromTrusted({
      id,
      email: Email.fromTrusted(EMAIL),
      codeHash,
      attempts,
      codeIssuedAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: issuedAt,
    }),
  )
}

const pendingById = (id: string) => pendingRepo.rows.find((p) => p.id === id)

beforeEach(() => {
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  pendingRepo = new InMemoryPendingRegistrationsRepository()

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
    idGenerator,
    TTL_SECONDS,
  )

  useCase = buildUseCase()
})

describe('RequestEmailVerificationUseCase', () => {
  it('resolves and does nothing for an unknown address', async () => {
    await expect(useCase.execute({ email: UNKNOWN_EMAIL })).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })

  it('resolves and does nothing when a real account exists for the address', async () => {
    storeUser()
    storePending({ ageMs: OUTSIDE_COOLDOWN_AGE_MS })

    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })

  it('resolves and does nothing when there is no usable pending', async () => {
    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()

    expect(sent).toHaveLength(0)
  })

  it('resolves and does nothing when the most recent usable pending is inside the cooldown', async () => {
    storePending({ ageMs: INSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })

  it('reissues onto the most recent pending once it leaves the cooldown, then sends', async () => {
    storePending({ id: PENDING_ID, ageMs: OUTSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(callLog).toEqual([REISSUE_CALL, EMAIL_SEND])
    const pending = pendingById(PENDING_ID)
    expect(pending?.codeHash).toBe(`${DIGEST_PREFIX}${CODE}`)
    expect(pending?.attempts).toBe(0)
    expect(pending?.codeIssuedAt).toEqual(NOW)
    expect(pending?.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
  })

  it('targets the most recent usable pending among several', async () => {
    storePending({ id: OLD_PENDING_ID, ageMs: OLDER_AGE_MS })
    storePending({ id: NEW_PENDING_ID, ageMs: OUTSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(pendingById(NEW_PENDING_ID)?.codeIssuedAt).toEqual(NOW)
    expect(pendingById(OLD_PENDING_ID)?.codeIssuedAt).not.toEqual(NOW)
  })

  it('skips a pending that has exhausted its attempts', async () => {
    storePending({ ageMs: OUTSIDE_COOLDOWN_AGE_MS, attempts: MAX_ATTEMPTS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })
})
