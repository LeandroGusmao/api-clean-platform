import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PersistenceError } from '#infra/database/driver-error'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { DrizzleUsersRepository } from '#modules/auth/infra/drizzle/drizzle-users-repository'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const OTHER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-26T12:00:00.000Z')

// Three distinct instants, used only by the mapper-rehydration test below:
// `User.create` (and therefore `makeUser`) always sets createdAt === updatedAt
// === emailVerifiedAt (all `now` since slice 11), so it cannot produce a row
// where a swapped pair of columns would be caught.
const REHYDRATION_CREATED_AT = new Date('2026-08-24T09:00:00.000Z')
const REHYDRATION_UPDATED_AT = new Date('2026-08-25T15:30:00.000Z')
const REHYDRATION_EMAIL_VERIFIED_AT = new Date('2026-08-26T18:45:00.000Z')

// Spelled out rather than imported: in a test these ARE the contract being
// asserted, and importing them would make the assertion tautological.
const PG_UNIQUE_VIOLATION = '23505'
const USERS_PKEY_CONSTRAINT = 'users_pkey'

const ROW_MISSING_MESSAGE = 'no row was stored'

const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'

const NEW_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$b3RoZXJzYWx0$newhash'
/**
 * Far from any real clock. If the repository ever stops sending the column, the
 * `$onUpdate` fills it with the system clock and the difference is six years —
 * impossible to mistake for a rounding artefact.
 */
const DISTANT_PAST = new Date('2020-01-01T00:00:00.000Z')

const HASH_LENGTH = 64
const REFRESH_HASH = 'a'.repeat(HASH_LENGTH)
const RESET_HASH = 'b'.repeat(HASH_LENGTH)
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const GOOGLE_PROVIDER_NAME = 'google'
const GOOGLE_SUBJECT = 'google-subject-1234567890'
const CHILD_EXPIRES_AT = new Date('2026-12-31T12:00:00.000Z')

const NO_ROWS = 0
const ONE_ROW = 1

/**
 * Distinct ids per child table and per owner: the three tables have their own
 * primary keys, and both users get a full set in the isolation test.
 */
const CHILD_IDS = {
  [ID]: {
    refresh: '44445555-6666-4777-8888-999900001111',
    federated: '44445555-6666-4777-8888-999900002222',
    reset: '44445555-6666-4777-8888-999900003333',
  },
  [OTHER_ID]: {
    refresh: '55556666-7777-4888-8999-000011114444',
    federated: '55556666-7777-4888-8999-000011115555',
    reset: '55556666-7777-4888-8999-000011116666',
  },
} as const

let db: Database
let pool: Pool
let repository: DrizzleUsersRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = new DrizzleUsersRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(users)
})

function makeUser(id: string, email: string) {
  return User.create({
    id,
    email: Email.create(email),
    passwordHash: PASSWORD_HASH,
    now: NOW,
  })
}

/** One row in each table that carries a cascading foreign key to `users`. */
async function storeChildRows(userId: keyof typeof CHILD_IDS) {
  const ids = CHILD_IDS[userId]

  await db.insert(refreshTokens).values({
    id: ids.refresh,
    userId,
    tokenHash: `${REFRESH_HASH}${ids.refresh}`,
    familyId: FAMILY_ID,
    expiresAt: CHILD_EXPIRES_AT,
    createdAt: NOW,
  })
  await db.insert(federatedIdentities).values({
    id: ids.federated,
    userId,
    provider: GOOGLE_PROVIDER_NAME,
    providerUserId: `${GOOGLE_SUBJECT}-${ids.federated}`,
    emailAtLink: EMAIL,
    createdAt: NOW,
  })
  await db.insert(passwordResetTokens).values({
    id: ids.reset,
    userId,
    tokenHash: `${RESET_HASH}${ids.reset}`,
    issuedAt: NOW,
    expiresAt: CHILD_EXPIRES_AT,
    createdAt: NOW,
  })
}

