import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const ACCEPTED_STATUS_CODE = 202
const BAD_REQUEST_STATUS_CODE = 400

// `send(null)` on a 202 puts these four bytes on the wire, with a JSON content
// type — unlike a 204, where Fastify strips the body entirely.
const NULL_BODY = 'null'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const CONTENT_TYPE_HEADER = 'content-type'
const CONTENT_LENGTH_HEADER = 'content-length'

const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const NEW_EMAIL = 'maria@example.com'
const VERIFIED_EMAIL = 'ana@example.com'
const PASSWORD = 'sup3r-s3cr3t!'

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'

const ROW_MISSING_MESSAGE = 'no pending registration row was stored'
const ONE_ROW = 1
const NO_ROWS = 0

/**
 * Elevated past anything this suite spends: it fires many `register` calls from
 * one address, and the shipped 10/min ceiling would 429 a later SETUP call for
 * a reason that has nothing to do with what the case is testing.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

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
  app = await buildApp(
    { ...env, REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS },
    { logStream },
  )
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  logLines.length = 0
  await db.delete(pendingRegistrations)
  await db.delete(users)
})

function register(email: string) {
  return app.inject({ method: POST_METHOD, url: REGISTER_PATH, payload: { email } })
}

/**
 * Registers through the real endpoint, then inserts a verified `users` row
 * directly. The confirm flow — a real code through a real SMTP server — is
 * `verify-email.spec.ts`'s job; here it only needs an account that IS verified.
 */
async function makeVerifiedAccount(email: string): Promise<void> {
  await register(email)
  await db
    .insert(users)
    .values({ email, passwordHash: 'unused', emailVerifiedAt: new Date() })
}

describe('POST /auth/register', () => {
  it('answers 202 with the literal `null` body', async () => {
    const response = await register(EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
    expect(response.headers[CONTENT_TYPE_HEADER]).toBe(JSON_CONTENT_TYPE)
  })

  it('writes a pending registration and no user row', async () => {
    await register(EMAIL)

    const [pending] = await db.select().from(pendingRegistrations)
    if (pending === undefined) throw new Error(ROW_MISSING_MESSAGE)
    expect(pending.email).toBe(EMAIL)
    expect(pending.consumedAt).toBeNull()

    expect(await db.select().from(users)).toHaveLength(NO_ROWS)
  })

  it('answers 202 and adds no second pending when re-registered inside the cooldown', async () => {
    await register(EMAIL)
    const response = await register(EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(ONE_ROW)
  })

  it('answers 202 when the email already has a pending, ignoring case', async () => {
    await register(EMAIL)

    const response = await register(EMAIL_DIFFERING_ONLY_BY_CASE)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
  })

  it('answers with the same status, body and content headers for a brand-new address and one with an already verified account', async () => {
    await makeVerifiedAccount(VERIFIED_EMAIL)

    const brandNew = await register(NEW_EMAIL)
    const alreadyVerified = await register(VERIFIED_EMAIL)

    // Compared to EACH OTHER, not to a literal: a test that pinned each response
    // separately would still pass if the two drifted apart together. `date` and
    // the rate-limit headers are excluded on purpose.
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

  it('answers 400 when a `password` field is sent: the schema is strict', async () => {
    const response = await app.inject({
      method: POST_METHOD,
      url: REGISTER_PATH,
      payload: { email: EMAIL, password: PASSWORD },
    })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
    expect(response.json()).toMatchObject({ error: { code: VALIDATION_ERROR_CODE } })
  })

  it('keeps the stored code digest out of the body and the log', async () => {
    const response = await register(EMAIL)

    const [pending] = await db.select().from(pendingRegistrations)
    if (pending === undefined) throw new Error(ROW_MISSING_MESSAGE)

    const log = logLines.join('')

    // A canary for the day someone adds body logging, and for a driver-error
    // leak of bound parameters: the pending insert binds `code_hash`.
    expect(response.body).not.toContain(pending.codeHash)
    expect(log).not.toContain(pending.codeHash)
  })
})
