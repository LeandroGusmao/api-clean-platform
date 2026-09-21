import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { auditEvents } from '#modules/auth/infra/drizzle/schema/audit-events'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported: these values ARE the wire contract.
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

// Spelled out: the subject is what the owner reads.
const REUSE_NOTICE_SUBJECT = 'A session on your account was signed out'
/**
 * Raised so the suite's own traffic never trips the login ceiling: every test
 * logs in, and the file has more tests than the default allows a minute.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000
const REPLAY_ATTEMPTS = 3
const ONE_NOTICE = 1
/** The exact type stored; spelled out, not imported. */
const REUSE_EVENT = 'REFRESH_TOKEN_REUSE_DETECTED'
const ONE_EVENT = 1
const NO_NOTICES = 0
const MILLISECONDS_PER_SECOND = 1000
const ONE_DAY_MS = 86_400_000
const MAX_LIFETIME_MS = env.REFRESH_TOKEN_MAX_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND
const ONE_FAMILY = 1
const ONE_LIVE_TOKEN = 1
const NO_LIVE_TOKENS = 0

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
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
  await db.delete(outboxMessages)
  await db.delete(auditEvents)
  await db.delete(refreshTokens)
  await db.delete(users)
  // Inserted directly: `register` writes a `pending_registrations` row, not a
  // user, and the real SMTP-delivered confirm flow is `verify-email.spec.ts`'s
  // job — refresh rotation only needs the account to already BE verified.
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })
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

/** Moves the family's start so that its ceiling lands `remainingMs` from now. */
const startSessionWithCeilingIn = (remainingMs: number) =>
  db
    .update(refreshTokens)
    .set({ sessionStartedAt: new Date(Date.now() - MAX_LIFETIME_MS + remainingMs) })

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

  it('warns the owner ONCE however many times the spent token is replayed', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    await ageOutTheGraceWindow()

    // Three replays of the same spent token: the first kills the family, the
    // other two find nothing left to revoke and must not queue another notice.
    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      const reused = await refresh({ refreshToken })
      expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)
    }

    const notices = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, REUSE_NOTICE_SUBJECT))

    expect(notices).toHaveLength(ONE_NOTICE)
    expect(notices[0]?.to).toBe(EMAIL)
  })

  it('records ONE audit event however many times the spent token is replayed', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    await ageOutTheGraceWindow()

    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      const reused = await refresh({ refreshToken })
      expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)
    }

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.type, REUSE_EVENT))

    expect(events).toHaveLength(ONE_EVENT)
  })

  it('refuses to renew a session past its ceiling, without treating it as reuse', async () => {
    const { refreshToken } = (await login()).json()
    await startSessionWithCeilingIn(-ONE_DAY_MS)

    const refused = await refresh({ refreshToken })

    expect(refused.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(refused.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)

    // Not reuse: the family is left alone and no notice is queued.
    const [row] = await db.select().from(refreshTokens)
    expect(row?.revokedAt).toBeNull()
    expect(await db.select().from(outboxMessages)).toHaveLength(NO_NOTICES)
  })

  it('renews a session before its ceiling and stamps the ceiling as the expiry', async () => {
    const { refreshToken } = (await login()).json()
    await startSessionWithCeilingIn(ONE_DAY_MS)

    const rotated = await refresh({ refreshToken })

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)

    const successor = (await db.select().from(refreshTokens)).find(
      (row) => row.revokedAt === null,
    )
    expect(successor?.expiresAt).toEqual(
      new Date((successor?.sessionStartedAt?.getTime() ?? 0) + MAX_LIFETIME_MS),
    )
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

  it('refuses a second replay of the same predecessor, never forking the family', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })
    await refresh({ refreshToken })

    const second = await refresh({ refreshToken })

    expect(second.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(second.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)
    const live = (await db.select().from(refreshTokens)).filter(
      (row) => row.revokedAt === null,
    )
    expect(live).toHaveLength(NO_LIVE_TOKENS)
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