describe('DrizzleUsersRepository.save', () => {
  it('writes a row that matches the entity field by field', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    expect(row.id).toBe(ID)
    expect(row.email).toBe(EMAIL)
    expect(row.passwordHash).toBe(PASSWORD_HASH)
    expect(row.emailVerifiedAt).toEqual(NOW)
    expect(row.createdAt).toEqual(NOW)
    expect(row.updatedAt).toEqual(NOW)
  })

  it('rejects an email that differs only by case', async () => {
    await repository.save(makeUser(ID, EMAIL))

    // What this proves is the caller-facing behaviour: two registrations that
    // differ only in case cannot both succeed. It does NOT exercise the
    // functional index — `Email.create` lowercases before the row is written,
    // so both inserts carry the identical string. The index itself is covered
    // by `users-schema.spec.ts`, which inserts raw rows in differing case.
    await expect(
      repository.save(makeUser(OTHER_ID, EMAIL_DIFFERING_ONLY_BY_CASE)),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)
  })

  it('lets a violation of another constraint bubble', async () => {
    await repository.save(makeUser(ID, EMAIL))

    // Same id, different email: this violates `users_pkey`, which raises 23505
    // just like the email index does. A repository that matched only the code
    // would report a primary key collision as "email already in use" — a 409
    // over what is really a 500.
    //
    // Asserted positively, not with `.not.toBeInstanceOf`: an unrelated
    // `TypeError` would also satisfy "not `EmailAlreadyInUseError`", so the
    // constraint name — spelled out, not imported, because in a test it is
    // the contract being asserted — is what actually proves the bubble.
    await expect(repository.save(makeUser(ID, OTHER_EMAIL))).rejects.toMatchObject({
      code: PG_UNIQUE_VIOLATION,
      constraint: USERS_PKEY_CONSTRAINT,
    })
  })

  it('does not let the password hash escape with the bubbled error', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const thrown = await repository.save(makeUser(ID, OTHER_EMAIL)).catch((e) => e)

    // Drizzle's own error glues every bound parameter into its message, and the
    // insert bound the hash. The repository converts before re-throwing, so
    // nothing that leaves this class carries it — in the message, in the stack,
    // or in any own property a logger would copy.
    const reachable = [
      String(thrown),
      thrown instanceof Error ? (thrown.stack ?? '') : '',
      JSON.stringify({ ...thrown }),
    ].join('\n')

    expect(reachable).not.toContain(PASSWORD_HASH)
    // And it keeps no cause, which is what a wrapper would concatenate.
    expect(thrown).toBeInstanceOf(PersistenceError)
    expect(thrown.cause).toBeUndefined()
  })
})

describe('DrizzleUsersRepository.findByEmail', () => {
  it('finds a row whose stored email is mixed case', async () => {
    // Inserted directly, bypassing the domain: `Email.create` would lowercase
    // the value before it ever reached the database, which would leave both
    // sides of the comparison already lowercase and hide a `WHERE email = $1`
    // bug just as well as `WHERE lower(email) = $1`. Writing the row this way
    // — mixed case, no normalization — is also how a seed or a psql session
    // actually produces one.
    await db.insert(users).values({
      id: ID,
      email: EMAIL_DIFFERING_ONLY_BY_CASE,
      passwordHash: PASSWORD_HASH,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const found = await repository.findByEmail(Email.create(EMAIL_DIFFERING_ONLY_BY_CASE))

    expect(found?.id).toBe(ID)
  })

  it('finds a user by email', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const found = await repository.findByEmail(Email.create(EMAIL))

    expect(found?.id).toBe(ID)
  })

  it('returns null when no user has that email', async () => {
    const found = await repository.findByEmail(Email.create(OTHER_EMAIL))

    expect(found).toBeNull()
  })
})

describe('DrizzleUsersRepository.findById', () => {
  it('finds a user by id', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const found = await repository.findById(ID)

    expect(found?.email.value).toBe(EMAIL)
  })

  it('returns null when no user has that id', async () => {
    const found = await repository.findById(MISSING_USER_ID)

    expect(found).toBeNull()
  })

  it('rehydrates every field through the mapper', async () => {
    // Inserted directly rather than via `makeUser`/`User.create`: `create`
    // always sets createdAt === updatedAt and emailVerifiedAt to null, so a
    // `toDomainUser` bug that swapped createdAt and updatedAt would compare
    // NOW to NOW and pass regardless. Three distinct timestamps make each
    // assertion only match its own column — this also proves the timestamp
    // round trip is lossless, since Postgres never returns microseconds JS
    // cannot represent.
    await db.insert(users).values({
      id: ID,
      email: EMAIL,
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: REHYDRATION_EMAIL_VERIFIED_AT,
      createdAt: REHYDRATION_CREATED_AT,
      updatedAt: REHYDRATION_UPDATED_AT,
    })

    const found = await repository.findById(ID)

    expect(found?.id).toBe(ID)
    expect(found?.email.value).toBe(EMAIL)
    expect(found?.passwordHash).toBe(PASSWORD_HASH)
    expect(found?.emailVerifiedAt?.getTime()).toBe(
      REHYDRATION_EMAIL_VERIFIED_AT.getTime(),
    )
    expect(found?.createdAt.getTime()).toBe(REHYDRATION_CREATED_AT.getTime())
    expect(found?.updatedAt.getTime()).toBe(REHYDRATION_UPDATED_AT.getTime())
  })
})

