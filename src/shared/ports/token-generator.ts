/**
 * The only source of cryptographic randomness the pure layer may use (R7).
 *
 * Deliberately separate from `ITokenDigest`, and from `IIdGenerator` before it:
 * minting a secret, making a secret findable, and naming an entity change for
 * different reasons. Bundling them would hand a use case that only wants an id
 * a port that also mints secrets.
 */
export interface ITokenGenerator {
  /**
   * An unguessable opaque value, for refresh tokens and anything else that must
   * carry entropy and no meaning. The encoding is the adapter's business.
   */
  opaque(bytes?: number): string

  /**
   * A uniformly random decimal code of exactly `digits` digits, leading zeros
   * included, for values a human types back into an app.
   *
   * Uniform is the load-bearing word, and it is why this belongs to the port
   * rather than to the caller: deriving a code from `opaque()` with `%` would
   * bias the low digits, because 256 is not a multiple of 10. The adapter is the
   * only place allowed to know that.
   *
   * NOT a replacement for `opaque`. Six digits carry ~20 bits: safe only behind
   * a short TTL and an attempt cap, never as a bearer secret.
   */
  numericCode(digits: number): string
}
