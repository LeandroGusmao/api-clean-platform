import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported: these values ARE the wire contract.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const POST_METHOD = 'POST'
const REFRESH_COOKIE_NAME = 'refresh_token'
const COOKIE_TRANSPORT = 'cookie'

const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN'
const REFRESH_TOKEN_REUSED_CODE = 'REFRESH_TOKEN_REUSED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const UNKNOWN_TOKEN = 'a-token-that-was-never-issued'

const ONE_FAMILY = 1
const ONE_LIVE_TOKEN = 1

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

const login = (payload: object = {}) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD, ...payload },
  })

const refresh = (payload: object) =>
  app.inject({ method: POST_METHOD, url: REFRESH_PATH, payload })

const refreshWithCookie = (token: string) =>
  app.inject({
    method: POST_METHOD,
    url: REFRESH_PATH,
    payload: {},
    cookies: { [REFRESH_COOKIE_NAME]: token },
  })

/** The one thing a black-box HTTP test cannot do by waiting. */
const ageOutTheGraceWindow = () =>
  db.execute(
    sql`UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL`,
  )

describe('POST /auth/refresh', () => {
  it('rotates: the new pair works and the old token stops working', async () => {
    const { refreshToken } = (await login()).json()

    const rotated = await refresh({ refreshToken })

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)
    expect(rotated.json().refreshToken).not.toBe(refreshToken)
    expect(rotated.json().accessToken).toEqual(expect.any(String))

    const withSuccessor = await refresh({ refreshToken: rotated.json().refreshToken })
    expect(withSuccessor.statusCode).toBe(OK_STATUS_CODE)
  })

  it('accepts the old token once more inside the grace window', async () => {
    // The lost-response retry. Without this the app is logged out at random
    // every time a rotation response dies in a tunnel.
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    const retry = await refresh({ refreshToken })

    expect(retry.statusCode).toBe(OK_STATUS_CODE)
    expect(retry.json().refreshToken).toEqual(expect.any(String))
  })

  it('answers 401 for a token that was never issued', async () => {
    const response = await refresh({ refreshToken: UNKNOWN_TOKEN })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('answers 401 when neither a body token nor a cookie is present', async () => {
    const response = await refresh({})

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('detects reuse past the window and revokes the whole family', async () => {
    const { refreshToken } = (await login()).json()
    const rotated = await refresh({ refreshToken })

    await ageOutTheGraceWindow()

    const reused = await refresh({ refreshToken })
    expect(reused.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)

    // The live successor died with the family: the thief and the victim both
    // lose the session, and the victim logs in again.
    const successor = await refresh({ refreshToken: rotated.json().refreshToken })
    expect(successor.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('serves two SIMULTANEOUS refreshes of the same token without a false reuse', async () => {
    // A product property, NOT a proof of the row lock — and the difference
    // matters. With the grace window on, the rotation branch and the grace
    // branch answer identically, so this test stays green with `.for('update')`
    // removed. What defends the lock is the two-transaction test in
    // `drizzle-refresh-tokens-repository.spec.ts`.
    //
    // What this DOES prove is that a double-tap from a real client never comes
    // back as a spurious REFRESH_TOKEN_REUSED, which a user would experience as
    // being logged out at random.
    const { refreshToken } = (await login()).json()

    const [first, second] = await Promise.all([
      refresh({ refreshToken }),
      refresh({ refreshToken }),
    ])

    expect(first?.statusCode).toBe(OK_STATUS_CODE)
    expect(second?.statusCode).toBe(OK_STATUS_CODE)
    expect(first?.json().refreshToken).not.toBe(second?.json().refreshToken)

    const stored = await db.select().from(refreshTokens)
    expect(new Set(stored.map((row) => row.familyId)).size).toBe(ONE_FAMILY)
  })

  it('kills the successor when the old token is replayed, closing the fork', async () => {
    // The whole point of the change, end to end. A stolen token replayed inside
    // the window used to mint a SECOND live chain in the same family: thief and
    // victim each held a working token, neither ever presented a spent one, and
    // reuse detection never fired again for that family — a stolen session that
    // outlived its own detection, for sixty sliding days.
    const { refreshToken } = (await login()).json()
    const mine = await refresh({ refreshToken })

    // The replay: same window, different holder.
    const replay = await refresh({ refreshToken })
    expect(replay.statusCode).toBe(OK_STATUS_CODE)

    // The token the first rotation handed out is now dead, and dead WITHOUT a
    // successor — so presenting it is reuse, not a lost response.
    const victim = await refresh({ refreshToken: mine.json().refreshToken })
    expect(victim.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(victim.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)

    // And the replayer loses too: the family died with the detection.
    const replayer = await refresh({ refreshToken: replay.json().refreshToken })
    expect(replayer.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('leaves at most one live token per family after a grace replay', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })
    await refresh({ refreshToken })

    const live = (await db.select().from(refreshTokens)).filter(
      (row) => row.revokedAt === null,
    )

    expect(live).toHaveLength(ONE_LIVE_TOKEN)
  })

  it('reads the token from the cookie when the body has none', async () => {
    const response = await login({ refreshTransport: COOKIE_TRANSPORT })
    const value =
      response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)?.value ?? ''

    const rotated = await refreshWithCookie(value)

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)
    // Cookie in, cookie out: the answer follows the channel that was used.
    expect(rotated.json().refreshToken).toBeUndefined()
    expect(
      rotated.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)?.value,
    ).toEqual(expect.any(String))
  })

  it('never puts the plaintext token in an error body', async () => {
    const response = await refresh({ refreshToken: UNKNOWN_TOKEN })

    expect(response.body).not.toContain(UNKNOWN_TOKEN)
  })
})
