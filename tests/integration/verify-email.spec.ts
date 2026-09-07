import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import {
  clearMailpit,
  extractVerificationCode,
  latestMessage,
  waitForMessageCount,
} from './setup/mailpit.js'

// Spelled out rather than imported from the endpoints: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const CONFIRM_EMAIL_PATH = '/auth/email/verify'
const POST_METHOD = 'POST'

const ACCEPTED_STATUS_CODE = 202
const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422
const BAD_REQUEST_STATUS_CODE = 400

const EMAIL_VERIFICATION_FAILED_CODE = 'EMAIL_VERIFICATION_FAILED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
/**
 * Two distinct passwords for the pre-hijack tests: with 4.3 there is no
 * attacker password stored anywhere, so what these prove is that the account
 * ends up with exactly the password supplied at confirmation, and no other.
 */
const VICTIM_PASSWORD = 'victim-p4ssw0rd!'
const ATTACKER_PASSWORD = 'attacker-p4ssw0rd!'
const WEAK_PASSWORD = 'abcdefghij'

/**
 * A wrong code, guaranteed to differ from the real one: flipping the first
 * digit means it can never collide, unlike a fixed literal such as `'000000'`.
 */
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code[0])
  const flippedFirstDigit = (firstDigit + 1) % 10
  return `${flippedFirstDigit}${code.slice(1)}`
}

const BODY_TRANSPORT = 'body'
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/

const ONE_MESSAGE = 1
const TWO_MESSAGES = 2
const WRONG_ATTEMPTS_TO_EXHAUST_THE_CAP = 5
const ONE_USER_ROW = 1

const USER_ROW_MISSING_MESSAGE = 'no user row was stored'

/**
 * Elevated well past anything this suite spends, the same pattern the other
 * endpoint suites use for their own ceilings. The resend cooldown is disabled
 * outright (0 seconds): several cases call register twice for the same address
 * in quick succession, which the shipped 60-second cooldown exists to fold into
 * a no-op.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000
const NO_RESEND_COOLDOWN_SECONDS = 0

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
    REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: NO_RESEND_COOLDOWN_SECONDS,
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
  await db.delete(pendingRegistrations)
  await db.delete(users)
  await clearMailpit()
})

function register(email: string) {
  return app.inject({ method: POST_METHOD, url: REGISTER_PATH, payload: { email } })
}

function login(email: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email, password },
  })
}

function confirmEmail(email: string, code: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: CONFIRM_EMAIL_PATH,
    payload: { email, code, password, refreshTransport: BODY_TRANSPORT },
  })
}

/** Registers, waits for the message, returns the six-digit code it carries. */
async function registerAndFetchCode(email: string): Promise<string> {
  await register(email)
  await waitForMessageCount(ONE_MESSAGE)
  return extractVerificationCode((await latestMessage()).text)
}

