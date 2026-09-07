import { beforeEach, describe, expect, it } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { InMemoryPasswordResetTokensRepository } from '#modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import { PasswordResetIssuer } from '#modules/auth/services/password-reset-issuer'
import { RequestPasswordResetUseCase } from '#modules/auth/use-cases/request-password-reset'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const GENERATED_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const INVALID_EMAIL = 'not-an-email'
const UNKNOWN_EMAIL = 'nobody@example.com'
const PASSWORD_HASH = 'hashed:whatever'
const OPAQUE_TOKEN = 'opaque-256-bit-token'
const DIGEST_PREFIX = 'digest:'
/** The digest of a pre-seeded row, asserted to survive a refused refresh. */
const EARLIER_TOKEN_HASH = `${DIGEST_PREFIX}earlier`
/** Unused by `PasswordResetIssuer`; the generator port still requires it. */
const NUMERIC_CODE = '000000'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const TTL_SECONDS = 1800
const RESEND_COOLDOWN_MS = 60_000
const MILLISECONDS_PER_SECOND = 1000
const PASSWORD_RESET_SUBJECT = 'Reset your password'

const ISSUE_OR_REFRESH = 'issueOrRefresh'
const EMAIL_SEND = 'email.send'

const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => GENERATED_ID }

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let resetRepo: InMemoryPasswordResetTokensRepository
let emailSender: IEmailSender
let issuer: PasswordResetIssuer
let useCase: RequestPasswordResetUseCase

function trackedRepo(): Pick<IPasswordResetTokensRepository, 'issueOrRefresh'> {
  return {
    issueOrRefresh: (params) => {
      callLog.push(ISSUE_OR_REFRESH)
      return resetRepo.issueOrRefresh(params)
    },
  }
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

beforeEach(() => {
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  resetRepo = new InMemoryPasswordResetTokensRepository()
  emailSender = {
    send: async (message) => {
      callLog.push(EMAIL_SEND)
      sent.push(message)
    },
  }
  issuer = new PasswordResetIssuer(
    emailSender,
    { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    TTL_SECONDS,
  )
  useCase = new RequestPasswordResetUseCase(
    usersRepository,
    trackedRepo(),
    issuer,
    clock,
    idGenerator,
    RESEND_COOLDOWN_MS,
    TTL_SECONDS,
  )
})

describe('RequestPasswordResetUseCase', () => {
  it('writes a token then sends the email, for an address with an account', async () => {
    storeUser()

    await useCase.execute({ email: EMAIL })

    // Whole log: kills a deleted send, a send before the write, and a spurious extra call.
    expect(callLog).toEqual([ISSUE_OR_REFRESH, EMAIL_SEND])
    expect(resetRepo.rows).toHaveLength(1)
    expect(resetRepo.rows[0]?.userId).toBe(USER_ID)
    expect(resetRepo.rows[0]?.tokenHash).toBe(`${DIGEST_PREFIX}${OPAQUE_TOKEN}`)
    expect(sent[0]?.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(sent[0]?.text).toContain(OPAQUE_TOKEN)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    storeUser()

    await useCase.execute({ email: EMAIL })

    expect(resetRepo.rows[0]?.id).toBe(GENERATED_ID)
    expect(resetRepo.rows[0]?.issuedAt).toEqual(NOW)
    expect(resetRepo.rows[0]?.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('does nothing at all for an address with no account', async () => {
    await useCase.execute({ email: UNKNOWN_EMAIL })

    expect(callLog).toEqual([])
    expect(resetRepo.rows).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('sends nothing when issueOrRefresh reports the cooldown is still active', async () => {
    storeUser()
    // Pre-seed a fresh row so the in-memory adapter's cooldown branch refuses.
    await resetRepo.issueOrRefresh({
      id: GENERATED_ID,
      userId: USER_ID,
      tokenHash: EARLIER_TOKEN_HASH,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      cooldownCutoff: new Date(NOW.getTime() - RESEND_COOLDOWN_MS),
    })
    callLog.length = 0

    await useCase.execute({ email: EMAIL })

    expect(callLog).toEqual([ISSUE_OR_REFRESH]) // attempted, refused, no send
    expect(sent).toHaveLength(0)
    expect(resetRepo.rows[0]?.tokenHash).toBe(EARLIER_TOKEN_HASH)
  })

  it('normalizes the email and uses the STORED address for the send', async () => {
    storeUser()

    await useCase.execute({ email: MIXED_CASE_EMAIL })

    expect(sent[0]?.to).toBe(EMAIL)
  })

  it('resolves with nothing, the same way, whether or not the address has an account', async () => {
    storeUser()
    const withAccount = await useCase.execute({ email: EMAIL })
    const withoutAccount = await useCase.execute({ email: UNKNOWN_EMAIL })

    expect(withAccount).toBe(withoutAccount)
    expect(withAccount).toBeUndefined()
  })

  it('rejects an invalid email before any lookup', async () => {
    await expect(useCase.execute({ email: INVALID_EMAIL })).rejects.toBeInstanceOf(
      InvalidEmailError,
    )
    expect(callLog).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('passes issueOrRefresh a cooldownCutoff of now minus the cooldown', async () => {
    storeUser()
    let seenCutoff: Date | undefined
    const spyRepo: Pick<IPasswordResetTokensRepository, 'issueOrRefresh'> = {
      issueOrRefresh: (params) => {
        seenCutoff = params.cooldownCutoff
        return resetRepo.issueOrRefresh(params)
      },
    }
    const spied = new RequestPasswordResetUseCase(
      usersRepository,
      spyRepo,
      issuer,
      clock,
      idGenerator,
      RESEND_COOLDOWN_MS,
      TTL_SECONDS,
    )

    await spied.execute({ email: EMAIL })

    expect(seenCutoff).toEqual(new Date(NOW.getTime() - RESEND_COOLDOWN_MS))
  })
})
