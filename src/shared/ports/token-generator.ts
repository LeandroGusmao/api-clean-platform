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
}
