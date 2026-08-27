import { hash } from '@node-rs/argon2'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'

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
  hash(plain: string): Promise<string> {
    return hash(plain)
  }
}
