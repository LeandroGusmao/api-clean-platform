import { describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'

const TOKEN_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const SUCCESSOR_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const TOKEN_HASH = 'a'.repeat(64)

const NOW = new Date('2026-08-31T12:00:00.000Z')
const MILLISECONDS_PER_SECOND = 1000
const TTL_SECONDS = 60
const TTL_MS = TTL_SECONDS * MILLISECONDS_PER_SECOND
const GRACE_WINDOW_MS = 30_000
const ONE_MILLISECOND = 1
const AN_OLD_YEAR = 1970

const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

/** Far enough that it never binds. */
const FAR_CEILING = new Date('2099-01-01T00:00:00.000Z')
const HALF_TTL_MS = TTL_MS / 2

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

const active = () =>
  RefreshToken.create({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    lifetimeCeiling: FAR_CEILING,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

const revoked = (revokedAt: Date, replacedBy: string | null) =>
  RefreshToken.fromTrusted({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: at(TTL_MS),
    revokedAt,
    replacedBy,
    createdAt: NOW,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

describe('RefreshToken.create', () => {
  it('derives expiresAt from the injected clock plus the TTL', () => {
    // Never `Date.now()`: R7, and without it neither the expiry test below nor
    // the grace window tests could exist at all.
    expect(active().expiresAt).toEqual(at(TTL_MS))
  })

  it('is born active and unreplaced', () => {
    const token = active()

    expect(token.revokedAt).toBeNull()
    expect(token.replacedBy).toBeNull()
    expect(token.isRevoked()).toBe(false)
  })
})

describe('RefreshToken.isExpired', () => {
  it('is not expired one millisecond before expiresAt', () => {
    expect(active().isExpired(at(TTL_MS - ONE_MILLISECOND))).toBe(false)
  })

  it('IS expired exactly at expiresAt', () => {
    // The boundary is inclusive on purpose: a token whose instant has arrived
    // is spent. Flipping this to `<` would keep it alive for one more tick,
    // which is the kind of off-by-one nobody ever notices.
    expect(active().isExpired(at(TTL_MS))).toBe(true)
  })
})

describe('RefreshToken.isWithinGraceWindow', () => {
  it('accepts a rotation retry inside the window', () => {
    const token = revoked(NOW, SUCCESSOR_ID)

    expect(token.isWithinGraceWindow(at(GRACE_WINDOW_MS), GRACE_WINDOW_MS)).toBe(true)
  })

  it('refuses one millisecond past the window', () => {
    const token = revoked(NOW, SUCCESSOR_ID)

    expect(
      token.isWithinGraceWindow(at(GRACE_WINDOW_MS + ONE_MILLISECOND), GRACE_WINDOW_MS),
    ).toBe(false)
  })

  it('refuses a token revoked by LOGOUT, even inside the window', () => {
    // The guard of the whole slice. A logout leaves `replacedBy` null; without
    // this branch, logging out and refreshing within 30 seconds would hand back
    // a fresh pair, and the grace window would become a bypass of explicit
    // revocation.
    const loggedOut = revoked(NOW, null)

    expect(loggedOut.isWithinGraceWindow(at(ONE_MILLISECOND), GRACE_WINDOW_MS)).toBe(
      false,
    )
  })

  it('refuses an active token', () => {
    expect(active().isWithinGraceWindow(NOW, GRACE_WINDOW_MS)).toBe(false)
  })
})

describe('RefreshToken device context', () => {
  it('carries the supplied context', () => {
    const token = active()

    expect(token.ip).toBe(IP)
    expect(token.deviceLabel).toBe(DEVICE_LABEL)
    expect(token.sessionStartedAt).toEqual(SESSION_STARTED_AT)
  })

  it('accepts a fully absent context, for a row older than the columns', () => {
    const token = RefreshToken.create({
      id: TOKEN_ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      familyId: FAMILY_ID,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
      lifetimeCeiling: FAR_CEILING,
      ip: null,
      deviceLabel: null,
      sessionStartedAt: null,
    })

    expect(token.ip).toBeNull()
    expect(token.deviceLabel).toBeNull()
    expect(token.sessionStartedAt).toBeNull()
  })
})

describe('RefreshToken lifetime ceiling', () => {
  const create = (lifetimeCeiling: Date) =>
    RefreshToken.create({
      id: TOKEN_ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      familyId: FAMILY_ID,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
      lifetimeCeiling,
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

  it('expires at now plus the TTL when the ceiling is farther away', () => {
    expect(create(FAR_CEILING).expiresAt).toEqual(at(TTL_MS))
  })

  it('expires at the ceiling when it is closer than the TTL', () => {
    const ceiling = at(HALF_TTL_MS)

    expect(create(ceiling).expiresAt).toEqual(ceiling)
  })

  it('gives the same instant when the ceiling equals now plus the TTL', () => {
    expect(create(at(TTL_MS)).expiresAt).toEqual(at(TTL_MS))
  })
})

describe('RefreshToken immutability', () => {
  it('does not let a caller mutate its dates through a getter', () => {
    // `Object.freeze` is shallow: it locks the bindings, not the Date objects
    // they point at. Without cloning, this line would rewrite the entity.
    const token = active()

    token.expiresAt.setFullYear(AN_OLD_YEAR)

    expect(token.expiresAt).toEqual(at(TTL_MS))
  })

  it('does not let a caller mutate the session start through a getter', () => {
    const token = active()

    token.sessionStartedAt?.setFullYear(AN_OLD_YEAR)

    expect(token.sessionStartedAt).toEqual(SESSION_STARTED_AT)
  })
})
