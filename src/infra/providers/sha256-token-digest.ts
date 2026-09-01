import { createHash } from 'node:crypto'
import type { ITokenDigest } from '#shared/ports/token-digest'

const DIGEST_ALGORITHM = 'sha256'
const DIGEST_ENCODING = 'hex'

/**
 * The digest that makes `token_hash` indexable. Read the port's comment before
 * changing this to anything with a salt.
 */
export class Sha256TokenDigest implements ITokenDigest {
  hash(value: string): string {
    return createHash(DIGEST_ALGORITHM).update(value).digest(DIGEST_ENCODING)
  }
}
