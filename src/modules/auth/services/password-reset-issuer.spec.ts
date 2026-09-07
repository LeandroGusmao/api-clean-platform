import { beforeEach, describe, expect, it } from 'vitest'
import { PasswordResetIssuer } from '#modules/auth/services/password-reset-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const EMAIL = Email.fromTrusted('joao@example.com')
const OPAQUE_TOKEN = 'opaque-256-bit-token'
const DIGEST_PREFIX = 'digest:'
const TTL_SECONDS = 1800
const PASSWORD_RESET_SUBJECT = 'Reset your password'

let sent: EmailMessage[]
let emailSender: IEmailSender
let issuer: PasswordResetIssuer

beforeEach(() => {
  sent = []
  emailSender = {
    send: async (message) => {
      sent.push(message)
    },
  }
  issuer = new PasswordResetIssuer(
    emailSender,
    { opaque: () => OPAQUE_TOKEN, numericCode: () => '000000' },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    TTL_SECONDS,
  )
})

describe('PasswordResetIssuer', () => {
  it('returns the digest of a freshly minted opaque token and defers the send', () => {
    const { tokenHash, deliver } = issuer.issue(EMAIL)

    expect(tokenHash).toBe(`${DIGEST_PREFIX}${OPAQUE_TOKEN}`)
    // Nothing sent yet — the caller persists first, then awaits deliver().
    expect(sent).toHaveLength(0)
    expect(typeof deliver).toBe('function')
  })

  it('sends the reset email with the RAW token when deliver() is awaited', async () => {
    const { deliver } = issuer.issue(EMAIL)

    await deliver()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL.value)
    expect(sent[0]?.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(sent[0]?.text).toContain(OPAQUE_TOKEN)
  })
})
