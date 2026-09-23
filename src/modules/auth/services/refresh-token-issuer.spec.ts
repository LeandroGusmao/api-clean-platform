import { describe, expect, it } from 'vitest'
import { DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS } from '#modules/auth/config'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const GENERATED_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OPAQUE_TOKEN = 'opaque-token'
/** Unused by this suite; required only to satisfy `ITokenGenerator`. */
const NUMERIC_CODE = '000000'

const NOW = new Date('2026-09-18T12:00:00.000Z')
const TTL_SECONDS = 60
const HALF_TTL_SECONDS = 30
/**
 * The default ceiling: the fixtures start the session weeks before `NOW`, so a
 * short one would already be behind them and cap every expiry.
 */
const MAX_LIFETIME_SECONDS = DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS
const MILLISECONDS_PER_SECOND = 1000

const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

const digestOf = (value: string) => `digest:${value}`

const makeIssuer = () =>
  new RefreshTokenIssuer(
    { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
    { hash: digestOf },
    { generate: () => GENERATED_ID },
    TTL_SECONDS,
    MAX_LIFETIME_SECONDS,
  )

describe('RefreshTokenIssuer', () => {
  it('hands the plaintext to the caller and persists only its digest', () => {
    const { token, entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    expect(token).toBe(OPAQUE_TOKEN)
    expect(entity.tokenHash).toBe(digestOf(OPAQUE_TOKEN))
  })

  it('derives the expiry from the supplied instant, never from a wall clock', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    expect(entity.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('puts the supplied context on the issued entity', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    expect(entity.ip).toBe(IP)
    expect(entity.deviceLabel).toBe(DEVICE_LABEL)
    expect(entity.sessionStartedAt).toEqual(SESSION_STARTED_AT)
  })

  it('accepts an address that did not parse', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: null,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    expect(entity.ip).toBeNull()
  })

  it('mints a family id per call, so one login never joins another chain', () => {
    const issuer = makeIssuer()

    expect(issuer.newFamilyId()).toBe(GENERATED_ID)
  })

  it('computes the ceiling as the session start plus the max lifetime', () => {
    expect(makeIssuer().ceilingFor(SESSION_STARTED_AT)).toEqual(
      new Date(
        SESSION_STARTED_AT.getTime() + MAX_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND,
      ),
    )
  })

  it('lets a ceiling closer than the TTL cap the issued expiry', () => {
    // Thirty seconds of session left against a TTL of sixty: the ceiling wins.
    const startedAt = new Date(
      NOW.getTime() - (MAX_LIFETIME_SECONDS - HALF_TTL_SECONDS) * MILLISECONDS_PER_SECOND,
    )

    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: startedAt,
    })

    expect(entity.expiresAt).toEqual(
      new Date(NOW.getTime() + HALF_TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })
})
