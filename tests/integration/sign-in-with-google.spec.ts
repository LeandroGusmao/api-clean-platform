import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { type GoogleJwksServer, startGoogleJwksServer } from './setup/google-jwks.js'
import {
  clearMailpit,
  extractVerificationCode,
  latestMessage,
  waitForMessageCount,
} from './setup/mailpit.js'

const GOOGLE_PATH = '/auth/google'
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const CONFIRM_PATH = '/auth/email/verify'
const POST = 'POST'

const OK = 200
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const CONFLICT = 409

const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const APP_PASSWORD = 'sup3r-s3cr3t!'
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/
const CEILING = 1000
const NO_COOLDOWN = 0
const ONE_MESSAGE = 1
/** The exact subject of `googleAccountLinkedEmail`; spelled out, not imported. */
const GOOGLE_ACCOUNT_LINKED_SUBJECT = 'A Google sign-in was connected to your account'

let app: FastifyInstance
let db: Database
let pool: Pool
let jwks: GoogleJwksServer

beforeAll(async () => {
  jwks = await startGoogleJwksServer(env.GOOGLE_CLIENT_ID)
  app = await buildApp({
    ...env,
    GOOGLE_JWKS_URI: jwks.url,
    GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: CEILING,
    REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING,
    EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS: CEILING,
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: NO_COOLDOWN,
  })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
  await jwks.close()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(federatedIdentities)
  await db.delete(pendingRegistrations)
  await db.delete(outboxMessages)
  await db.delete(users)
  await clearMailpit()
})

const idToken = (claims: Record<string, unknown> = {}) =>
  jwks.sign({ sub: SUBJECT, email: EMAIL, ...claims })

const googleSignIn = (payload: Record<string, unknown>) =>
  app.inject({ method: POST, url: GOOGLE_PATH, payload })

/** Registers and confirms with a password, so the address has a real password account. */
async function createPasswordAccount(): Promise<void> {
  await app.inject({ method: POST, url: REGISTER_PATH, payload: { email: EMAIL } })
  await waitForMessageCount(ONE_MESSAGE)
  const code = extractVerificationCode((await latestMessage()).text)
  await app.inject({
    method: POST,
    url: CONFIRM_PATH,
    payload: { email: EMAIL, code, password: APP_PASSWORD, refreshTransport: 'body' },
  })
  await clearMailpit()
}

describe('POST /auth/google', () => {
  it('creates a verified passwordless account for a new email and returns a session', async () => {
    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(OK)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    expect(response.json().refreshToken).toEqual(expect.any(String))

    const [row] = await db.select().from(users).where(eq(users.email, EMAIL))
    expect(row?.passwordHash).toBeNull()
    expect(row?.emailVerifiedAt).not.toBeNull()

    const [link] = await db.select().from(federatedIdentities)
    expect(link?.providerUserId).toBe(SUBJECT)
    expect(link?.userId).toBe(row?.id)
  })

  it('takes the fast path on the second sign-in — no new link row', async () => {
    await googleSignIn({ idToken: await idToken() })
    const second = await googleSignIn({ idToken: await idToken() })

    expect(second.statusCode).toBe(OK)
    expect(await db.select().from(federatedIdentities)).toHaveLength(1)
  })

  it('answers 409 when the email already has a password account and no password is sent', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(CONFLICT)
    expect(response.json().error.code).toBe('GOOGLE_LINK_REQUIRES_PASSWORD')
  })

  it('links to the password account when the right password is supplied, and emails a warning', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({
      idToken: await idToken(),
      password: APP_PASSWORD,
    })

    expect(response.statusCode).toBe(OK)
    expect(await db.select().from(federatedIdentities)).toHaveLength(1)
    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, GOOGLE_ACCOUNT_LINKED_SUBJECT))
    expect(rows).toHaveLength(ONE_MESSAGE)
    expect(rows[0]?.dispatchedAt).toBeNull()
  })

  it('answers 401 for a wrong password on the link path', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({ idToken: await idToken(), password: 'wrong' })

    expect(response.statusCode).toBe(UNAUTHORIZED)
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS')
  })

  it('clears a pending registration for the address (Google wins)', async () => {
    await app.inject({ method: POST, url: REGISTER_PATH, payload: { email: EMAIL } })
    await waitForMessageCount(ONE_MESSAGE)
    await clearMailpit()

    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(OK)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('sets an HttpOnly refresh cookie in cookie mode', async () => {
    const response = await googleSignIn({
      idToken: await idToken(),
      refreshTransport: 'cookie',
    })

    expect(response.statusCode).toBe(OK)
    expect(response.json().refreshToken).toBeUndefined()
    expect(response.headers['set-cookie']).toEqual(
      expect.stringContaining('refresh_token='),
    )
  })

  it('rejects an unknown field with 400 (.strict())', async () => {
    const response = await googleSignIn({ idToken: await idToken(), role: 'admin' })

    expect(response.statusCode).toBe(BAD_REQUEST)
  })

  it('answers 401 for an unverified-email token', async () => {
    const response = await googleSignIn({
      idToken: await idToken({ email_verified: false }),
    })

    expect(response.statusCode).toBe(UNAUTHORIZED)
    expect(response.json().error.code).toBe('INVALID_GOOGLE_IDENTITY')
  })

  it('lets a linked account keep signing in with its password too', async () => {
    await createPasswordAccount()
    await googleSignIn({ idToken: await idToken(), password: APP_PASSWORD })

    const login = await app.inject({
      method: POST,
      url: LOGIN_PATH,
      payload: { email: EMAIL, password: APP_PASSWORD },
    })

    expect(login.statusCode).toBe(OK)
  })
})
