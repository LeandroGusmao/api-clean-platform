import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthConfig } from '#modules/auth/config'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import type {
  GoogleIdentity,
  IGoogleIdentityVerifier,
} from '#modules/auth/ports/google-identity-verifier'

/**
 * The two issuer strings Google actually stamps on an ID token. A closed set and
 * a Google fact, so it stays a constant here rather than an env var.
 */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/**
 * Verifies a Google ID token against Google's published signing keys. No client
 * secret: this is public-key crypto. `createRemoteJWKSet` fetches and caches the
 * key set itself (honouring `Cache-Control`), so this is the app's first
 * outbound dependency but not a hand-rolled HTTP client.
 *
 * Takes the SLICE of config it reads, like `JwtTokenSigner` — a variable added
 * elsewhere cannot break this class by merely existing, and the integration
 * test points `GOOGLE_JWKS_URI` at a local JWKS server.
 */
export class JoseGoogleIdentityVerifier implements IGoogleIdentityVerifier {
  readonly #clientId: string
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(config: Pick<AuthConfig, 'GOOGLE_CLIENT_ID' | 'GOOGLE_JWKS_URI'>) {
    this.#clientId = config.GOOGLE_CLIENT_ID
    this.#jwks = createRemoteJWKSet(new URL(config.GOOGLE_JWKS_URI))
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.#jwks, {
        issuer: GOOGLE_ISSUERS,
        // Load-bearing, not decoration: without the audience pin, a token minted
        // for any other Google client id would verify here. Covered by the
        // "different client id" regression test.
        audience: this.#clientId,
      })

      if (payload.email_verified !== true) throw new InvalidGoogleIdentityError()
      if (typeof payload.email !== 'string') throw new InvalidGoogleIdentityError()
      if (typeof payload.sub !== 'string') throw new InvalidGoogleIdentityError()

      return { subject: payload.sub, email: payload.email }
    } catch {
      // One error for every failure mode — see `InvalidGoogleIdentityError`.
      throw new InvalidGoogleIdentityError()
    }
  }
}
