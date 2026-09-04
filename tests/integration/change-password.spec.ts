import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported: these values ARE the wire contract, and
// importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const CHANGE_PASSWORD_PATH = '/auth/password'
const POST_METHOD = 'POST'
const AUTHORIZATION_HEADER = 'authorization'
const BEARER_PREFIX = 'Bearer '

const OK_STATUS_CODE = 200
const BAD_REQUEST_STATUS_CODE = 400
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
const PASSWORD_UNCHANGED_CODE = 'PASSWORD_UNCHANGED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const WRONG_PASSWORD = 'n0t-the-one!'

interface SessionTokens {
  accessToken: string
  refreshToken: string
}

interface ErrorBody {
  error: { code: string; traceId: string }
}

let app: FastifyInstance
let db: Database
let pool: Pool

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
  await db.delete(refreshTokens)
  await db.delete(users)
  await app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
})

const login = (password: string = PASSWORD) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password },
  })

const loggedIn = async (): Promise<SessionTokens> => {
  const response = await login()
  return response.json() as SessionTokens
}

const changePassword = (accessToken: string, payload: object = {}) =>
  app.inject({
    method: POST_METHOD,
    url: CHANGE_PASSWORD_PATH,
    headers: { [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${accessToken}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...payload },
  })

const refreshWith = (refreshToken: string) =>
  app.inject({ method: POST_METHOD, url: REFRESH_PATH, payload: { refreshToken } })

describe('POST /auth/password', () => {
  it('kills the old refresh token and returns one that works', async () => {
    const before = await loggedIn()

    const response = await changePassword(before.accessToken)
    expect(response.statusCode).toBe(OK_STATUS_CODE)

    const after = response.json() as SessionTokens

    expect((await refreshWith(before.refreshToken)).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
    // The one that dies if the revocation runs after the insert: the new token
    // would be caught by the same UPDATE and born revoked.
    expect((await refreshWith(after.refreshToken)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('ends the sessions of other devices too', async () => {
    const phone = await loggedIn()
    const tablet = await loggedIn()

    await changePassword(phone.accessToken)

    expect((await refreshWith(tablet.refreshToken)).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
  })

  it('accepts the new password at login and refuses the old one', async () => {
    const session = await loggedIn()

    await changePassword(session.accessToken)

    expect((await login(PASSWORD)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(NEW_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('answers 422 with INVALID_CURRENT_PASSWORD for a wrong current password', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      currentPassword: WRONG_PASSWORD,
    })

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    const body = response.json() as ErrorBody
    expect(body.error.code).toBe(INVALID_CURRENT_PASSWORD_CODE)
    expect(body.error.traceId).toBeTruthy()
  })

  it('answers 422 with PASSWORD_UNCHANGED when the new password is the current one', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      newPassword: PASSWORD,
    })

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    const body = response.json() as ErrorBody
    expect(body.error.code).toBe(PASSWORD_UNCHANGED_CODE)
  })

  it('leaves the session standing when the current password is wrong', async () => {
    // A failed attempt must not be a way to sign somebody out.
    const session = await loggedIn()

    await changePassword(session.accessToken, { currentPassword: WRONG_PASSWORD })

    expect((await refreshWith(session.refreshToken)).statusCode).toBe(OK_STATUS_CODE)
    expect((await login(PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('refuses a request with no access token', async () => {
    const response = await app.inject({
      method: POST_METHOD,
      url: CHANGE_PASSWORD_PATH,
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  /**
   * Pinned rather than asserted as desirable. This is the first guarded route
   * in the project that also has a body schema, and Fastify validates the body
   * BEFORE `preHandler` runs — so a malformed body answers 400 without the
   * guard ever executing, and an unauthenticated caller learns the field names.
   *
   * Accepted: the request shape is published contract for this API's own
   * clients, not a secret. The test exists so that the behaviour is a decision
   * on record instead of a surprise, and so that a future reordering of the
   * lifecycle is noticed here rather than in production.
   */
  it('validates the body before the guard, answering 400 to an anonymous caller', async () => {
    const response = await app.inject({
      method: POST_METHOD,
      url: CHANGE_PASSWORD_PATH,
      payload: {},
    })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
})
