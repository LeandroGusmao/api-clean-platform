import { describe, expect, it } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-26T12:00:00.000Z')
const EMPTY_SERIALIZATION = '{}'
const MUTATED_YEAR = 1970
// A number, captured before any test runs, so no test can corrupt it. Asserting
// against the `NOW` Date itself is worthless here: without the copy,
// `user.createdAt` IS `NOW`, and the mutation moves both sides of the assertion
// together.
const NOW_TIME = NOW.getTime()

function createUser() {
  return User.create({
    id: ID,
    email: Email.create(EMAIL),
    passwordHash: PASSWORD_HASH,
    // A fresh copy per call: handing the shared `NOW` itself would let one
    // test's mutation of `user.createdAt` reach every other test built from it.
    now: new Date(NOW),
  })
}

describe('User.create', () => {
  it('uses the id it was given instead of generating one', () => {
    // R7: identity enters by contract. If the entity ever called
    // `randomUUID()` itself, this assertion is what fails.
    expect(createUser().id).toBe(ID)
  })

  it('uses the instant it was given for both timestamps', () => {
    const user = createUser()

    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })

  it('is born verified: the only path that reaches create has already proven the email', () => {
    expect(createUser().emailVerifiedAt).toEqual(NOW)
  })

  it('keeps the email as a value object, not a string', () => {
    expect(createUser().email.value).toBe(EMAIL)
  })

  it('carries the hash it was given', () => {
    expect(createUser().passwordHash).toBe(PASSWORD_HASH)
  })
})

describe('User serialization', () => {
  it('never leaks the password hash through JSON', () => {
    // `#` fields are non-enumerable, so `reply.send(user)` or a stray
    // `log.info({ user })` cannot serialize the hash. This is the structural
    // half of the protection; REDACT_PATHS is the other half.
    expect(JSON.stringify(createUser())).toBe(EMPTY_SERIALIZATION)
  })
})

describe('User immutability', () => {
  it('does not let a caller mutate a timestamp it was handed', () => {
    const user = createUser()

    user.createdAt.setFullYear(MUTATED_YEAR)

    expect(user.createdAt.getTime()).toBe(NOW_TIME)
  })

  it('does not let a caller mutate the instant it passed to create', () => {
    const now = new Date(NOW)
    const user = User.create({
      id: ID,
      email: Email.create(EMAIL),
      passwordHash: PASSWORD_HASH,
      now,
    })

    now.setFullYear(MUTATED_YEAR)

    expect(user.createdAt.getTime()).toBe(NOW_TIME)
  })

  it('keeps createdAt and updatedAt as independent objects', () => {
    const user = createUser()

    // `create` hands the same instant to both. Without the copy they would be
    // one object, and mutating one would move the other.
    expect(user.createdAt).not.toBe(user.updatedAt)
  })
})

describe('User.fromTrusted', () => {
  it('rehydrates every field from a trusted source', () => {
    const email = Email.fromTrusted(EMAIL)
    const verifiedAt = new Date('2026-08-20T10:00:00.000Z')
    const createdAt = new Date('2026-08-19T10:00:00.000Z')
    const updatedAt = new Date('2026-08-21T10:00:00.000Z')

    const user = User.fromTrusted({
      id: ID,
      email,
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: verifiedAt,
      createdAt,
      updatedAt,
    })

    expect(user.id).toBe(ID)
    expect(user.email.value).toBe(EMAIL)
    expect(user.passwordHash).toBe(PASSWORD_HASH)
    expect(user.emailVerifiedAt).toEqual(verifiedAt)
    expect(user.createdAt).toEqual(createdAt)
    expect(user.updatedAt).toEqual(updatedAt)
  })

  it('clones the dates it was rehydrated with', () => {
    // `Object.freeze` is shallow: without cloning, mutating the caller's Date
    // would rewrite the entity's own state.
    const createdAt = new Date('2026-08-19T10:00:00.000Z')

    const user = User.fromTrusted({
      id: ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: null,
      createdAt,
      updatedAt: createdAt,
    })
    createdAt.setFullYear(MUTATED_YEAR)

    expect(user.createdAt.getFullYear()).not.toBe(MUTATED_YEAR)
  })

  it('rehydrates a federated (passwordless) row', () => {
    const user = User.fromTrusted({
      id: ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: new Date(NOW),
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })

    expect(user.passwordHash).toBeNull()
  })
})

describe('User.createFederated', () => {
  it('is born verified: the provider has already proven the email', () => {
    const user = User.createFederated({
      id: ID,
      email: Email.create(EMAIL),
      now: new Date(NOW),
    })

    expect(user.emailVerifiedAt).toEqual(NOW)
  })

  it('has no password hash — a federated account has no password', () => {
    const user = User.createFederated({
      id: ID,
      email: Email.create(EMAIL),
      now: new Date(NOW),
    })

    expect(user.passwordHash).toBeNull()
  })

  it('stamps createdAt and updatedAt from the injected clock', () => {
    const user = User.createFederated({
      id: ID,
      email: Email.create(EMAIL),
      now: new Date(NOW),
    })

    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })
})
