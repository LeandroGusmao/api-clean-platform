import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { clearMailpit, messageCountTo, waitForMessageTo } from './setup/mailpit.js'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract.
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const ACCEPTED_STATUS_CODE = 202
const NULL_BODY = 'null'

const TARGET_EMAIL = 'ana@example.com'
const OTHER_TARGET_EMAIL = 'bia@example.com'
/**
 * An account registered AFTER each burst. Its notice is sent after every notice
 * of the burst was already accepted by SMTP, so once it shows up in Mailpit,
 * anything the burst sent has shown up too.
 */
const SENTINEL_EMAIL = 'sentinel@example.com'
const PASSWORD_HASH = 'unused'

const SEQUENTIAL_ATTEMPTS = 3
const CONCURRENT_ATTEMPTS = 10
const INSTANCES = 2
const ONE_NOTICE = 1
const NO_INSTANCE_MESSAGE = 'no application instance at index'

/** Far above anything this suite spends from its single address. */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

const silentStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

/** Two replicas of the same deployment: separate pools, one database. */
const instances: FastifyInstance[] = []
let db: Database
let pool: Pool

beforeAll(async () => {
  for (let instance = 0; instance < INSTANCES; instance++) {
    const app = await buildApp(
      { ...env, REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS },
      { logStream: silentStream },
    )
    await app.ready()
    instances.push(app)
  }
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  for (const app of instances) await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(pendingRegistrations)
  await db.delete(users)
  await db.insert(users).values(
    [TARGET_EMAIL, OTHER_TARGET_EMAIL, SENTINEL_EMAIL].map((email) => ({
      email,
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: new Date(),
    })),
  )
  await clearMailpit()
})

function instance(index: number): FastifyInstance {
  const app = instances[index % INSTANCES]
  if (app === undefined) throw new Error(`${NO_INSTANCE_MESSAGE} ${index}`)
  return app
}

function register(email: string, onInstance = 0) {
  return instance(onInstance).inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email },
  })
}

/** Waits for the sentinel's notice, which lands after everything sent before it. */
async function settle(): Promise<void> {
  const response = await register(SENTINEL_EMAIL)
  expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
  await waitForMessageTo(SENTINEL_EMAIL)
}

describe('POST /auth/register for an address that already has an account', () => {
  it('sends one notice for sequential attempts inside the cooldown, answering each the same way', async () => {
    for (let attempt = 0; attempt < SEQUENTIAL_ATTEMPTS; attempt++) {
      const response = await register(TARGET_EMAIL)

      expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
      expect(response.body).toBe(NULL_BODY)
    }

    await settle()
    expect(await messageCountTo(TARGET_EMAIL)).toBe(ONE_NOTICE)
  })

  it('sends one notice for concurrent attempts on one instance', async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => register(TARGET_EMAIL)),
    )

    for (const response of responses)
      expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    await settle()
    expect(await messageCountTo(TARGET_EMAIL)).toBe(ONE_NOTICE)
  })

  it('sends one notice for concurrent attempts spread across two instances', async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, (_, attempt) =>
        register(TARGET_EMAIL, attempt),
      ),
    )

    for (const response of responses)
      expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    await settle()
    expect(await messageCountTo(TARGET_EMAIL)).toBe(ONE_NOTICE)
  })

  it('keeps each recipient independent: one notice each, however the attempts interleave', async () => {
    await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, (_, attempt) =>
        // Recipient alternates on every attempt, instance on every second one, so
        // each recipient is hit from both instances.
        register(
          attempt % INSTANCES === 0 ? TARGET_EMAIL : OTHER_TARGET_EMAIL,
          Math.floor(attempt / INSTANCES),
        ),
      ),
    )

    await settle()
    expect(await messageCountTo(TARGET_EMAIL)).toBe(ONE_NOTICE)
    expect(await messageCountTo(OTHER_TARGET_EMAIL)).toBe(ONE_NOTICE)
  })
})
