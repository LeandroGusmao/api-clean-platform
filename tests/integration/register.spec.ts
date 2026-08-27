import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const CREATED_STATUS_CODE = 201
const BAD_REQUEST_STATUS_CODE = 400
const CONFLICT_STATUS_CODE = 409

const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WEAK_PASSWORD = 'abcdefghij'

const EMAIL_ALREADY_IN_USE_CODE = 'EMAIL_ALREADY_IN_USE'
const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const PASSWORD_FIELD = 'password'
const ID_KEY = 'id'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ROW_MISSING_MESSAGE = 'no user row was stored'

let app: FastifyInstance
let db: Database
let pool: Pool
const logLines: string[] = []

beforeAll(async () => {
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk))
      callback()
    },
  })

  // The same function `main/http.ts` calls: whatever is composed there is
  // exercised here, with no second list to keep in sync by hand.
  app = await buildApp(env, { logStream })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  logLines.length = 0
  await db.delete(users)
})

function register(email: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email, password },
  })
}

describe('POST /auth/register', () => {
  it('creates the account and answers 201 with its id', async () => {
    const response = await register(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(CREATED_STATUS_CODE)
    expect(response.json()).toEqual({ id: expect.stringMatching(UUID_PATTERN) })
    // The response carries the id and nothing else: a wider body would be a
    // place for a field to leak into later.
    expect(Object.keys(response.json())).toEqual([ID_KEY])
  })

  it('answers 409 when the email is taken, ignoring case', async () => {
    await register(EMAIL, PASSWORD)

    const response = await register(EMAIL_DIFFERING_ONLY_BY_CASE, PASSWORD)

    expect(response.statusCode).toBe(CONFLICT_STATUS_CODE)
    expect(response.json()).toMatchObject({
      error: { code: EMAIL_ALREADY_IN_USE_CODE },
    })
  })

  it('answers 400 with a per-field detail when the password breaks the policy', async () => {
    const response = await register(EMAIL, WEAK_PASSWORD)

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
    expect(response.json()).toMatchObject({
      error: {
        code: VALIDATION_ERROR_CODE,
        details: [{ field: PASSWORD_FIELD }],
      },
    })
  })

  it('keeps the password and its hash out of the body and the log', async () => {
    const response = await register(EMAIL, PASSWORD)

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    const log = logLines.join('')

    // The two `log` assertions hold today for a reason that is not this
    // endpoint's doing: Fastify logs no request body, so a 201 emits only
    // `incoming request` and `request completed`, neither of which carries the
    // password or the hash. They are kept as a canary for the day someone adds
    // body logging — at which point both would need to start failing. The leak
    // that actually existed lived in a `DrizzleQueryError`'s bound query
    // parameters, reachable only through a failing INSERT, which `app.inject`
    // cannot be made to produce here; that path is guarded in
    // `src/infra/http/server.spec.ts` instead.
    expect(response.body).not.toContain(PASSWORD)
    expect(log).not.toContain(PASSWORD)
    expect(response.body).not.toContain(row.passwordHash)
    expect(log).not.toContain(row.passwordHash)
  })
})