describe('the email verification flow, against a real SMTP server', () => {
  it('answers 202 on register, with exactly one message reaching the mailbox', async () => {
    const response = await register(EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    await waitForMessageCount(ONE_MESSAGE)
  })

  it('confirms with the code and the chosen password, creates the verified account, opens a session', async () => {
    const code = await registerAndFetchCode(EMAIL)

    const response = await confirmEmail(EMAIL, code, PASSWORD)

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    expect(response.json().refreshToken).toEqual(expect.any(String))

    const [row] = await db.select().from(users).where(eq(users.email, EMAIL))
    if (row === undefined) throw new Error(USER_ROW_MISSING_MESSAGE)
    expect(row.emailVerifiedAt).not.toBeNull()

    expect((await login(EMAIL, PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('rejects a malformed password with 400, before any code check', async () => {
    const code = await registerAndFetchCode(EMAIL)

    const bad = await confirmEmail(EMAIL, code, WEAK_PASSWORD)
    expect(bad.statusCode).toBe(BAD_REQUEST_STATUS_CODE)

    // The attempt was not spent: the real code still works right after.
    const good = await confirmEmail(EMAIL, code, PASSWORD)
    expect(good.statusCode).toBe(OK_STATUS_CODE)
  })

  it('pre-hijack, attacker first: the account gets the password the victim confirmed with', async () => {
    // Attacker registers the victim's address first. The victim, unaware,
    // registers for real afterwards — both codes now sit in the victim's inbox.
    await register(EMAIL)
    await waitForMessageCount(ONE_MESSAGE)

    await register(EMAIL)
    await waitForMessageCount(TWO_MESSAGES)

    // The victim confirms with the code from the message she just received, and
    // her own password.
    const code = extractVerificationCode((await latestMessage()).text)
    const confirmation = await confirmEmail(EMAIL, code, VICTIM_PASSWORD)
    expect(confirmation.statusCode).toBe(OK_STATUS_CODE)

    expect((await login(EMAIL, VICTIM_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
    // There is no attacker password anywhere: the account has exactly the one
    // the victim set.
    expect((await login(EMAIL, ATTACKER_PASSWORD)).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
  })

  it('pre-hijack, victim first (the ordering slice 10 could not close): the victim keeps her code and her password', async () => {
    // The victim registers first and holds the code from that message.
    const victimCode = await registerAndFetchCode(EMAIL)

    // The attacker registers the same address afterwards. Under slice 10 this
    // invalidated the victim's code; here it coexists and hers still works.
    await register(EMAIL)
    await waitForMessageCount(TWO_MESSAGES)

    const confirmation = await confirmEmail(EMAIL, victimCode, VICTIM_PASSWORD)
    expect(confirmation.statusCode).toBe(OK_STATUS_CODE)

    expect((await login(EMAIL, VICTIM_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('an attacker brute-forcing their own pending burns its cap and cannot confirm', async () => {
    const code = await registerAndFetchCode(EMAIL)
    const wrong = wrongCodeFor(code)

    for (let guess = 0; guess < WRONG_ATTEMPTS_TO_EXHAUST_THE_CAP; guess += 1) {
      const attempt = await confirmEmail(EMAIL, wrong, ATTACKER_PASSWORD)
      expect(attempt.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    }

    // The real code no longer works: the pending's cap is spent.
    const withRealCode = await confirmEmail(EMAIL, code, ATTACKER_PASSWORD)
    expect(withRealCode.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(withRealCode.json().error.code).toBe(EMAIL_VERIFICATION_FAILED_CODE)

    expect(await db.select().from(users)).toHaveLength(0)
  })

  it('holds the attempt cap under CONCURRENT wrong guesses against one pending', async () => {
    const code = await registerAndFetchCode(EMAIL)
    const wrong = wrongCodeFor(code)

    const CONCURRENT_WRONG_GUESSES = 10
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_WRONG_GUESSES }, () =>
        confirmEmail(EMAIL, wrong, PASSWORD),
      ),
    )
    expect(
      responses.every((r) => r.statusCode === UNPROCESSABLE_ENTITY_STATUS_CODE),
    ).toBe(true)

    const [pending] = await db
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.email, EMAIL))
    expect(pending?.attempts).toBeLessThanOrEqual(WRONG_ATTEMPTS_TO_EXHAUST_THE_CAP)
  })

  it('two confirms racing two codes of the same address: one wins, exactly one verified user', async () => {
    const firstCode = await registerAndFetchCode(EMAIL)
    await register(EMAIL)
    await waitForMessageCount(TWO_MESSAGES)
    const secondCode = extractVerificationCode((await latestMessage()).text)

    const [a, b] = await Promise.all([
      confirmEmail(EMAIL, firstCode, PASSWORD),
      confirmEmail(EMAIL, secondCode, VICTIM_PASSWORD),
    ])

    const statuses = [a.statusCode, b.statusCode].sort()
    expect(statuses).toEqual([OK_STATUS_CODE, UNPROCESSABLE_ENTITY_STATUS_CODE])

    const rows = await db.select().from(users).where(eq(users.email, EMAIL))
    expect(rows).toHaveLength(ONE_USER_ROW)
    expect(rows[0]?.emailVerifiedAt).not.toBeNull()
  })

  it('a second confirm with the same code, after success, gets the generic failure', async () => {
    const code = await registerAndFetchCode(EMAIL)
    expect((await confirmEmail(EMAIL, code, PASSWORD)).statusCode).toBe(OK_STATUS_CODE)

    const second = await confirmEmail(EMAIL, code, PASSWORD)
    expect(second.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(second.json().error.code).toBe(EMAIL_VERIFICATION_FAILED_CODE)
  })
})
