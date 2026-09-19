import { describe, expect, it } from 'vitest'
import {
  accountDeletedEmail,
  googleAccountLinkedEmail,
  passwordResetCompletedEmail,
  passwordResetEmail,
} from '#modules/auth/notifications/emails'
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
