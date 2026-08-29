import { hash, hashSync, verify } from '@node-rs/argon2'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'

/** Never a real password: this value only ever loses a comparison. */
const DUMMY_PLAINTEXT = 'no account matches this comparison'

/**
 * Computed once per process, at import: `hashSync` emits the same `m`/`t`/`p`
 * as the async `hash`, so the decoy tracks this adapter's cost automatically
 * whenever those parameters are retuned. This is what it is for: a login
 * attempt for an email with no account should cost the same as one with a
 * wrong password, instead of the response time itself answering "does this
 * account exist?".
 */
const DUMMY_HASH = hashSync(DUMMY_PLAINTEXT)

/**
 * argon2id, through @node-rs/argon2's prebuilt Rust bindings — no node-gyp and
 * no C++ toolchain in Docker or CI, which is why it wins over the `argon2`
 * package.
 *
 * The library's default algorithm IS argon2id, and pinning the exact version
 * freezes that default: it cannot change without a bump we control.
 *
 * Cost parameters (memory, time, parallelism) stay at the library's defaults.
 * Tuning them belongs to hardening, once there is a target machine.
 */
export class Argon2HashProvider implements IHashProvider {
  readonly dummyHash = DUMMY_HASH

  hash(plain: string): Promise<string> {
    return hash(plain)
  }

  /** Argument order follows decision 21, which is the reverse of the library's. */
  compare(plain: string, hashed: string): Promise<boolean> {
    return verify(hashed, plain)
  }
}
