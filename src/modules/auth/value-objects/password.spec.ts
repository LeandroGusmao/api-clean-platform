import { describe, expect, it } from 'vitest'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  Password,
} from '#modules/auth/value-objects/password'

const VALID_PASSWORD = 'sup3r-s3cr3t!'
const PADDED_PASSWORD = '  sup3r-s3cr3t!  '
// One letter, one digit, one special character — satisfies the whole policy
// in the fewest characters, so it doubles as padding filler for boundary tests.
const POLICY_SEED = 'aB1!'
const TOO_SHORT = POLICY_SEED
const TOO_LONG = POLICY_SEED.repeat(MAX_PASSWORD_LENGTH)
const EMPTY_SERIALIZATION = '{}'

/** A policy-satisfying password of exactly `length` characters. */
function passwordOfLength(length: number): string {
  return `${POLICY_SEED}${'x'.repeat(length - POLICY_SEED.length)}`
}

describe('Password.create', () => {
  it('accepts a password that satisfies every rule', () => {
    expect(Password.create(VALID_PASSWORD).value).toBe(VALID_PASSWORD)
  })

  it('does not trim: an edge space is a valid password character', () => {
    expect(Password.create(PADDED_PASSWORD).value).toBe(PADDED_PASSWORD)
  })

  it('accepts a newline, which the `s` flag on the policy pattern allows', () => {
    // Without the flag `.` never crosses `\n`, and the anchored lookaheads
    // would reject a password that satisfies the whole policy.
    const withNewline = 'abc\n123!'

    expect(Password.create(withNewline).value).toBe(withNewline)
  })

  it.each([
    ['shorter than the minimum', TOO_SHORT],
    ['longer than the maximum', TOO_LONG],
    ['no letter', '12345678!'],
    ['no digit', 'abcdefgh!'],
    ['no special character', 'abcdefgh1'],
  ])('rejects a password with %s', (_label, raw) => {
    expect(() => Password.create(raw)).toThrow(InvalidPasswordError)
  })

  it('accepts exactly the minimum length', () => {
    const atMinimum = passwordOfLength(MIN_PASSWORD_LENGTH)

    expect(Password.create(atMinimum).value).toBe(atMinimum)
  })

  it('rejects a password one character shorter than the minimum', () => {
    const belowMinimum = passwordOfLength(MIN_PASSWORD_LENGTH - 1)

    expect(() => Password.create(belowMinimum)).toThrow(InvalidPasswordError)
  })

  it('accepts exactly the maximum length', () => {
    const atMaximum = passwordOfLength(MAX_PASSWORD_LENGTH)

    expect(Password.create(atMaximum).value).toBe(atMaximum)
  })

  it('rejects a password one character longer than the maximum', () => {
    const aboveMaximum = passwordOfLength(MAX_PASSWORD_LENGTH + 1)

    expect(() => Password.create(aboveMaximum)).toThrow(InvalidPasswordError)
  })
})

describe('Password serialization', () => {
  it('never leaks the plaintext through JSON', () => {
    // The `#` field is non-enumerable, so this holds even if someone logs the
    // whole object.
    expect(JSON.stringify(Password.create(VALID_PASSWORD))).toBe(EMPTY_SERIALIZATION)
  })
})
