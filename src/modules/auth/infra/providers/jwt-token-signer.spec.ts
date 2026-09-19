import { jwtVerify, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import type { AuthConfig } from '#modules/auth/config'
import { JwtTokenSigner } from '#modules/auth/infra/providers/jwt-token-signer'
import type { IClock } from '#shared/ports/clock'

const SECRET = 'a-test-secret-with-at-least-32-chars'
const OTHER_SECRET = 'a-different-secret-with-32-chars-ok'
const ALGORITHM = 'HS256'
const OTHER_ALGORITHM = 'HS512'
/** Long enough that expiry never decides one of these cases. */
const FOREIGN_TOKEN_LIFETIME = '1h'
const TTL_SECONDS = 3600
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const ISSUER = 'api-clean-platform'
const AUDIENCE = 'api-clean-platform'
const OTHER_ISSUER = 'another-system'
const OTHER_AUDIENCE = 'another-audience'
const FIXED_NOW = new Date('2026-08-27T12:00:00.000Z')
const MILLISECONDS_PER_SECOND = 1000

/**
 * A one-method port becomes an object literal in the spec, per the convention
 * from the register slice: a fake file would land in `dist/`, since
 * `tsconfig.build.json` only excludes `*.spec.ts`.
 */
function makeClock(start: Date) {
  let current = start
  const clock: IClock = { now: () => new Date(current.getTime()) }

  return {
    clock,
    advanceSeconds(seconds: number) {
      current = new Date(current.getTime() + seconds * MILLISECONDS_PER_SECOND)
    },
  }
}

function makeConfig(
  secret = SECRET,
): Pick<
  AuthConfig,
  'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS' | 'JWT_ISSUER' | 'JWT_AUDIENCE'
> {
  return {
    JWT_SECRET: secret,
    ACCESS_TOKEN_TTL_SECONDS: TTL_SECONDS,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
  }
}

/** A token this system did not mint, shaped exactly like one it would. */
const foreignToken = (issuer: string | undefined, audience: string | undefined) => {
  let builder = new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime(FOREIGN_TOKEN_LIFETIME)

  if (issuer !== undefined) builder = builder.setIssuer(issuer)
  if (audience !== undefined) builder = builder.setAudience(audience)

  return builder.sign(new TextEncoder().encode(SECRET))
}

describe('JwtTokenSigner', () => {
  it('verifies a token it just signed', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    const token = await signer.sign({ sub: USER_ID })

    await expect(signer.verify(token)).resolves.toEqual({ sub: USER_ID })
  })

  it('accepts a token one second before it expires', async () => {
    const { clock, advanceSeconds } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)
    const token = await signer.sign({ sub: USER_ID })

    advanceSeconds(TTL_SECONDS - 1)

    await expect(signer.verify(token)).resolves.toEqual({ sub: USER_ID })
  })

  it('rejects a token past its expiry', async () => {
    // The clock reaches `jwtVerify` through `currentDate`. Without that option
    // jose would check `exp` against its own `Date.now()`, and this test would
    // need a real one-hour wait.
    const { clock, advanceSeconds } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)
    const token = await signer.sign({ sub: USER_ID })

    advanceSeconds(TTL_SECONDS + 1)

    await expect(signer.verify(token)).rejects.toThrow()
  })

  it('rejects a token signed with a different secret', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const token = await new JwtTokenSigner(makeConfig(OTHER_SECRET), clock).sign({
      sub: USER_ID,
    })

    await expect(new JwtTokenSigner(makeConfig(), clock).verify(token)).rejects.toThrow()
  })

  it('rejects a token signed with a different algorithm', async () => {
    // Regression guard for the `algorithms: [ALGORITHM]` pin on `jwtVerify`:
    // without it, a token signed HS512 with the SAME secret verifies fine.
    const { clock } = makeClock(FIXED_NOW)
    const secretBytes = new TextEncoder().encode(SECRET)
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: OTHER_ALGORITHM })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(FIXED_NOW.getTime() / MILLISECONDS_PER_SECOND) + TTL_SECONDS,
      )
      .sign(secretBytes)

    const signer = new JwtTokenSigner(makeConfig(), clock)

    await expect(signer.verify(token)).rejects.toThrow()
  })

  it('rejects a malformed token', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    await expect(signer.verify('not-a-jwt')).rejects.toThrow()
  })
})

describe('JwtTokenSigner issuer and audience', () => {
  it('stamps the configured issuer and audience', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    const token = await signer.sign({ sub: USER_ID })

    // The same instant the signer used: the fixture clock is in the past, so
    // jose's own wall clock would read this token as expired.
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      currentDate: FIXED_NOW,
    })
    expect(payload.iss).toBe(ISSUER)
    expect(payload.aud).toBe(AUDIENCE)
  })

  it('rejects a token minted by another issuer', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    await expect(
      signer.verify(await foreignToken(OTHER_ISSUER, AUDIENCE)),
    ).rejects.toThrow()
  })

  it('rejects a token minted for another audience', async () => {
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    await expect(
      signer.verify(await foreignToken(ISSUER, OTHER_AUDIENCE)),
    ).rejects.toThrow()
  })

  it('rejects a token carrying neither claim', async () => {
    // The shape every token had before this was required: same secret, same
    // algorithm, no claims. It must stop verifying.
    const { clock } = makeClock(FIXED_NOW)
    const signer = new JwtTokenSigner(makeConfig(), clock)

    await expect(
      signer.verify(await foreignToken(undefined, undefined)),
    ).rejects.toThrow()
  })
})
