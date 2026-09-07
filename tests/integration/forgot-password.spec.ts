import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'
import {
  clearMailpit,
  latestMessage,
  messageCount,
  waitForMessageCount,
} from './setup/mailpit.js'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const FORGOT_PATH = '/auth/password/forgot'
const POST_METHOD = 'POST'

const ACCEPTED_STATUS_CODE = 202
const BAD_REQUEST_STATUS_CODE = 400

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const UNKNOWN_EMAIL = 'nobody@example.com'
const MALFORMED_EMAIL = 'not-an-email'

const PASSWORD_RESET_SUBJECT = 'Reset your password'
/** A bare six-digit code would mean the reset mail carries a numeric code, not a token. */
const SIX_DIGIT_PATTERN = /\b\d{6}\b/
/** The opaque reset token: base64url, 256 bits, so at least 32 characters. */
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_-]{32,}/

const NO_MESSAGES = 0
const ONE_MESSAGE = 1

/**
 * Elevated well past anything this suite spends, the same pattern the other
 * endpoint suites use for their own ceilings: several cases call `forgot` more
 * than once for the same address, and the shipped ceiling exists to stop that.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
    PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
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
  await db.delete(users)
  await clearMailpit()
})

const forgot = (email: string) =>
  app.inject({ method: POST_METHOD, url: FORGOT_PATH, payload: { email } })

describe('POST /auth/password/forgot, against a real SMTP server', () => {
  it('answers 202 and emails a reset token for an address with an account', async () => {
    await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

    const response = await forgot(EMAIL)
    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)

    await waitForMessageCount(ONE_MESSAGE)
    const message = await latestMessage()
    expect(message.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(message.text).toMatch(OPAQUE_TOKEN_PATTERN)
    expect(message.text).not.toMatch(SIX_DIGIT_PATTERN)
  })

  it('answers 202 and emails nothing for an address with no account', async () => {
    const response = await forgot(UNKNOWN_EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(await messageCount()).toBe(NO_MESSAGES)
  })

  it('does not send a second email inside the resend cooldown', async () => {
    await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

    await forgot(EMAIL)
    await waitForMessageCount(ONE_MESSAGE)
    await forgot(EMAIL)

    // The shipped 60s cooldown holds; still exactly one message.
    expect(await messageCount()).toBe(ONE_MESSAGE)
  })

  it('answers 400 to a malformed address', async () => {
    const response = await forgot(MALFORMED_EMAIL)

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
})
