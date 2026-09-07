import { describe, expect, it } from 'vitest'
import { EmailVerification } from './email-verification.js'

const ID = '9f1a6d0f-9a3b-4c21-8a6f-2e4d2e9f1a6d'
const USER_ID = '0d3d5d8a-6f2e-4d2e-9f1a-6d0f9a3b5c21'
const CODE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const OTHER_CODE_HASH = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const TTL_SECONDS = 900
const MAX_ATTEMPTS = 5

const EXPIRES_AT = new Date('2026-09-03T12:15:00.000Z')
const ONE_MILLISECOND = 1

function create(): EmailVerification {
  return EmailVerification.create({
    id: ID,
    userId: USER_ID,
    codeHash: CODE_HASH,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
  })
}

function trusted(
  overrides: Partial<{ consumedAt: Date | null; attempts: number; expiresAt: Date }> = {},
): EmailVerification {
  return EmailVerification.fromTrusted({
    id: ID,
    userId: USER_ID,
    codeHash: CODE_HASH,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    consumedAt: overrides.consumedAt ?? null,
    attempts: overrides.attempts ?? 0,
    createdAt: NOW,
  })
}

describe('EmailVerification.create', () => {
  it('derives the expiry from the injected clock, never from the system one', () => {
    expect(create().expiresAt).toEqual(EXPIRES_AT)
  })

  it('is born unconsumed and with no attempts spent', () => {
    const verification = create()

    expect(verification.consumedAt).toBeNull()
    expect(verification.attempts).toBe(0)
  })
})

describe('isUsable', () => {
  it('is usable while fresh, unconsumed and under the cap', () => {
    expect(trusted().isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })

  it('is unusable once consumed', () => {
    expect(trusted({ consumedAt: NOW }).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is unusable at the very instant it expires, not a millisecond later', () => {
    expect(trusted().isUsable(MAX_ATTEMPTS, EXPIRES_AT)).toBe(false)
  })

  it('is still usable one millisecond before expiry', () => {
    const justBefore = new Date(EXPIRES_AT.getTime() - ONE_MILLISECOND)

    expect(trusted().isUsable(MAX_ATTEMPTS, justBefore)).toBe(true)
  })

  it('is unusable once the attempt cap is reached', () => {
    expect(trusted({ attempts: MAX_ATTEMPTS }).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is still usable one attempt below the cap', () => {
    expect(trusted({ attempts: MAX_ATTEMPTS - 1 }).isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })
})

describe('matches', () => {
  it('accepts the digest it was minted with', () => {
    expect(create().matches(CODE_HASH)).toBe(true)
  })

  it('rejects any other digest', () => {
    expect(create().matches(OTHER_CODE_HASH)).toBe(false)
  })
})

describe('immutability', () => {
  it('hands out copies of its dates, so a caller cannot rewrite its state', () => {
    const verification = create()
    verification.expiresAt.setFullYear(1970)

    expect(verification.expiresAt).toEqual(EXPIRES_AT)
  })

  it('keeps its state off the serialized form, so nothing leaks through a log', () => {
    expect(JSON.stringify(create())).toBe('{}')
  })
})
