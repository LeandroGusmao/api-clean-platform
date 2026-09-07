import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { DEFAULT_REFRESH_TOKEN_TTL_SECONDS } from '#modules/auth/config'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported: these values ARE the wire contract, and
// importing them would make the assertions tautological.
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const CHANGE_PASSWORD_PATH = '/auth/password'
const POST_METHOD = 'POST'
const AUTHORIZATION_HEADER = 'authorization'
const BEARER_PREFIX = 'Bearer '

const OK_STATUS_CODE = 200
const TOO_MANY_REQUESTS_STATUS_CODE = 429
const BAD_REQUEST_STATUS_CODE = 400
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
const PASSWORD_UNCHANGED_CODE = 'PASSWORD_UNCHANGED'
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'

const REFRESH_COOKIE_NAME = 'refresh_token'
const REFRESH_COOKIE_PATH = '/auth'
const COOKIE_TRANSPORT = 'cookie'
const STRICT_SAME_SITE = 'Strict'
const RETRY_AFTER_HEADER = 'retry-after'
/**
 * This suite logs in and changes the password far more often than any human
 * would, all from the one address `app.inject` arrives from — and it sat at
 * exactly the shipped login ceiling, so the next test added would have started
 * receiving 429 where it expected a session. The shipped defaults stay
 * untouched: the single case that exercises the ceiling builds its own app with
 * its own.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000
/** Small enough to spend in a loop; the real default is far above human retry. */
const CEILING_UNDER_TEST = 3
const EXPIRED_MAX_AGE = 0

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
  app = await buildApp({
    ...env,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    // `beforeEach` registers a fresh account for every case below, and
    // register now carries its own ceiling (it sends mail). Left at the
    // shipped default, this file's own test count runs past it long before
    // the suite finishes, and a later case fails for a reason that has
    // nothing to do with what it is testing — a 429 on the SETUP call.
    REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
  })
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
  // Inserted directly: since slice 11 `register` writes a `pending_registrations`
  // row, and the real SMTP-delivered confirm flow is `verify-email.spec.ts`'s
  // job — changing a password only needs the account to already BE verified.
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })
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

  it('sends the refresh token as a cookie, and NOT in the body, when asked', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      refreshTransport: COOKIE_TRANSPORT,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    // The whole point of the cookie: if the token is ALSO in the body, the
    // SPA's JavaScript can read it and HttpOnly has bought nothing.
    expect(response.json().refreshToken).toBeUndefined()
    expect(
      response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)?.value,
    ).toEqual(expect.any(String))
  })

  it('sets the cookie with every attribute decision 12 requires', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      refreshTransport: COOKIE_TRANSPORT,
    })

    const cookie = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)

    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.secure).toBe(true)
    expect(cookie?.sameSite).toBe(STRICT_SAME_SITE)
    expect(cookie?.path).toBe(REFRESH_COOKIE_PATH)
    expect(cookie?.maxAge).toBe(DEFAULT_REFRESH_TOKEN_TTL_SECONDS)
  })

  it('issues a cookie the refresh endpoint actually accepts', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      refreshTransport: COOKIE_TRANSPORT,
    })
    const issued = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)

    const refreshed = await app.inject({
      method: POST_METHOD,
      url: REFRESH_PATH,
      cookies: { [REFRESH_COOKIE_NAME]: issued?.value ?? '' },
      payload: {},
    })

    expect(refreshed.statusCode).toBe(OK_STATUS_CODE)
  })

  it('clears a stale cookie in body mode, since its family was just revoked', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken)

    expect(response.json().refreshToken).toEqual(expect.any(String))
    const cleared = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)
    // Not "no cookie at all": the header IS sent, carrying an expiry. Leaving a
    // dead cookie in the browser only produces a confusing 401 on the next
    // refresh.
    expect(cleared?.maxAge).toBe(EXPIRED_MAX_AGE)
  })

  it('answers 429 in the envelope once this route ceiling is passed', async () => {
    // Its OWN ceiling, not the global one: this is the control that closes
    // stolen access token -> password changed -> account taken.
    // Only this route's ceiling is lowered. The session comes from the main
    // app, and the shared JWT_SECRET is what lets this instance verify it.
    const throttled = await buildApp({
      ...env,
      PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS: CEILING_UNDER_TEST,
    })

    try {
      const session = await loggedIn()
      const attempt = () =>
        throttled.inject({
          method: POST_METHOD,
          url: CHANGE_PASSWORD_PATH,
          headers: { [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${session.accessToken}` },
          payload: { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD },
        })

      let last = await attempt()

      // One past the ceiling. Every attempt carries a WRONG current password,
      // so the limiter is counting requests and not failures — the same shape
      // as the login ceiling.
      for (let sent = 0; sent < CEILING_UNDER_TEST; sent++) {
        last = await attempt()
      }

      expect(last.statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
      expect(last.json().error.code).toBe(TOO_MANY_REQUESTS_CODE)
      expect(last.headers[RETRY_AFTER_HEADER]).toBeDefined()
    } finally {
      // Ends this app's database pool too, through the onClose hook in app.ts.
      await throttled.close()
    }
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
