import { randomBytes, randomInt } from 'node:crypto'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** 256 bits — the size of an opaque refresh token. */
export const DEFAULT_OPAQUE_TOKEN_BYTES = 32

/**
 * Not plain base64: a `+` in a cookie value is decoded as a space by some
 * clients, and `=` padding needs escaping in a URL. base64url has neither.
 */
const TOKEN_ENCODING = 'base64url'

const DECIMAL_BASE = 10
const PAD_CHARACTER = '0'

export class RandomTokenGenerator implements ITokenGenerator {
  opaque(bytes: number = DEFAULT_OPAQUE_TOKEN_BYTES): string {
    return randomBytes(bytes).toString(TOKEN_ENCODING)
  }

  numericCode(digits: number): string {
    // `randomInt` is rejection-sampled by Node, so the distribution is uniform
    // over the whole range — unlike `randomBytes` reduced with `%`.
    const exclusiveUpperBound = DECIMAL_BASE ** digits

    return randomInt(exclusiveUpperBound).toString().padStart(digits, PAD_CHARACTER)
  }
}
