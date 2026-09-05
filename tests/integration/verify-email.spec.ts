import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { emailVerificationTokens } from '#modules/auth/infra/drizzle/schema/email-verification-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import {
  clearMailpit,
  extractVerificationCode,
  latestMessage,
  messageCount,
  waitForMessageCount,
} from './setup/mailpit.js'

// Spelled out rather than imported from the endpoints: these values ARE the
// wire contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const CONFIRM_EMAIL_PATH = '/auth/email/verify'
const RESEND_PATH = '/auth/email/verify/resend'
const POST_METHOD = 'POST'

const ACCEPTED_STATUS_CODE = 202
const OK_STATUS_CODE = 200
const FORBIDDEN_STATUS_CODE = 403
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

// `send(null)` on a 202 puts these four bytes on the wire, with a JSON content
// type — unlike a 204, where Fastify strips the body entirely.
const NULL_BODY = 'null'
const CONTENT_TYPE_HEADER = 'content-type'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED'
const EMAIL_VERIFICATION_FAILED_CODE = 'EMAIL_VERIFICATION_FAILED'

const EMAIL = 'joao@example.com'
const UNKNOWN_EMAIL = 'nobody@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
/**
 * Two distinct passwords for the pre-hijack test below: whoever's registration
 * attempt ends up bound to the live code must be the one whose password
 * survives, and two DIFFERENT passwords is what makes login prove which one
 * that was.
 */
const ATTACKER_PASSWORD = 'attacker-p4ssw0rd!'
const VICTIM_PASSWORD = 'victim-p4ssw0rd!'

/**
 * A wrong code, guaranteed to differ from the real one: flipping the first
 * digit means it can never collide, unlike a fixed literal such as
 * `'000000'`, which is a real six-digit code once in 10^6 tries and would
 * make the attempt-cap test flaky against a live generator.
 */
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code[0])
  const flippedFirstDigit = (firstDigit + 1) % 10
  return `${flippedFirstDigit}${code.slice(1)}`
}

const REFRESH_COOKIE_NAME = 'refresh_token'
const BODY_TRANSPORT = 'body'
const COOKIE_TRANSPORT = 'cookie'
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/
const NO_COOKIES = 0

const ONE_MESSAGE = 1
const TWO_MESSAGES = 2
const NO_MESSAGES = 0
/** Matches `DEFAULT_EMAIL_VERIFICATION_MAX_ATTEMPTS` — the number under test. */
const WRONG_ATTEMPTS_TO_EXHAUST_THE_CAP = 5

const ROW_MISSING_MESSAGE = 'no user row was stored'

/**
 * Elevated well past anything this suite spends, the same pattern
 * `login.spec.ts` and `change-password.spec.ts` use for their own ceilings.
 *
 * The resend cooldown is disabled outright (0 seconds): several cases here
 * call resend immediately after register, which the shipped 60-second cooldown
 * exists specifically to block from an anonymous caller. The single case that
 * exercises the cooldown itself belongs to a narrower, dedicated suite — this
 * one is proving the confirm/resend WIRING against a real mailbox, not the
 * cooldown's own arithmetic.
 *
 * `0` is outside the valid domain `authEnvSchema` declares for this variable
 * (`.positive()` in `config.ts` — a real deployment could never boot with
 * this value). That is safe ONLY here: `buildApp` takes an already-parsed
 * config object and never re-runs it through `authEnvSchema`, so nothing
 * re-validates this override. Do not copy this fixture into a test that
 * exercises `parseEnv` or boots the app from raw `process.env` strings.
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
  // Children first: the cascade would take them anyway, but deleting in
  // dependency order keeps this hook honest about what it does.
  await db.delete(refreshTokens)
  await db.delete(emailVerificationTokens)
  await db.delete(users)
  await clearMailpit()
})

function register(email: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email, password },
  })
}

function login(email: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email, password },
  })
}

function confirmEmail(email: string, code: string, payload: object) {
  return app.inject({
    method: POST_METHOD,
    url: CONFIRM_EMAIL_PATH,
    payload: { email, code, ...payload },
  })
}

function resend(email: string) {
  return app.inject({
    method: POST_METHOD,
    url: RESEND_PATH,
    payload: { email },
  })
}

/**
 * Registers, waits for Mailpit to hold the resulting message — see
 * `POLL_TIMEOUT_MS` in `setup/mailpit.ts` for why this is a poll and not a
 * fixed `sleep` — and returns the real six-digit code it carries.
 */
async function registerAndFetchCode(email: string, password: string): Promise<string> {
  await register(email, password)
  await waitForMessageCount(ONE_MESSAGE)
  const message = await latestMessage()
  return extractVerificationCode(message.text)
}

