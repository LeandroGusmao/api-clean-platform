import { createServer, type Server } from 'node:http'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'

const RS256 = 'RS256'
/** One of the two values the adapter pins as a Google issuer. */
export const GOOGLE_TEST_ISSUER = 'https://accounts.google.com'

const HOST = '127.0.0.1'
const ANY_FREE_PORT = 0
const JWKS_CONTENT_TYPE = 'application/json'
const OK_STATUS = 200
const KEY_ID = 'test-key-1'
const OTHER_KEY_ID = 'test-key-2'
const DEFAULT_EMAIL = 'ana@example.com'
const DEFAULT_SUBJECT = 'google-subject-1234567890'
const TOKEN_LIFETIME = '5m'

export interface GoogleJwksServer {
  /** Pass as `GOOGLE_JWKS_URI`. */
  url: string
  /** Signs an ID token with the served key. `claims` overrides the defaults. */
  sign(claims?: Record<string, unknown>): Promise<string>
  /** Signs with a key that is NOT in the served set — for the bad-signature case. */
  signWithForeignKey(claims?: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

export async function startGoogleJwksServer(audience: string): Promise<GoogleJwksServer> {
  const served = await generateKeyPair(RS256)
  const foreign = await generateKeyPair(RS256)

  const publicJwk = (await exportJWK(served.publicKey)) as JWK
  publicJwk.kid = KEY_ID
  publicJwk.alg = RS256
  publicJwk.use = 'sig'

  const body = JSON.stringify({ keys: [publicJwk] })

  const server: Server = createServer((_request, response) => {
    response.writeHead(OK_STATUS, { 'content-type': JWKS_CONTENT_TYPE })
    response.end(body)
  })

  await new Promise<void>((resolve) => server.listen(ANY_FREE_PORT, HOST, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('JWKS test server did not bind a port')
  }
  const url = `http://${HOST}:${address.port}/`

  const baseClaims = (claims: Record<string, unknown>) => ({
    iss: GOOGLE_TEST_ISSUER,
    aud: audience,
    email: DEFAULT_EMAIL,
    email_verified: true,
    sub: DEFAULT_SUBJECT,
    ...claims,
  })

  // `setExpirationTime` overrides any `exp` in the payload, so let an explicit
  // `exp` claim (the expired-token case) win by skipping the helper's default.
  type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
  const build = (
    claims: Record<string, unknown>,
    kid: string,
    key: SigningKey,
  ): Promise<string> => {
    const jwt = new SignJWT(baseClaims(claims))
      .setProtectedHeader({ alg: RS256, kid })
      .setIssuedAt()
    if (!('exp' in claims)) jwt.setExpirationTime(TOKEN_LIFETIME)
    return jwt.sign(key)
  }

  return {
    url,
    async sign(claims = {}) {
      return build(claims, KEY_ID, served.privateKey)
    },
    async signWithForeignKey(claims = {}) {
      return build(claims, OTHER_KEY_ID, foreign.privateKey)
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
