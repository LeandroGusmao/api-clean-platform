import { describe, expect, it } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const CODE_HASH = 'digest:123456'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 900
const MILLISECONDS_PER_SECOND = 1000
const MAX_ATTEMPTS = 5
const NO_ATTEMPTS = 0

const email = Email.create(EMAIL)

const fresh = () =>
  PendingRegistration.create({
    id: ID,
    email,
    codeHash: CODE_HASH,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
  })

describe('PendingRegistration.create', () => {
  it('is born unconsumed, with no attempts, and stamps both timestamps from the clock', () => {
    const pending = fresh()

    expect(pending.id).toBe(ID)
    expect(pending.email.value).toBe(EMAIL)
    expect(pending.codeHash).toBe(CODE_HASH)
    expect(pending.attempts).toBe(NO_ATTEMPTS)
    expect(pending.consumedAt).toBeNull()
    expect(pending.codeIssuedAt).toEqual(NOW)
    expect(pending.createdAt).toEqual(NOW)
    expect(pending.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('yields {} under JSON.stringify, so the code digest cannot leak', () => {
    expect(JSON.stringify(fresh())).toBe('{}')
  })

  it('hands out copies of its dates, not the internal instances', () => {
    const pending = fresh()
    pending.expiresAt.setFullYear(1970)

    expect(pending.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })
})

describe('PendingRegistration.isUsable', () => {
  const at = (ageMs: number, attempts: number) =>
    PendingRegistration.fromTrusted({
      id: ID,
      email,
      codeHash: CODE_HASH,
      attempts,
      codeIssuedAt: new Date(NOW.getTime() - ageMs),
      expiresAt: new Date(NOW.getTime() - ageMs + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: new Date(NOW.getTime() - ageMs),
    })

  it('is usable when unconsumed, unexpired and under the cap', () => {
    expect(at(0, NO_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })

  it('is not usable once the expiry instant has arrived (inclusive boundary)', () => {
    expect(
      at(TTL_SECONDS * MILLISECONDS_PER_SECOND, NO_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW),
    ).toBe(false)
  })

  it('is not usable once attempts reach the cap', () => {
    expect(at(0, MAX_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is not usable once consumed', () => {
    const consumed = PendingRegistration.fromTrusted({
      id: ID,
      email,
      codeHash: CODE_HASH,
      attempts: NO_ATTEMPTS,
      codeIssuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: NOW,
      createdAt: NOW,
    })

    expect(consumed.isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })
})

describe('PendingRegistration.matches', () => {
  it('compares the given digest against the stored one', () => {
    expect(fresh().matches(CODE_HASH)).toBe(true)
    expect(fresh().matches('digest:000000')).toBe(false)
  })
})
