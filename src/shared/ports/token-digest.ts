/**
 * A deterministic digest of an opaque value, so the value can be found through
 * a unique index.
 *
 * NEVER a password hash. Argon2 salts randomly, so `WHERE token_hash = ?` would
 * never match, and the lookup would degenerate into scanning the table running
 * argon2 per row — a CPU denial-of-service vector on an endpoint a mobile app
 * calls every hour. An opaque token already carries 256 bits of entropy; what
 * it needs is a deterministic digest, not key stretching.
 *
 * That is why this is a port of its own rather than a method on
 * `IHashProvider`: the two must not be reachable from the same object.
 */
export interface ITokenDigest {
  hash(value: string): string
}
