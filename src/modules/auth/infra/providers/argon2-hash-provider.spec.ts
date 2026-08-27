import { describe, expect, it } from 'vitest'
import { Argon2HashProvider } from '#modules/auth/infra/providers/argon2-hash-provider'

const PASSWORD = 'sup3r-s3cr3t!'
// Pins the work factor, not just the algorithm. The library's default is
// OWASP's second recommended argon2id profile; a dependency bump that lowers
// it would otherwise pass every test and weaken hashing silently.
const EXPECTED_ARGON2_PARAMETERS = '$argon2id$v=19$m=19456,t=2,p=1'

const PHC_SEPARATOR = '$'
// `$argon2id$v=19$m=..,t=..,p=..$<salt>$<hash>` — a leading empty segment, so
// the salt lands at index 4.
const PHC_SALT_SEGMENT_INDEX = 4
const UNEXPECTED_HASH_FORMAT_MESSAGE = 'the hash is not a PHC string'

function saltOf(phcHash: string): string {
  const salt = phcHash.split(PHC_SEPARATOR)[PHC_SALT_SEGMENT_INDEX]
  // `noUncheckedIndexedAccess` is on, and the guard matters beyond the type:
  // comparing two `undefined`s with `not.toBe` would pass vacuously.
  if (salt === undefined) throw new Error(UNEXPECTED_HASH_FORMAT_MESSAGE)
  return salt
}

// Real argon2 work, roughly 100ms per call. Three calls is the whole cost.
describe('Argon2HashProvider', () => {
  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await new Argon2HashProvider().hash(PASSWORD)

    // The full parameter prefix is what pins the algorithm AND its cost: the
    // exact version pin freezes the library's default, but nothing short of
    // asserting on `m=`, `t=` and `p=` would catch that default silently
    // changing underneath a future dependency bump.
    expect(hash.startsWith(EXPECTED_ARGON2_PARAMETERS)).toBe(true)
    expect(hash).not.toContain(PASSWORD)
  })

  it('uses a fresh salt on every call', async () => {
    const provider = new Argon2HashProvider()

    const first = await provider.hash(PASSWORD)
    const second = await provider.hash(PASSWORD)

    // Comparing whole hashes would only show the output varies. Comparing the
    // salt segment shows WHICH field varies, which is the actual claim.
    expect(saltOf(first)).not.toBe(saltOf(second))
  })
})
