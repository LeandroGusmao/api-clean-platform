/** Claims the API reads back from a verified access token. */
export interface AccessTokenPayload {
  /** Subject: the authenticated user's id. */
  sub: string
}

/**
 * The stateless access token (decision 11). It does NOT produce the refresh
 * token: that one is opaque, persisted and revocable, and confusing the two is
 * how a design degenerates into the discarded stateless-only option.
 *
 * Claims: `sub`, `iat`, `exp`, plus the `iss` and `aud` that pin a token to one
 * deployment (decision 38). No `jti`, which only serves a denylist that
 * decision 11 refused, and no `auth_time`/`amr` until a route reads them: a
 * contract is born with what has a consumer.
 */
export interface ITokenSigner {
  sign(payload: AccessTokenPayload): Promise<string>
  /** Throws on any invalid, expired, forged or malformed token. */
  verify(token: string): Promise<AccessTokenPayload>
}
