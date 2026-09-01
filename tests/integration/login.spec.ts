import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { DEFAULT_REFRESH_TOKEN_TTL_SECONDS } from '#modules/auth/config'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const POST_METHOD = 'POST'

const OK_STATUS_CODE = 200
const BAD_REQUEST_STATUS_CODE = 400
const UNAUTHORIZED_STATUS_CODE = 401

const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'wr0ng-p4ssword!'
const UNKNOWN_EMAIL = 'ninguem@example.com'

const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS'
const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/

const REFRESH_COOKIE_NAME = 'refresh_token'
const COOKIE_TRANSPORT = 'cookie'
const REFRESH_COOKIE_PATH = '/auth'
const STRICT_SAME_SITE = 'Strict'
const NO_COOKIES = 0

const ROW_MISSING_MESSAGE = 'no user row was stored'

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
  // Children first: the cascade would take them anyway, but deleting in
  // dependency order keeps this hook honest about what it does.
  await db.delete(refreshTokens)
  await db.delete(users)
  await app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
})

const login = (payload: object) =>
  app.inject({ method: POST_METHOD, url: LOGIN_PATH, payload })

describe('POST /auth/login', () => {
  it('answers 200 with both tokens for valid credentials', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    // Opaque, so deliberately NOT a JWT: a refresh token that parses as a JWT
    // is the discarded stateless option sneaking back in.
    expect(response.json().refreshToken).toEqual(expect.any(String))
    expect(response.json().refreshToken).not.toMatch(JWT_PATTERN)
  })

  it('stores only the digest of the refresh token', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.tokenHash).not.toBe(response.json().refreshToken)
    expect(response.body).not.toContain(stored?.tokenHash)
  })

  it('matches the email case-insensitively', async () => {
    const response = await login({
      email: EMAIL_DIFFERING_ONLY_BY_CASE,
      password: PASSWORD,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
  })

  it('never returns the password hash', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    expect(response.body).not.toContain(row.passwordHash)
  })

  it('answers 401 for a wrong password', async () => {
    const response = await login({ email: EMAIL, password: WRONG_PASSWORD })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_CREDENTIALS_CODE)
  })

  it('answers an unknown email exactly like a wrong password', async () => {
    // Byte-for-byte identical apart from the traceId: anything else would tell
    // a caller whether the account exists.
    const wrongPassword = await login({ email: EMAIL, password: WRONG_PASSWORD })
    const unknownEmail = await login({ email: UNKNOWN_EMAIL, password: PASSWORD })

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode)
    expect(unknownEmail.json().error.code).toBe(wrongPassword.json().error.code)
    expect(unknownEmail.json().error.message).toBe(wrongPassword.json().error.message)
  })

  it('answers 400 for a malformed email', async () => {
    const response = await login({ email: 'not-an-email', password: PASSWORD })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
    expect(response.json().error.code).toBe(VALIDATION_ERROR_CODE)
  })

  it('answers 400 for an empty password', async () => {
    const response = await login({ email: EMAIL, password: '' })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })

  it('answers 400 for a missing password field', async () => {
    const response = await login({ email: EMAIL })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })

  it('answers 400 for a missing email field', async () => {
    const response = await login({ password: PASSWORD })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })

  it('sends the refresh token as a cookie, and NOT in the body, when asked', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: COOKIE_TRANSPORT,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    // The whole point of the cookie: if the token is ALSO in the body, the
    // SPA's JavaScript can read it and HttpOnly has bought nothing.
    expect(response.json().refreshToken).toBeUndefined()
  })

  it('sets the cookie with every attribute decision 12 requires', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: COOKIE_TRANSPORT,
    })

    const cookie = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)

    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.secure).toBe(true)
    expect(cookie?.sameSite).toBe(STRICT_SAME_SITE)
    // `/auth` and not `/auth/refresh`: the amendment that makes cookie-mode
    // logout possible at all.
    expect(cookie?.path).toBe(REFRESH_COOKIE_PATH)
    expect(cookie?.maxAge).toBe(DEFAULT_REFRESH_TOKEN_TTL_SECONDS)
  })

  it('defaults to the body when the transport field is absent', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    expect(response.json().refreshToken).toEqual(expect.any(String))
    expect(response.cookies).toHaveLength(NO_COOKIES)
  })

  it('answers 400 for an unknown transport', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: 'carrier-pigeon',
    })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })

  it('does not enforce the registration password policy', async () => {
    // A short guess must come back as 401, not 400: a validation error would
    // tell an attacker the guess failed the RULES rather than the password,
    // and an account created under a looser policy has to stay able to log in.
    const response = await login({ email: EMAIL, password: 'short' })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })
})
