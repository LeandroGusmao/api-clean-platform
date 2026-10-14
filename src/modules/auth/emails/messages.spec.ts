import { describe, expect, it } from 'vitest'
import {
  accountDeletedEmail,
  googleAccountLinkedEmail,
  passwordResetCompletedEmail,
  passwordResetEmail,
  reuseDetectedEmail,
} from '#modules/auth/emails/messages'
import { Email } from '#modules/auth/value-objects/email'

const TO = Email.fromTrusted('joao@example.com')
const TOKEN = 'a-256-bit-opaque-token-value-base64url-xyz'
const TTL_SECONDS = 1800
const TTL_MINUTES = 30

describe('passwordResetEmail', () => {
  it('addresses the owner and carries the raw token and the ttl in minutes', () => {
    const message = passwordResetEmail(TO, TOKEN, TTL_SECONDS)

    expect(message.to).toBe(TO.value)
    expect(message.text).toContain(TOKEN)
    expect(message.text).toContain(String(TTL_MINUTES))
  })
})

describe('passwordResetCompletedEmail', () => {
  it('tells the owner every session was signed out and how to react', () => {
    const message = passwordResetCompletedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('reset')
    expect(message.text.toLowerCase()).toContain('sign')
  })
})

describe('googleAccountLinkedEmail', () => {
  it('addresses the owner and tells them how to react', () => {
    const message = googleAccountLinkedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('google')
    expect(message.text.toLowerCase()).toContain('reset your password')
  })
})

describe('accountDeletedEmail', () => {
  it('addresses the owner and says the account is gone for good', () => {
    const message = accountDeletedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('deleted')
    expect(message.text.toLowerCase()).toContain('cannot be undone')
  })
})

const REUSE_DEVICE = 'Chrome on Android'
const REUSE_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')
const REUSE_IP = '198.51.100.42'
const UNKNOWN_ADDRESS_TEXT = 'an unrecognized address'
const FORBIDDEN_CLAIMS = ['stolen', 'theft', 'null', 'undefined']

const knownSession = {
  deviceLabel: REUSE_DEVICE,
  sessionStartedAt: REUSE_STARTED_AT,
  ip: REUSE_IP,
}

describe('reuseDetectedEmail', () => {
  it('addresses the owner and names the session and the address of the attempt', () => {
    const message = reuseDetectedEmail(TO, knownSession)

    expect(message.to).toBe(TO.value)
    expect(message.text).toContain(REUSE_DEVICE)
    expect(message.text).toContain(REUSE_STARTED_AT.toISOString())
    expect(message.text).toContain(REUSE_IP)
  })

  it('tells the owner what to do in both cases: not recognised, and it was them', () => {
    const text = reuseDetectedEmail(TO, knownSession).text.toLowerCase()

    expect(text).toContain('reset your password')
    expect(text).toContain('sign in again')
  })

  it('says suspicious, never that anything was stolen', () => {
    const text = reuseDetectedEmail(TO, knownSession).text.toLowerCase()

    expect(text).toContain('suspicious')
    for (const claim of FORBIDDEN_CLAIMS) expect(text).not.toContain(claim)
  })

  it('falls back to neutral wording for an address that did not parse', () => {
    const message = reuseDetectedEmail(TO, {
      deviceLabel: REUSE_DEVICE,
      sessionStartedAt: REUSE_STARTED_AT,
      ip: null,
    })

    expect(message.text).toContain(REUSE_DEVICE)
    expect(message.text).toContain(UNKNOWN_ADDRESS_TEXT)
    for (const claim of FORBIDDEN_CLAIMS) {
      expect(message.text.toLowerCase()).not.toContain(claim)
    }
  })
})