describe('DrizzleUsersRepository.updatePasswordHash', () => {
  it('writes the exact updatedAt it is given, not the system clock', async () => {
    await repository.save(makeUser(ID, EMAIL))

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const stored = await repository.findById(ID)
    expect(stored?.updatedAt).toEqual(DISTANT_PAST)
  })

  it('changes only the password columns', async () => {
    await repository.save(makeUser(ID, EMAIL))
    const before = await repository.findById(ID)

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const after = await repository.findById(ID)
    expect(after?.passwordHash).toBe(NEW_PASSWORD_HASH)
    expect(after?.email.value).toBe(before?.email.value)
    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.emailVerifiedAt).toEqual(before?.emailVerifiedAt)
  })

  it('never touches another row', async () => {
    // `id` and `passwordHash` are adjacent positional strings, so transposing
    // them compiles. This is the test that catches it.
    await repository.save(makeUser(ID, EMAIL))
    await repository.save(makeUser(OTHER_ID, OTHER_EMAIL))

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const other = await repository.findById(OTHER_ID)
    expect(other?.passwordHash).toBe(PASSWORD_HASH)
    expect(other?.updatedAt).not.toEqual(DISTANT_PAST)
  })
})

describe('DrizzleUsersRepository.deleteById', () => {
  it('removes the row', async () => {
    await repository.save(makeUser(ID, EMAIL))

    await repository.deleteById(ID)

    expect(await db.select().from(users)).toHaveLength(NO_ROWS)
  })

  it('takes the refresh tokens, federated identities and reset tokens with it', async () => {
    // The cascade is declared in the schema; this is what proves Postgres
    // applies it, rather than trusting the declaration.
    await repository.save(makeUser(ID, EMAIL))
    await storeChildRows(ID)

    await repository.deleteById(ID)

    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
    expect(await db.select().from(federatedIdentities)).toHaveLength(NO_ROWS)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(NO_ROWS)
  })

  it("never touches another account's rows", async () => {
    await repository.save(makeUser(ID, EMAIL))
    await repository.save(makeUser(OTHER_ID, OTHER_EMAIL))
    await storeChildRows(ID)
    await storeChildRows(OTHER_ID)

    await repository.deleteById(ID)

    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
    expect(await db.select().from(refreshTokens)).toHaveLength(ONE_ROW)
    expect(await db.select().from(federatedIdentities)).toHaveLength(ONE_ROW)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(ONE_ROW)
  })

  it('is silent about an id that has no row', async () => {
    await expect(repository.deleteById(MISSING_USER_ID)).resolves.toBeUndefined()
  })
})
