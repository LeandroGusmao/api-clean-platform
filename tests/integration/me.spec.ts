import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const ME_PATH = '/auth/me'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'

const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401
const NOT_FOUND_STATUS_CODE = 404

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'

const INVALID_ACCESS_TOKEN_CODE = 'INVALID_ACCESS_TOKEN'
const USER_NOT_FOUND_CODE = 'USER_NOT_FOUND'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const ROW_MISSING_MESSAGE = 'no user row was stored'

let app: FastifyInstance
let db: Database
let pool: Pool
let userId: string
let verifiedAt: Date | null
let accessToken: string

beforeAll(async () => {
  app = await buildApp(env)
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(users)

  await app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
  // `register` no longer answers the id (202, empty body) — read the row back
  // instead. Marked verified directly at the row rather than through a real
  // code: the real, SMTP-delivered confirm flow is `verify-email.spec.ts`'s
  // job, and this file's own concern — `me` — only needs the account to
  // already BE verified, since login now gates on it.
  const [row] = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, EMAIL))
    .returning()
  if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)
  userId = row.id
  verifiedAt = row.emailVerifiedAt

  const loggedIn = await app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
  accessToken = loggedIn.json().accessToken
})

const getMe = (authorization?: string) =>
  app.inject({
    method: GET_METHOD,
    url: ME_PATH,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })

describe('GET /auth/me', () => {
  it('returns the profile of the user the token was issued for', async () => {
    // The assertion that ties the whole slice together, and it never decodes
    // the JWT: signing, the guard, verification, the WeakMap, findById and the
    // mapper are all exercised by comparing this id to the registered one. The
    // token's format is not the contract.
    const response = await getMe(`Bearer ${accessToken}`)

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toEqual({
      id: userId,
      email: EMAIL,
      // Not `null`: login gates on a verified email, so no account that can
      // reach this endpoint is unverified.
      emailVerifiedAt: verifiedAt?.toISOString(),
      createdAt: expect.stringMatching(ISO_DATE_PATTERN),
    })
  })

  it('never returns the password hash', async () => {
    const response = await getMe(`Bearer ${accessToken}`)

    expect(response.body).not.toContain('$argon2id$')
    expect(response.body).not.toContain('passwordHash')
  })

  it.each([
    ['no Authorization header', undefined],
    ['a garbage token', 'Bearer not-a-jwt'],
    ['a Basic header', 'Basic dXNlcjpwYXNz'],
  ])('answers 401 for %s', async (_label, authorization) => {
    const response = await getMe(authorization)

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_ACCESS_TOKEN_CODE)
  })

  it('answers 404 when the account was deleted while the token was still valid', async () => {
    await db.delete(users).where(eq(users.id, userId))

    const response = await getMe(`Bearer ${accessToken}`)

    expect(response.statusCode).toBe(NOT_FOUND_STATUS_CODE)
    expect(response.json().error.code).toBe(USER_NOT_FOUND_CODE)
  })
})
