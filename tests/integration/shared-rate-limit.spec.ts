import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Env, env } from '#infra/config/env'
import { buildApp } from '#main/app'
import { flushRedis } from './setup/redis.js'

// Spelled out rather than imported from the endpoints: these values ARE the
// wire contract. Importing them would make the assertions tautological.
const LOGIN_PATH = '/auth/login'
const ME_PATH = '/auth/me'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'

const UNAUTHORIZED_STATUS_CODE = 401
const TOO_MANY_REQUESTS_STATUS_CODE = 429
const SERVICE_UNAVAILABLE_STATUS_CODE = 503

const STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const RETRY_AFTER_HEADER = 'retry-after'

// Port 1 is never a Redis: the connection is refused, a real failure.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'

/** Small on purpose: the cases assert the behaviour, not the shipped numbers. */
const LOGIN_CEILING = 3
const GLOBAL_CEILING = 2

// An account that does not exist: the request is answered as a wrong credential,
// so it counts against the ceiling without needing any arranged state.
const UNKNOWN_ACCOUNT = { email: 'ninguem@example.com', password: 'wr0ng-p4ssword!' }

const openApps: FastifyInstance[] = []

beforeEach(flushRedis)

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

/**
 * Each call is one more replica: its own process-local state, the same Redis.
 * `logStream` is optional because `BuildServerOptions` does not admit an
 * explicit `undefined` for it.
 */
async function startReplica(
  overrides: Partial<Env> = {},
  logStream?: Writable,
): Promise<FastifyInstance> {
  const app = await buildApp(
    { ...env, ...overrides },
    logStream === undefined ? {} : { logStream },
  )
  openApps.push(app)
  await app.ready()

  return app
}

const login = (app: FastifyInstance) =>
  app.inject({ method: POST_METHOD, url: LOGIN_PATH, payload: UNKNOWN_ACCOUNT })

/** Answered by the auth guard with 401, so it costs nothing and counts globally. */
const me = (app: FastifyInstance) => app.inject({ method: GET_METHOD, url: ME_PATH })

describe('the shared rate limit', () => {
  // The problem the slice exists to close: with a counter per process, three
  // attempts split between two replicas were never more than two on either.
  it('holds one ceiling across two replicas', async () => {
    const overrides = { LOGIN_RATE_LIMIT_MAX_REQUESTS: LOGIN_CEILING }
    const first = await startReplica(overrides)
    const second = await startReplica(overrides)

    expect((await login(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(second)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)

    // The fourth is over the ceiling on EITHER replica.
    expect((await login(second)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
    expect((await login(first)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
  })

  // The other half of decision 39: the global ceiling is deliberately per
  // replica, so it neither costs a round trip nor depends on Redis.
  it('keeps the global ceiling per replica', async () => {
    const overrides = { RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING }
    const first = await startReplica(overrides)
    const second = await startReplica(overrides)

    for (let sent = 0; sent < GLOBAL_CEILING; sent++) {
      expect((await me(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    }
    expect((await me(first)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)

    // The other replica has not seen any of those requests.
    expect((await me(second)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('refuses the routes with their own ceiling, and only those, while Redis is down', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
    const app = await startReplica({ REDIS_URL: UNREACHABLE_REDIS_URL }, stream)

    const refused = await login(app)

    expect(refused.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS_CODE)
    expect(refused.json().error.code).toBe(STORE_UNAVAILABLE_CODE)
    expect(refused.headers[RETRY_AFTER_HEADER]).toBeDefined()

    // A route with no ceiling of its own never touches Redis: the auth guard
    // answers it as it would with Redis up.
    expect((await me(app)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)

    // The refusal is a security event, so it is in the log.
    expect(lines.join('')).toContain(`"code":"${STORE_UNAVAILABLE_CODE}"`)
  })
})
