import { jwtVerify, SignJWT } from 'jose'
import type { AuthConfig } from '#modules/auth/config'
import type {
  AccessTokenPayload,
  ITokenSigner,
} from '#modules/auth/providers/token-signer'
import type { IClock } from '#shared/providers/clock'

const ALGORITHM = 'HS256'
const MILLISECONDS_PER_SECOND = 1000
const MISSING_SUBJECT_MESSAGE = 'Access token is missing a subject'

/**
 * HS256 through `jose`, whose only dependency is none and which is ESM-native.
 *
 * `@fastify/jwt` was not an option: it would tie token issuance to Fastify, and
 * decision 10 requires the dependency graph to be built without an HTTP
 * framework so that a worker and a cron can share it.
 */
export class JwtTokenSigner implements ITokenSigner {
  readonly #secret: Uint8Array
  readonly #ttlSeconds: number
  readonly #clock: IClock

  constructor(config: AuthConfig, clock: IClock) {
    this.#secret = new TextEncoder().encode(config.JWT_SECRET)
    this.#ttlSeconds = config.ACCESS_TOKEN_TTL_SECONDS
    this.#clock = clock
  }

  async sign(payload: AccessTokenPayload): Promise<string> {
    const issuedAt = Math.floor(this.#clock.now().getTime() / MILLISECONDS_PER_SECOND)

    return new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(payload.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.#ttlSeconds)
      .sign(this.#secret)
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    const { payload } = await jwtVerify(token, this.#secret, {
      // Load-bearing, not decoration: verified that a token signed HS512 with
      // this same secret verifies WITHOUT the pin. Covered by the
      // "rejects a token signed with a different algorithm" test above.
      algorithms: [ALGORITHM],
      // Without this, jose checks `exp` against its own clock and the injected
      // one would only affect signing.
      currentDate: this.#clock.now(),
    })

    if (typeof payload.sub !== 'string') throw new Error(MISSING_SUBJECT_MESSAGE)

    return { sub: payload.sub }
  }
}
