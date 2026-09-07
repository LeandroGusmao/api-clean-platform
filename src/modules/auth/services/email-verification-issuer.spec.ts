import { describe, expect, it } from 'vitest'
import type { EmailVerification } from '#modules/auth/entities/email-verification'
import { User } from '#modules/auth/entities/user'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

const INVALIDATE = 'invalidateActiveForUser'
const SAVE = 'save'
const SEND = 'send'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const VERIFICATION_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'hashed:sup3r-s3cr3t!'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const TTL_SECONDS = 900

/** A fixed digit string — this suite tests wiring, not `ITokenGenerator` uniformity. */
const CODE = '024680'
const DIGEST_PREFIX = 'digest:'

/** Unused by this suite; required only to satisfy `ITokenGenerator`'s shape. */
const OPAQUE_NOT_USED_MESSAGE = 'opaque() is unused by EmailVerificationIssuer tests'

const CODE_IN_TEXT_PATTERN = /Your verification code is (\d{6})\./

/** Pulls the plaintext code back out of the rendered email body. */
function extractCode(text: string): string {
  const match = CODE_IN_TEXT_PATTERN.exec(text)
  if (match === null) throw new Error('no verification code found in email text')
  return match[1] as string
}

const user = User.create({
  id: USER_ID,
  email: Email.create(EMAIL),
  passwordHash: PASSWORD_HASH,
  now: NOW,
})

// A deterministic digest, shared between the issuer under test and the
// assertion in "emails the code in plaintext but persists only its digest" —
// both must derive the digest the same way for that assertion to mean anything.
const fakeDigest: ITokenDigest = {
  hash: (value) => `${DIGEST_PREFIX}${value}`,
}

/**
 * Fresh doubles per test. `callLog` is the point of this file: it is what lets
 * a test assert ORDER, and order is exactly what `issueFor`'s contract is
 * about — invalidate, then persist, then (only once the caller asks) send.
 */
function makeIssuer() {
  const callLog: string[] = []
  const saved: EmailVerification[] = []
  const sent: EmailMessage[] = []

  const verifications: IEmailVerificationsRepository = {
    save: async (verification) => {
      callLog.push(SAVE)
      saved.push(verification)
    },
    findActiveByUserId: async () => null,
    invalidateActiveForUser: async () => {
      callLog.push(INVALIDATE)
    },
    registerFailedAttempt: async () => false,
    consume: async () => false,
  }

  const emailSender: IEmailSender = {
    send: async (message) => {
      callLog.push(SEND)
      sent.push(message)
    },
  }

  const tokenGenerator: ITokenGenerator = {
    opaque: () => {
      throw new Error(OPAQUE_NOT_USED_MESSAGE)
    },
    numericCode: () => CODE,
  }

  const idGenerator: IIdGenerator = { generate: () => VERIFICATION_ID }

  const issuer = new EmailVerificationIssuer(
    emailSender,
    tokenGenerator,
    fakeDigest,
    idGenerator,
    TTL_SECONDS,
  )

  return { issuer, verifications, callLog, sent, saved }
}

describe('EmailVerificationIssuer', () => {
  it('invalidates the previous code BEFORE persisting the new one, and does NOT send while issuing', async () => {
    const { issuer, verifications, callLog } = makeIssuer()

    await issuer.issueFor(user, verifications, NOW)

    // `toEqual` on the FULL log, not `toContain`: this single assertion kills
    // four separate bugs — a deleted send, a send moved inside `issueFor`
    // (which would append SEND here), the two writes swapped, and a send
    // happening before the caller ever calls the returned thunk — where a
    // partial assertion would catch none of them.
    expect(callLog).toEqual([INVALIDATE, SAVE])
  })

  it('sends only when the returned thunk is called', async () => {
    const { issuer, verifications, callLog } = makeIssuer()

    const deliver = await issuer.issueFor(user, verifications, NOW)
    await deliver()

    expect(callLog).toEqual([INVALIDATE, SAVE, SEND])
  })

  it('emails the code in plaintext but persists only its digest', async () => {
    const { issuer, verifications, sent, saved } = makeIssuer()

    const deliver = await issuer.issueFor(user, verifications, NOW)
    await deliver()

    const code = extractCode(sent[0]?.text ?? '')
    expect(saved[0]?.codeHash).toBe(fakeDigest.hash(code))
    expect(sent[0]?.text).not.toContain(saved[0]?.codeHash)
  })
})

describe('EmailVerificationIssuer.issue', () => {
  it('returns the digest of a fresh code and persists nothing, sends nothing, until the thunk is called', async () => {
    const { issuer, callLog, saved } = makeIssuer()

    const { codeHash, deliver } = issuer.issue(Email.create(EMAIL))

    expect(saved).toHaveLength(0)
    expect(callLog).toEqual([])
    expect(codeHash).toBe(fakeDigest.hash(CODE))

    await deliver()
    expect(callLog).toEqual([SEND])
  })

  it('emails the plaintext code to the given address, never its digest', async () => {
    const { issuer, sent } = makeIssuer()

    const { codeHash, deliver } = issuer.issue(Email.create(EMAIL))
    await deliver()

    expect(extractCode(sent[0]?.text ?? '')).toBe(CODE)
    expect(sent[0]?.text).not.toContain(codeHash)
    expect(sent[0]?.to).toBe(EMAIL)
  })
})
