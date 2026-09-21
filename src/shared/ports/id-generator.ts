/**
 * The only source of entity identity the pure layer may use (R7).
 *
 * Deliberately separate from the token generator port: an entity id and a
 * cryptographic secret have different security profiles and
 * different reasons to change. Moving ids from UUIDv4 to v7 has nothing to do
 * with the entropy of a refresh token, and bundling the two would hand a use
 * case that only wants an id a port that also mints secrets.
 */
export interface IIdGenerator {
  /** An opaque entity identifier. The format is the adapter's business. */
  generate(): string
}
