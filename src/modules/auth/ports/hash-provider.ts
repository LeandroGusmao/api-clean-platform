export interface IHashProvider {
  /** The result encodes its own parameters and salt. */
  hash(plain: string): Promise<string>

  compare(plain: string, hashed: string): Promise<boolean>

  /**
   * A hash produced with THIS provider's own parameters, to compare against
   * when there is no user. Without it, a missing email returns before paying
   * the hashing cost and the response time itself answers "does this account
   * exist?".
   *
   * It lives on the provider rather than as a literal in the use case so that
   * tuning the cost re-equalizes automatically: a constant in the pure layer
   * would silently stop matching, and no test would notice.
   */
  readonly dummyHash: string
}
