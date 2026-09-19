import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

const LOGIN_PATH = '/auth/login'
const LOGOUT_PATH = '/auth/logout'
const SESSIONS_PATH = '/auth/sessions'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'

const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401

const INVALID_ACCESS_TOKEN_CODE = 'INVALID_ACCESS_TOKEN'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'

const ONE_SESSION = 1
const TWO_SESSIONS = 2

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
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })
})

const login = (userAgent?: string) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD },
    ...(userAgent === undefined ? {} : { headers: { 'user-agent': userAgent } }),
  })

const logout = (refreshToken: string) =>
  app.inject({ method: POST_METHOD, url: LOGOUT_PATH, payload: { refreshToken } })

const listSessions = (authorization?: string) =>
  app.inject({
    method: GET_METHOD,
    url: SESSIONS_PATH,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })

const CHROME_ON_ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const CHROME_ON_ANDROID_LABEL = 'Chrome on Android'

describe('GET /auth/sessions', () => {
  it('shows exactly one session after a fresh login', async () => {
    const { accessToken } = (await login()).json()

    const response = await listSessions(`Bearer ${accessToken}`)

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toHaveLength(ONE_SESSION)
    expect(response.json()[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdAt: expect.stringMatching(ISO_DATE_PATTERN),
      expiresAt: expect.stringMatching(ISO_DATE_PATTERN),
      ip: expect.any(String),
      deviceLabel: expect.any(String),
      startedAt: expect.stringMatching(ISO_DATE_PATTERN),
    })
  })

  it('describes the session well enough for the owner to recognise it', async () => {
    const { accessToken } = (await login(CHROME_ON_ANDROID_USER_AGENT)).json()

    const response = await listSessions(`Bearer ${accessToken}`)

    expect(response.json()[0]).toMatchObject({
      deviceLabel: CHROME_ON_ANDROID_LABEL,
    })
  })

  it('shows two sessions after logging in twice', async () => {
    const phone = (await login()).json()
    await login()

    const response = await listSessions(`Bearer ${phone.accessToken}`)

    expect(response.json()).toHaveLength(TWO_SESSIONS)
  })

  it('drops a session from the list once it is logged out', async () => {
    const phone = (await login()).json()
    const tablet = (await login()).json()

    await logout(phone.refreshToken)

    const response = await listSessions(`Bearer ${tablet.accessToken}`)

    expect(response.json()).toHaveLength(ONE_SESSION)
  })

  it("never shows another account's sessions", async () => {
    const OTHER_EMAIL = 'maria@example.com'
    await arrangeAccount(db, { email: OTHER_EMAIL, password: PASSWORD })
    await app.inject({
      method: POST_METHOD,
      url: LOGIN_PATH,
      payload: { email: OTHER_EMAIL, password: PASSWORD },
    })
    const { accessToken } = (await login()).json()

    const response = await listSessions(`Bearer ${accessToken}`)

    expect(response.json()).toHaveLength(ONE_SESSION)
  })

  it.each([
    ['no Authorization header', undefined],
    ['a garbage token', 'Bearer not-a-jwt'],
  ])('answers 401 for %s', async (_label, authorization) => {
    const response = await listSessions(authorization)

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_ACCESS_TOKEN_CODE)
  })
})
