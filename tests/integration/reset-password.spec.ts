import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { buildApp } from '#main/app'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'
import {
  clearMailpit,
  extractResetToken,
  latestMessage,
  waitForMessageCount,
} from './setup/mailpit.js'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const FORGOT_PATH = '/auth/password/forgot'
const RESET_PATH = '/auth/password/reset'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const POST_METHOD = 'POST'

const NO_CONTENT_STATUS_CODE = 204
const OK_STATUS_CODE = 200
const BAD_REQUEST_STATUS_CODE = 400
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const PASSWORD_RESET_FAILED_CODE = 'PASSWORD_RESET_FAILED'
/** The exact subject of `passwordResetCompletedEmail`; spelled out, not imported. */
const PASSWORD_RESET_COMPLETED_SUBJECT = 'Your password was reset'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const MALFORMED_TOKEN = 'too-short'
const WELL_FORMED_UNKNOWN_TOKEN = 'Z'.repeat(43)
const ONE_MESSAGE = 1
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
    PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
  })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(passwordResetTokens)
  await db.delete(refreshTokens)
  await db.delete(outboxMessages)
  await db.delete(users)
  await clearMailpit()
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })
})

const forgot = () =>
  app.inject({ method: POST_METHOD, url: FORGOT_PATH, payload: { email: EMAIL } })
const resetWith = (token: string, newPassword = NEW_PASSWORD) =>
  app.inject({ method: POST_METHOD, url: RESET_PATH, payload: { token, newPassword } })
const login = (password: string) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password },
  })

/** Runs forgot and returns the token from the email. */
async function forgotAndFetchToken(): Promise<string> {
  await forgot()
  await waitForMessageCount(ONE_MESSAGE)
  return extractResetToken((await latestMessage()).text)
}

describe('POST /auth/password/reset', () => {
  it('changes the password: 204, new password works, old one does not', async () => {
    const token = await forgotAndFetchToken()

    const response = await resetWith(token)
    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)

    expect((await login(PASSWORD)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(NEW_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('revokes every session that existed before the reset', async () => {
    const session = (await login(PASSWORD)).json() as { refreshToken: string }
    const token = await forgotAndFetchToken()

    await resetWith(token)

    const refreshed = await app.inject({
      method: POST_METHOD,
      url: REFRESH_PATH,
      payload: { refreshToken: session.refreshToken },
    })
    expect(refreshed.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('enqueues a "password was reset" notice in the outbox after success', async () => {
    const token = await forgotAndFetchToken()
    await resetWith(token)

    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, PASSWORD_RESET_COMPLETED_SUBJECT))

    expect(rows).toHaveLength(ONE_MESSAGE)
    expect(rows[0]?.dispatchedAt).toBeNull()
  })

  it('rejects a replay of a spent token with 422 PASSWORD_RESET_FAILED', async () => {
    const token = await forgotAndFetchToken()
    expect((await resetWith(token)).statusCode).toBe(NO_CONTENT_STATUS_CODE)

    const replay = await resetWith(token)
    expect(replay.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(replay.json().error.code).toBe(PASSWORD_RESET_FAILED_CODE)
  })

  it('rejects a well-formed but unknown token with 422', async () => {
    const response = await resetWith(WELL_FORMED_UNKNOWN_TOKEN)
    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(response.json().error.code).toBe(PASSWORD_RESET_FAILED_CODE)
  })

  it('rejects an expired token with 422', async () => {
    const rawToken = 'E'.repeat(43)
    const [account] = await db.select().from(users)
    await db.insert(passwordResetTokens).values({
      id: '9e9e9e9e-9999-4999-8999-999999999999',
      userId: account?.id ?? '',
      tokenHash: new Sha256TokenDigest().hash(rawToken),
      issuedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-01T00:30:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    })

    const response = await resetWith(rawToken)
    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
  })

  it('rejects a malformed token with 400', async () => {
    const response = await resetWith(MALFORMED_TOKEN)
    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
})
