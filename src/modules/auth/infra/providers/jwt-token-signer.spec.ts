import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import type { AuthConfig } from '#modules/auth/config'
import { JwtTokenSigner } from '#modules/auth/infra/providers/jwt-token-signer'
import type { IClock } from '#shared/ports/clock'

const SECRET = 'a-test-secret-with-at-least-32-chars'
const OTHER_SECRET = 'a-different-secret-with-32-chars-ok'
const OTHER_ALGORITHM = 'HS512'
const TTL_SECONDS = 3600
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
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
): Pick<AuthConfig, 'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS'> {
  return { JWT_SECRET: secret, ACCESS_TOKEN_TTL_SECONDS: TTL_SECONDS }
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