describe('the email verification flow, against a real SMTP server', () => {
  it('answers 202 on register, with exactly one message reaching the mailbox', async () => {
    const response = await register(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
    expect(response.headers[CONTENT_TYPE_HEADER]).toBe(JSON_CONTENT_TYPE)

    await waitForMessageCount(ONE_MESSAGE)
  })

  it('confirms the account with the code from that message, and opens a session', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)

    const response = await confirmEmail(EMAIL, code, { refreshTransport: BODY_TRANSPORT })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    expect(response.json().refreshToken).toEqual(expect.any(String))

    const [row] = await db.select().from(users).where(eq(users.email, EMAIL))
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)
    expect(row.emailVerifiedAt).not.toBeNull()
  })

  it('answers 403 EMAIL_NOT_VERIFIED at login before the code is confirmed', async () => {
    await register(EMAIL, PASSWORD)

    const response = await login(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(FORBIDDEN_STATUS_CODE)
    expect(response.json().error.code).toBe(EMAIL_NOT_VERIFIED_CODE)
  })

  it('answers 200 at login after the code is confirmed', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)
    await confirmEmail(EMAIL, code, { refreshTransport: BODY_TRANSPORT })

    const response = await login(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(OK_STATUS_CODE)
  })

  it('binds the live code to the password of the registration that issued it, not an earlier one', async () => {
    // The attack this pins: an attacker registers an address first, with
    // THEIR password. The victim, unaware the address is taken, registers for
    // real afterwards — the insert collides, and the 202 response gives no
    // sign the address was ever taken. Before the fix, the collision path
    // issued a fresh code but left the ATTACKER's password hash in place; the
    // victim would confirm the mail they just received, believe the account
    // was theirs, and the attacker — not the victim — would be the one able
    // to log in.
    await register(EMAIL, ATTACKER_PASSWORD)
    await waitForMessageCount(ONE_MESSAGE)

    const victimRegistration = await register(EMAIL, VICTIM_PASSWORD)
    expect(victimRegistration.statusCode).toBe(ACCEPTED_STATUS_CODE)
    await waitForMessageCount(TWO_MESSAGES)

    // The victim reads the mail that just arrived and confirms with the code
    // it carries — the one the collision path issued for THEIR request.
    const message = await latestMessage()
    const code = extractVerificationCode(message.text)
    const confirmation = await confirmEmail(EMAIL, code, {
      refreshTransport: BODY_TRANSPORT,
    })
    expect(confirmation.statusCode).toBe(OK_STATUS_CODE)

    // The fix: the collision path rewrote the password hash in the SAME
    // transaction that issued this code, so the victim's password — the one
    // bound to the code they just confirmed with — is the one that survives.
    const withVictimPassword = await login(EMAIL, VICTIM_PASSWORD)
    expect(withVictimPassword.statusCode).toBe(OK_STATUS_CODE)

    // And the attacker's earlier password, which created the row but never
    // proved control of the mailbox, must no longer work.
    const withAttackerPassword = await login(EMAIL, ATTACKER_PASSWORD)
    expect(withAttackerPassword.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('refuses to confirm the same code a second time', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)
    const first = await confirmEmail(EMAIL, code, { refreshTransport: BODY_TRANSPORT })
    expect(first.statusCode).toBe(OK_STATUS_CODE)

    const second = await confirmEmail(EMAIL, code, { refreshTransport: BODY_TRANSPORT })

    expect(second.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(second.json().error.code).toBe(EMAIL_VERIFICATION_FAILED_CODE)
  })

  it('exhausts the attempt cap on five wrong codes, and then refuses the correct one too', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)
    const wrongCode = wrongCodeFor(code)

    let lastWrongAttempt = await confirmEmail(EMAIL, wrongCode, {
      refreshTransport: BODY_TRANSPORT,
    })
    for (let spent = 1; spent < WRONG_ATTEMPTS_TO_EXHAUST_THE_CAP; spent++) {
      lastWrongAttempt = await confirmEmail(EMAIL, wrongCode, {
        refreshTransport: BODY_TRANSPORT,
      })
    }
    expect(lastWrongAttempt.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)

    const withTheCorrectCode = await confirmEmail(EMAIL, code, {
      refreshTransport: BODY_TRANSPORT,
    })

    expect(withTheCorrectCode.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(withTheCorrectCode.json().error.code).toBe(EMAIL_VERIFICATION_FAILED_CODE)
  })

  it('delivers a new message on resend, and the old code stops working', async () => {
    const oldCode = await registerAndFetchCode(EMAIL, PASSWORD)

    const response = await resend(EMAIL)
    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)

    await waitForMessageCount(TWO_MESSAGES)
    const newMessage = await latestMessage()
    const newCode = extractVerificationCode(newMessage.text)
    expect(newCode).not.toBe(oldCode)

    const withTheOldCode = await confirmEmail(EMAIL, oldCode, {
      refreshTransport: BODY_TRANSPORT,
    })
    expect(withTheOldCode.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)

    const withTheNewCode = await confirmEmail(EMAIL, newCode, {
      refreshTransport: BODY_TRANSPORT,
    })
    expect(withTheNewCode.statusCode).toBe(OK_STATUS_CODE)
  })

  it('answers 202 and delivers nothing when resend targets an address with no account', async () => {
    // No `waitForMessageCount` here: for an unknown address the use case
    // returns before it ever reaches the mailer (see
    // `RequestEmailVerificationUseCase`), so there is no send racing this
    // check — unlike every other case in this file, nothing is ever put on the
    // wire for this request to wait for.
    const response = await resend(UNKNOWN_EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(response.body).toBe(NULL_BODY)
    expect(await messageCount()).toBe(NO_MESSAGES)
  })

  it('returns the refresh token in the body for body transport, and sets no cookie', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)

    const response = await confirmEmail(EMAIL, code, { refreshTransport: BODY_TRANSPORT })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().refreshToken).toEqual(expect.any(String))
    expect(response.cookies).toHaveLength(NO_COOKIES)
  })

  it('sets the refresh cookie for cookie transport, and omits the token from the body', async () => {
    const code = await registerAndFetchCode(EMAIL, PASSWORD)

    const response = await confirmEmail(EMAIL, code, {
      refreshTransport: COOKIE_TRANSPORT,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    // The whole point of the cookie: if the token is ALSO in the body, the
    // SPA's JavaScript can read it and HttpOnly has bought nothing.
    expect(response.json().refreshToken).toBeUndefined()
    const cookie = response.cookies.find((each) => each.name === REFRESH_COOKIE_NAME)
    expect(cookie?.value).toEqual(expect.any(String))
    expect(cookie?.httpOnly).toBe(true)
  })
})
