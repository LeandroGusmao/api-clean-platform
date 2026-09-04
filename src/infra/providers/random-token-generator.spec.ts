import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPAQUE_TOKEN_BYTES,
  RandomTokenGenerator,
} from '#infra/providers/random-token-generator'

const SAMPLE_SIZE = 200
const SMALLER_BYTES = 16
const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/

/** 32 bytes in base64url is 43 characters, with no padding. */
const DEFAULT_ENCODED_LENGTH = 43
const EXPECTED_DEFAULT_BYTES = 32

describe('RandomTokenGenerator', () => {
  it('never repeats a value across a large sample', () => {
    const generator = new RandomTokenGenerator()

    const values = new Set(Array.from({ length: SAMPLE_SIZE }, () => generator.opaque()))

    expect(values.size).toBe(SAMPLE_SIZE)
  })

  it('encodes as base64url, so the value is safe in a cookie and in a URL', () => {
    // `+`, `/` and `=` are what plain base64 would add. A `+` in a cookie value
    // is decoded as a space by some clients, which would silently corrupt the
    // token on the way back.
    expect(new RandomTokenGenerator().opaque()).toMatch(BASE64URL_ONLY)
  })

  it('defaults to 32 bytes of entropy', () => {
    expect(DEFAULT_OPAQUE_TOKEN_BYTES).toBe(EXPECTED_DEFAULT_BYTES)
    expect(new RandomTokenGenerator().opaque()).toHaveLength(DEFAULT_ENCODED_LENGTH)
  })

  it('honours a requested size', () => {
    const shorter = new RandomTokenGenerator().opaque(SMALLER_BYTES)

    expect(shorter.length).toBeLessThan(DEFAULT_ENCODED_LENGTH)
  })
})

const CODE_DIGITS = 6
const SAMPLE_SIZE_NUMERIC_CODE = 500
const DIGITS_ONLY_PATTERN = /^[0-9]+$/

describe('numericCode', () => {
  it('returns exactly the requested number of digits', () => {
    expect(new RandomTokenGenerator().numericCode(CODE_DIGITS)).toHaveLength(CODE_DIGITS)
  })

  it('returns digits only', () => {
    expect(new RandomTokenGenerator().numericCode(CODE_DIGITS)).toMatch(
      DIGITS_ONLY_PATTERN,
    )
  })

  // The bug this kills is real and silent: a naive `randomInt(...).toString()`
  // yields "42" for the value 42, and a five-character code is rejected by the
  // endpoint's schema — so roughly one signup in ten breaks, at random.
  it('keeps leading zeros, so a low draw is still a full-length code', () => {
    const generator = new RandomTokenGenerator()
    const codes = Array.from({ length: SAMPLE_SIZE_NUMERIC_CODE }, () =>
      generator.numericCode(CODE_DIGITS),
    )

    expect(codes.every((code) => code.length === CODE_DIGITS)).toBe(true)
  })
})
