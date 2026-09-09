import { describe, expect, it } from 'vitest'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { Email } from '#modules/auth/value-objects/email'

const ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const PROVIDER_USER_ID = 'google-subject-1234567890'
const EMAIL_TEXT = 'ana@example.com'
const NOW = new Date('2026-09-08T12:00:00.000Z')
const EMPTY_SERIALIZATION = '{}'
const MUTATED_YEAR = 1970

const created = () =>
  FederatedIdentity.create({
    id: ID,
    userId: USER_ID,
    provider: GOOGLE_PROVIDER,
    providerUserId: PROVIDER_USER_ID,
    emailAtLink: Email.fromTrusted(EMAIL_TEXT),
    now: new Date(NOW),
  })

describe('FederatedIdentity.create', () => {
  it('stamps createdAt from the injected clock', () => {
    expect(created().createdAt).toEqual(NOW)
  })

  it('keeps every field it was given', () => {
    const identity = created()

    expect(identity.id).toBe(ID)
    expect(identity.userId).toBe(USER_ID)
    expect(identity.provider).toBe(GOOGLE_PROVIDER)
    expect(identity.providerUserId).toBe(PROVIDER_USER_ID)
    expect(identity.emailAtLink.value).toBe(EMAIL_TEXT)
  })
})

describe('FederatedIdentity.fromTrusted', () => {
  it('rehydrates every field from a trusted row', () => {
    const createdAt = new Date('2026-08-19T10:00:00.000Z')

    const identity = FederatedIdentity.fromTrusted({
      id: ID,
      userId: USER_ID,
      provider: GOOGLE_PROVIDER,
      providerUserId: PROVIDER_USER_ID,
      emailAtLink: Email.fromTrusted(EMAIL_TEXT),
      createdAt,
    })

    expect(identity.id).toBe(ID)
    expect(identity.createdAt).toEqual(createdAt)
  })
})

describe('FederatedIdentity serialization', () => {
  it('serializes to an empty object, so providerUserId cannot leak', () => {
    expect(JSON.stringify(created())).toBe(EMPTY_SERIALIZATION)
  })
})

describe('FederatedIdentity immutability', () => {
  it('does not let a caller mutate createdAt through the getter', () => {
    const identity = created()

    identity.createdAt.setFullYear(MUTATED_YEAR)

    expect(identity.createdAt).toEqual(NOW)
  })
})
