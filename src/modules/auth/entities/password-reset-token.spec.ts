import { describe, expect, it } from 'vitest'
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const TOKEN_HASH = 'digest:opaque'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 1800
const MILLISECONDS_PER_SECOND = 1000
const EXPIRES_AT = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)
const ONE_MS = 1

const build = (
  overrides: Partial<Parameters<typeof PasswordResetToken.fromTrusted>[0]> = {},
) =>
  PasswordResetToken.fromTrusted({
    id: ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  })

describe('PasswordResetToken', () => {
  it('is born unconsumed with expiry derived from the clock and the ttl', () => {
    const token = PasswordResetToken.create({
      id: ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    })

    expect(token.consumedAt).toBeNull()
    expect(token.issuedAt).toEqual(NOW)
    expect(token.createdAt).toEqual(NOW)
    expect(token.expiresAt).toEqual(EXPIRES_AT)
  })

  it('is usable strictly before expiry', () => {
    expect(build().isUsable(new Date(EXPIRES_AT.getTime() - ONE_MS))).toBe(true)
  })

  it('is not usable at the expiry instant (an instant that has arrived is spent)', () => {
    expect(build().isUsable(EXPIRES_AT)).toBe(false)
  })

  it('is not usable once consumed, even before expiry', () => {
    expect(build({ consumedAt: NOW }).isUsable(NOW)).toBe(false)
  })

  it('does not leak the digest through JSON.stringify', () => {
    expect(JSON.stringify(build())).toBe('{}')
  })

  it('returns copies of its dates, not the stored instances', () => {
    const token = build()
    token.issuedAt.setFullYear(1999)
    expect(token.issuedAt).toEqual(NOW)
  })
})
