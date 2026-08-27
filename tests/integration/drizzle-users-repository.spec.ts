import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PersistenceError } from '#infra/database/driver-error'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { DrizzleUsersRepository } from '#modules/auth/infra/drizzle/drizzle-users-repository'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const OTHER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-26T12:00:00.000Z')

// Spelled out rather than imported: in a test these ARE the contract being
// asserted, and importing them would make the assertion tautological.
const PG_UNIQUE_VIOLATION = '23505'
const USERS_PKEY_CONSTRAINT = 'users_pkey'

const ROW_MISSING_MESSAGE = 'no row was stored'

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

describe('DrizzleUsersRepository.save', () => {
  it('writes a row that matches the entity field by field', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    expect(row.id).toBe(ID)
    expect(row.email).toBe(EMAIL)
    expect(row.passwordHash).toBe(PASSWORD_HASH)
    expect(row.emailVerifiedAt).toBeNull()
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
