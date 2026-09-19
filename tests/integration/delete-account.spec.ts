import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported: these values ARE the wire contract.
const LOGIN_PATH = '/auth/login'
const ME_PATH = '/auth/me'
const REFRESH_PATH = '/auth/refresh'
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'
const DELETE_METHOD = 'DELETE'

const ACCEPTED_STATUS_CODE = 202
const NO_CONTENT_STATUS_CODE = 204
const UNAUTHORIZED_STATUS_CODE = 401
const NOT_FOUND_STATUS_CODE = 404
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'n0t-the-one!'
const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
/** The exact subject of `accountDeletedEmail`; spelled out, not imported. */
const ACCOUNT_DELETED_SUBJECT = 'Your account was deleted'

const LEFTOVER_PENDING_ID = '77778888-9999-4aaa-8bbb-ccccddddeeee'
const LEFTOVER_CODE_HASH = 'digest:123456'
const NO_ATTEMPTS_SPENT = 0
const PENDING_TTL_MS = 900_000

const NO_ROWS = 0
const ONE_ROW = 1

let app: FastifyInstance
let db: Database
let pool: Pool
let accessToken: string
let refreshToken: string

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
  await db.delete(pendingRegistrations)
  await db.delete(outboxMessages)
  await db.delete(users)
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

  const loggedIn = await app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
  ;({ accessToken, refreshToken } = loggedIn.json())
})

const deleteAccount = (payload: object, authorization?: string) =>
  app.inject({
    method: DELETE_METHOD,
    url: ME_PATH,
    payload,
    // Spread rather than passing `authorization` straight through:
    // `exactOptionalPropertyTypes` makes an explicit `undefined` invalid for an
    // optional property.
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })

describe('DELETE /auth/me', () => {
  it('answers 204 and removes the row', async () => {
    const response = await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect(await db.select().from(users)).toHaveLength(NO_ROWS)
  })

  it('leaves the still-valid access token with nothing to reach', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const profile = await app.inject({
      method: GET_METHOD,
      url: ME_PATH,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(profile.statusCode).toBe(NOT_FOUND_STATUS_CODE)
  })

  it('kills the session — the cascade took the refresh token row', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const refreshed = await app.inject({
      method: POST_METHOD,
      url: REFRESH_PATH,
      payload: { refreshToken },
    })

    expect(refreshed.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
  })

  it('sweeps a live pending registration for the same address', async () => {
    // Registering again while the account exists writes no pending, so the row
    // goes in the way a leftover sibling would have survived: directly.
    await db.insert(pendingRegistrations).values({
      id: LEFTOVER_PENDING_ID,
      email: EMAIL,
      codeHash: LEFTOVER_CODE_HASH,
      attempts: NO_ATTEMPTS_SPENT,
      codeIssuedAt: new Date(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      createdAt: new Date(),
    })

    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    expect(await db.select().from(pendingRegistrations)).toHaveLength(NO_ROWS)
  })

  it('queues the deletion notice, which outlives the account', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, ACCOUNT_DELETED_SUBJECT))

    expect(rows).toHaveLength(ONE_ROW)
    expect(rows[0]?.to).toBe(EMAIL)
    expect(rows[0]?.dispatchedAt).toBeNull()
  })

  it('answers 422 for a wrong password, keeping the account', async () => {
    const response = await deleteAccount(
      { password: WRONG_PASSWORD },
      `Bearer ${accessToken}`,
    )

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_CURRENT_PASSWORD_CODE)
    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
  })

  it('answers 401 without an Authorization header', async () => {
    const response = await deleteAccount({ password: PASSWORD })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
  })

  it('lets the address be registered again from scratch', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const registered = await app.inject({
      method: POST_METHOD,
      url: REGISTER_PATH,
      payload: { email: EMAIL },
    })

    expect(registered.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(ONE_ROW)
  })
})
