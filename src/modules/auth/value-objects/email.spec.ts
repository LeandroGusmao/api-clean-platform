import { describe, expect, it } from 'vitest'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { Email, MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'

const VALID_EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const LOCAL_PART = 'a'.repeat(MAX_EMAIL_LENGTH)
const EMAIL_DOMAIN = '@example.com'

/** A well-formed address of exactly `length` characters. */
function emailOfLength(length: number): string {
  return `${'a'.repeat(length - EMAIL_DOMAIN.length)}${EMAIL_DOMAIN}`
}

describe('Email.create', () => {
  it('trims and lowercases, so the value matches the lower(email) index', () => {
    expect(Email.create(MIXED_CASE_EMAIL).value).toBe(VALID_EMAIL)
  })

  it('accepts a plain address', () => {
    expect(Email.create(VALID_EMAIL).value).toBe(VALID_EMAIL)
  })

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['no at sign', 'joao.example.com'],
    ['two at signs', 'joao@ex@ample.com'],
    ['empty local part', '@example.com'],
    ['empty domain', 'joao@'],
    ['inner whitespace', 'jo ao@example.com'],
    ['longer than the cap', `${LOCAL_PART}@example.com`],
  ])('rejects %s', (_label, raw) => {
    expect(() => Email.create(raw)).toThrow(InvalidEmailError)
  })

  it('accepts an address of exactly the maximum length', () => {
    const atMaximum = emailOfLength(MAX_EMAIL_LENGTH)

    expect(Email.create(atMaximum).value).toBe(atMaximum)
  })

  it('rejects an address one character longer than the maximum', () => {
    const aboveMaximum = emailOfLength(MAX_EMAIL_LENGTH + 1)

    expect(() => Email.create(aboveMaximum)).toThrow(InvalidEmailError)
  })
})

describe('Email.fromTrusted', () => {
  it('skips validation, so a stricter future rule cannot break stored rows', () => {
    const stored = 'legacy@@value'

    expect(Email.fromTrusted(stored).value).toBe(stored)
  })
})

describe('Email.equals', () => {
  it('compares by value, not by identity', () => {
    expect(Email.create(VALID_EMAIL).equals(Email.create(MIXED_CASE_EMAIL))).toBe(true)
  })
})
