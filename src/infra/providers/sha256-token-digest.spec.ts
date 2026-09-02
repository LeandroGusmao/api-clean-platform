import { describe, expect, it } from 'vitest'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'

const TOKEN = 'an-opaque-refresh-token'
const OTHER_TOKEN = 'another-opaque-refresh-token'

/** sha256 in hex is always 64 characters. */
const HEX_DIGEST_LENGTH = 64

describe('Sha256TokenDigest', () => {
  it('is deterministic, which is what makes the column indexable', () => {
    // The whole point, and the reason argon2 is wrong here: a random salt would
    // make `WHERE token_hash = ?` never match, and the lookup would degenerate
    // into scanning the table hashing every row.
    const digest = new Sha256TokenDigest()

    expect(digest.hash(TOKEN)).toBe(digest.hash(TOKEN))
  })

  it('separates different tokens', () => {
    const digest = new Sha256TokenDigest()

    expect(digest.hash(TOKEN)).not.toBe(digest.hash(OTHER_TOKEN))
  })

  it('never returns the token itself', () => {
    const hashed = new Sha256TokenDigest().hash(TOKEN)

    expect(hashed).not.toContain(TOKEN)
    expect(hashed).toHaveLength(HEX_DIGEST_LENGTH)
  })
})
