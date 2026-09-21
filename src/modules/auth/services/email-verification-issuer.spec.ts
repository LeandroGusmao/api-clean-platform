import { describe, expect, it } from 'vitest'
import { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

const SEND = 'send'

const EMAIL = 'joao@example.com'
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

// A deterministic digest, shared between the issuer under test and the
// assertions below — both must derive the digest the same way for those to mean
// anything.
const fakeDigest: ITokenDigest = {
  hash: (value) => `${DIGEST_PREFIX}${value}`,
}

/**
 * Fresh doubles per test. `callLog` is what lets a test assert that nothing is
 * sent until the caller invokes the returned thunk.
 */
function makeIssuer() {
  const callLog: string[] = []
  const sent: EmailMessage[] = []

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

  const issuer = new EmailVerificationIssuer(
    emailSender,
    tokenGenerator,
    fakeDigest,
    TTL_SECONDS,
  )

  return { issuer, callLog, sent }
}

describe('EmailVerificationIssuer.issue', () => {
  it('returns the digest of a fresh code and sends nothing until the thunk is called', async () => {
    const { issuer, callLog } = makeIssuer()

    const { codeHash, deliver } = issuer.issue(Email.create(EMAIL))

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

  it('no longer exposes issueFor: the pending flow issues codes through issue()', () => {
    const { issuer } = makeIssuer()

    expect((issuer as unknown as Record<string, unknown>).issueFor).toBeUndefined()
  })
})
