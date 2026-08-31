import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { createLogger } from '#infra/observability/logger'
import { makeContainer } from '#main/container'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { Email } from '#modules/auth/value-objects/email'
import type { IUnitOfWork } from '#shared/ports/unit-of-work'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const OTHER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const THIRD_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-29T12:00:00.000Z')

const BOOM_MESSAGE = 'boom — abort the unit of work'

let db: Database
let pool: Pool
let unitOfWork: IUnitOfWork<AuthRepos>
/** Repositories over the pool handle: every call here commits on its own. */
let autocommit: AuthRepos

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  // Built from the real container, not hand-assembled: a container mis-wiring
  // that type-checks — say, a factory that closes over the pool handle and
  // ignores the `tx` it is given — would type-check and pass every assertion
  // below if this spec built its own `IUnitOfWork` instead of exercising the
  // one production actually wires up.
  // A real logger over a sink: the container demands one, and nothing here is
  // expected to log — a line appearing on stdout during this suite would mean a
  // transaction retried, which these cases never provoke.
  const silentStream = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  unitOfWork = makeContainer(db, env, createLogger(env, { stream: silentStream })).auth
    .uow
  autocommit = authRepositories(db)
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

describe('unit of work (integration — real Postgres)', () => {
  it('commits every write when the work resolves', async () => {
    await unitOfWork(async (repos) => {
      await repos.users.save(makeUser(ID, EMAIL))
      await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))
    })

    expect(await autocommit.users.findById(ID)).not.toBeNull()
    expect(await autocommit.users.findById(OTHER_ID)).not.toBeNull()
  })

  it('rolls back EVERY write when the work throws', async () => {
    const boom = new Error(BOOM_MESSAGE)

    await expect(
      unitOfWork(async (repos) => {
        await repos.users.save(makeUser(ID, EMAIL))
        await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))

        throw boom
      }),
    ).rejects.toBe(boom)

    expect(await autocommit.users.findById(ID)).toBeNull()
    expect(await autocommit.users.findById(OTHER_ID)).toBeNull()
  })

  it('hides uncommitted writes from a read outside the transaction', async () => {
    await unitOfWork(async (repos) => {
      await repos.users.save(makeUser(ID, EMAIL))

      // Reads through the pool handle, which takes a DIFFERENT connection: the
      // row is written but not committed, so it cannot be visible yet. This is
      // the isolation the refresh rotation leans on when it holds a row with
      // SELECT ... FOR UPDATE.
      expect(await autocommit.users.findById(ID)).toBeNull()
    })

    expect(await autocommit.users.findById(ID)).not.toBeNull()
  })

  it('lets a domain error cross the rollback unwrapped', async () => {
    await autocommit.users.save(makeUser(ID, EMAIL))

    await expect(
      unitOfWork(async (repos) => {
        await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))
        // Same email as the committed row above: the unique index raises 23505
        // and the repository translates it into the domain error.
        await repos.users.save(makeUser(THIRD_ID, EMAIL))
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)

    // The write that succeeded before the violation must be gone…
    expect(await autocommit.users.findById(OTHER_ID)).toBeNull()
    // …and the row written outside the transaction must survive.
    expect(await autocommit.users.findById(ID)).not.toBeNull()
  })
})
