import { Writable } from 'node:stream'
import { eq } from 'drizzle-orm'
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
const ACCEPTED_STATUS_CODE = 202
const BAD_REQUEST_STATUS_CODE = 400

// `send(null)` on a 202 puts these four bytes on the wire, with a JSON content
// type — unlike a 204, where Fastify strips the body entirely. Pinned exactly,
// rather than described as "empty", so the contract stops being ambiguous.
const NULL_BODY = 'null'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const CONTENT_TYPE_HEADER = 'content-type'
const CONTENT_LENGTH_HEADER = 'content-length'

const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const NEW_EMAIL = 'maria@example.com'
const VERIFIED_EMAIL = 'ana@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WEAK_PASSWORD = 'abcdefghij'

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const PASSWORD_FIELD = 'password'

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

/**
 * Registers through the real endpoint, then marks the row verified directly.
 * The confirm flow itself — a real code travelling through a real SMTP
 * server — is `verify-email.spec.ts`'s job; this file's concern is `register`'s
 * own behaviour, and it only needs an account that IS verified, not a
 * demonstration of how it got that way.
 */
async function registerVerifiedAccount(email: string, password: string): Promise<void> {
  await register(email, password)
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, email))
}

describe('POST /auth/register', () => {
  it('answers 202 with the literal `null` body', async () => {
    const response = await register(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
    expect(response.headers[CONTENT_TYPE_HEADER]).toBe(JSON_CONTENT_TYPE)
  })

  it('answers 202 when the email is taken, ignoring case', async () => {
    await register(EMAIL, PASSWORD)

    const response = await register(EMAIL_DIFFERING_ONLY_BY_CASE, PASSWORD)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
  })

  it('answers with the same status, body and content headers for a brand-new address and one with an already verified account', async () => {
    await registerVerifiedAccount(VERIFIED_EMAIL, PASSWORD)

    const brandNew = await register(NEW_EMAIL, PASSWORD)
    const alreadyVerified = await register(VERIFIED_EMAIL, PASSWORD)

    // Compared to EACH OTHER, not to a literal: a test that pinned each
    // response separately would still pass if the two drifted apart together.
    // `date` and the rate-limit headers are excluded on purpose — they change
    // between any two sequential requests regardless of which address was
    // sent, so comparing them would fail for a reason that has nothing to do
    // with enumeration.
    expect(brandNew.statusCode).toBe(alreadyVerified.statusCode)
    expect(brandNew.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(brandNew.body).toBe(alreadyVerified.body)
    expect(brandNew.headers[CONTENT_TYPE_HEADER]).toBe(
      alreadyVerified.headers[CONTENT_TYPE_HEADER],
    )
    expect(brandNew.headers[CONTENT_LENGTH_HEADER]).toBe(
      alreadyVerified.headers[CONTENT_LENGTH_HEADER],
    )
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
    // endpoint's doing: Fastify logs no request body, so a 202 emits only
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
