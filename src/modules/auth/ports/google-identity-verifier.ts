/** What the app trusts from a verified Google ID token. */
export interface GoogleIdentity {
  /** Google's `sub` — stable, unique per Google account, never reassigned. */
  subject: string
  /** Already asserted as verified by Google; the adapter throws otherwise. */
  email: string
}

export interface IGoogleIdentityVerifier {
  /**
   * Throws `InvalidGoogleIdentityError` on any invalid, forged, expired,
   * wrong-audience, wrong-issuer, or unverified-email token.
   */
  verify(idToken: string): Promise<GoogleIdentity>
}
