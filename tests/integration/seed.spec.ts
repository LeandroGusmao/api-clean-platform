import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { runSeed, type SeedLogger } from '#main/seeds/runner'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import {
  SEED_DEV_EMAIL,
  SEED_GOOGLE_EMAIL,
  SEED_GOOGLE_SUBJECT,
} from '#modules/auth/infra/seeds/base-users'
import { SEED_PASSWORD } from '#modules/auth/infra/seeds/index'
import {
  SEED_PENDING_EMAIL,
  SEED_VERIFICATION_CODE,
} from '#modules/auth/infra/seeds/pending-registration'
import { arrangeAccount } from './setup/arrange-account.js'

// Spelled out rather than imported from the endpoints: these values ARE the
// wire contract.
const LOGIN_PATH = '/auth/login'
const CONFIRM_EMAIL_PATH = '/auth/email/verify'
const POST_METHOD = 'POST'
const OK_STATUS_CODE = 200
const GOOGLE_PROVIDER = 'google'

const ALL_FLAG = '--all'
const PENDING_REGISTRATION_TARGET = 'auth:pending-registration'
const ONE_LINK = 1

const OUTSIDER_EMAIL = 'joao@example.com'
const OUTSIDER_PASSWORD = 'sup3r-s3cr3t!'

const SILENT_LOGGER: SeedLogger = { info: () => {}, warn: () => {} }

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
  await db.delete(federatedIdentities)
  await db.delete(passwordResetTokens)
  await db.delete(pendingRegistrations)
  await db.delete(users)
})

const post = (url: string, payload: object) =>
  app.inject({ method: POST_METHOD, url, payload })

async function snapshot() {
  const userRows = await db.select({ email: users.email }).from(users)
  const pendingRows = await db
    .select({ email: pendingRegistrations.email })
    .from(pendingRegistrations)
  const links = await db.select().from(federatedIdentities)
  return {
    userEmails: userRows.map((row) => row.email).sort(),
    pendingEmails: pendingRows.map((row) => row.email).sort(),
    linkCount: links.length,
  }
}

describe('auth seed', () => {
  it('creates a password account that logs in with the seed password', async () => {
    await runSeed(env, SILENT_LOGGER, [])

    const response = await post(LOGIN_PATH, {
      email: SEED_DEV_EMAIL,
      password: SEED_PASSWORD,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toHaveProperty('accessToken')
  })

  it('creates a verified Google-only account with no password', async () => {
    await runSeed(env, SILENT_LOGGER, [])

    const [user] = await db.select().from(users).where(eq(users.email, SEED_GOOGLE_EMAIL))
    expect(user?.passwordHash).toBeNull()
    expect(user?.emailVerifiedAt).not.toBeNull()

    const links = await db
      .select()
      .from(federatedIdentities)
      .where(eq(federatedIdentities.userId, user?.id ?? ''))
    expect(links).toHaveLength(ONE_LINK)
    expect(links[0]?.provider).toBe(GOOGLE_PROVIDER)
    expect(links[0]?.providerUserId).toBe(SEED_GOOGLE_SUBJECT)
  })

  it('creates a pending registration that confirms with the known code', async () => {
    await runSeed(env, SILENT_LOGGER, [PENDING_REGISTRATION_TARGET])

    const response = await post(CONFIRM_EMAIL_PATH, {
      email: SEED_PENDING_EMAIL,
      code: SEED_VERIFICATION_CODE,
      password: SEED_PASSWORD,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
  })

  it('lands on the same state when run twice', async () => {
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])
    const afterFirstRun = await snapshot()
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])

    expect(afterFirstRun).toEqual({
      userEmails: [SEED_DEV_EMAIL, SEED_GOOGLE_EMAIL].sort(),
      pendingEmails: [SEED_PENDING_EMAIL],
      linkCount: ONE_LINK,
    })
    expect(await snapshot()).toEqual(afterFirstRun)
  })

  it('leaves an account outside the seed namespace alone', async () => {
    await arrangeAccount(db, { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD })

    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])
    await runSeed(env, SILENT_LOGGER, [ALL_FLAG])

    const outsider = await db.select().from(users).where(eq(users.email, OUTSIDER_EMAIL))
    expect(outsider).toHaveLength(ONE_LINK)
  })
})
