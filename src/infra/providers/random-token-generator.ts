import { randomBytes } from 'node:crypto'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** 256 bits — the size decision 11 gives the refresh token. */
export const DEFAULT_OPAQUE_TOKEN_BYTES = 32

/**
 * Not plain base64: a `+` in a cookie value is decoded as a space by some
 * clients, and `=` padding needs escaping in a URL. base64url has neither.
 */
const TOKEN_ENCODING = 'base64url'

export class RandomTokenGenerator implements ITokenGenerator {
  opaque(bytes: number = DEFAULT_OPAQUE_TOKEN_BYTES): string {
    return randomBytes(bytes).toString(TOKEN_ENCODING)
  }
}
