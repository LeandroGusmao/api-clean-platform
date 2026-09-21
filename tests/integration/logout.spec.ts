import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported: these values ARE the wire contract.
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const LOGOUT_PATH = '/auth/logout'
const LOGOUT_ALL_PATH = '/auth/logout-all'
const POST_METHOD = 'POST'
const REFRESH_COOKIE_NAME = 'refresh_token'
const COOKIE_TRANSPORT = 'cookie'
const REFRESH_COOKIE_PATH = '/auth'

const OK_STATUS_CODE = 200
const NO_CONTENT_STATUS_CODE = 204
const UNAUTHORIZED_STATUS_CODE = 401

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const UNKNOWN_TOKEN = 'a-token-that-was-never-issued'

const EXPIRED_MAX_AGE = 0

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

/**
 * Inserts a verified account directly — every caller in this file logs it in
 * right after, and login gates on a verified email. `register` writes a
 * `pending_registrations` row, not a user; the real SMTP-delivered confirm flow is
 * `verify-email.spec.ts`'s job, and logout only needs the account to already BE
 * verified.
 */
const arrange = (email: string) => arrangeAccount(db, { email, password: PASSWORD })

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(users)
  await arrange(EMAIL)
})

const loginAs = (email: string, payload: object = {}) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email, password: PASSWORD, ...payload },
  })

const login = (payload: object = {}) => loginAs(EMAIL, payload)

const refresh = (payload: object) =>
  app.inject({ method: POST_METHOD, url: REFRESH_PATH, payload })

const logout = (payload: object, cookies?: Record<string, string>) =>
  app.inject({
    method: POST_METHOD,
    url: LOGOUT_PATH,
    payload,
    // Spread rather than passing `cookies` straight through:
    // `exactOptionalPropertyTypes` makes an explicit `undefined` invalid for an
    // optional property, and `inject` then fails overload resolution into an
    // unusable `void & Promise<Response> & Chain` intersection.
    ...(cookies === undefined ? {} : { cookies }),
  })

const logoutAll = (accessToken?: string) =>
  app.inject({
    method: POST_METHOD,
    url: LOGOUT_ALL_PATH,
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
  })

describe('POST /auth/logout', () => {
  it('answers 204 and kills the session', async () => {
    const { refreshToken } = (await login()).json()

    expect((await logout({ refreshToken })).statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect((await refresh({ refreshToken })).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('kills the sibling issued inside the grace window too', async () => {
    // The reason logout revokes the FAMILY and not the row: a grace-window
    // exchange leaves two live tokens, and revoking one would leave the session
    // standing after the user asked to leave.
    const { refreshToken } = (await login()).json()
    const rotated = await refresh({ refreshToken })
    const sibling = await refresh({ refreshToken })

    await logout({ refreshToken: rotated.json().refreshToken })

    expect(
      (await refresh({ refreshToken: sibling.json().refreshToken })).statusCode,
    ).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('leaves a second login of the same user signed in', async () => {
    // Logging out on the phone must not sign the tablet out.
    const phone = (await login()).json()
    const tablet = (await login()).json()

    await logout({ refreshToken: phone.refreshToken })

    expect((await refresh({ refreshToken: tablet.refreshToken })).statusCode).toBe(
      OK_STATUS_CODE,
    )
  })

  it('answers 204 for a token it has never seen', async () => {
    // Indistinguishable from the valid case on purpose: a different answer here
    // would tell a caller whether a token exists.
    expect((await logout({ refreshToken: UNKNOWN_TOKEN })).statusCode).toBe(
      NO_CONTENT_STATUS_CODE,
    )
  })

  it('answers 401 when no credential is presented at all', async () => {
    const response = await logout({})

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('logs out from the cookie, and expires it with the same attributes', async () => {
    const loggedIn = await login({ refreshTransport: COOKIE_TRANSPORT })
    const value =
      loggedIn.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)?.value ?? ''

    const response = await logout({}, { [REFRESH_COOKIE_NAME]: value })
    const cleared = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)

    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect(cleared?.maxAge).toBe(EXPIRED_MAX_AGE)
    expect(cleared?.path).toBe(REFRESH_COOKIE_PATH)
    // `clearCookie` does NOT inherit what `setCookie` used — verified. These
    // two assertions are what would catch a future call passing only the path.
    expect(cleared?.httpOnly).toBe(true)
    expect(cleared?.secure).toBe(true)
  })
})

describe('POST /auth/logout-all', () => {
  it('kills every family of the caller', async () => {
    const phone = (await login()).json()
    const tablet = (await login()).json()

    expect((await logoutAll(phone.accessToken)).statusCode).toBe(NO_CONTENT_STATUS_CODE)

    expect((await refresh({ refreshToken: phone.refreshToken })).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
    expect((await refresh({ refreshToken: tablet.refreshToken })).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
  })

  it('never touches another account', async () => {
    await arrange(OTHER_EMAIL)
    const stranger = (await loginAs(OTHER_EMAIL)).json()
    const mine = (await login()).json()

    await logoutAll(mine.accessToken)

    expect((await refresh({ refreshToken: stranger.refreshToken })).statusCode).toBe(
      OK_STATUS_CODE,
    )
  })

  it('answers 401 without an Authorization header', async () => {
    expect((await logoutAll()).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })
})
