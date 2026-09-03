import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { registerRateLimit } from '#infra/http/rate-limit'
import { buildServer } from '#infra/http/server'

const MAX_REQUESTS = 2
const WINDOW_SECONDS = 60

const OK_STATUS = 200
const TOO_MANY_REQUESTS_STATUS = 429
const GET_METHOD = 'GET'
const RETRY_AFTER_HEADER = 'retry-after'
const FORWARDED_FOR_HEADER = 'x-forwarded-for'

// Wire contract — spelled out rather than imported, so a rename cannot keep
// this suite green while breaking every client.
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'

const PROBE_PATH = '/probe/limited'
const HEALTH_PATH = '/probe/health'

const openApps: FastifyInstance[] = []

/** Keeps the suite's output readable; nothing here asserts on the log. */
const discardedLog = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

/**
 * `buildServer` already registers the error handling, so the envelope asserted
 * below is the real one and not a stand-in.
 *
 * `trustProxy` is on because two of these cases need `X-Forwarded-For` to be
 * read at all; `app.inject` arrives from 127.0.0.1, which `loopback` trusts.
 */
async function buildLimitedServer(): Promise<FastifyInstance> {
  const app = buildServer(
    {
      ...TEST_ENV,
      TRUST_PROXY: 'loopback',
      RATE_LIMIT_MAX_REQUESTS: MAX_REQUESTS,
      RATE_LIMIT_WINDOW_SECONDS: WINDOW_SECONDS,
    },
    { logStream: discardedLog() },
  )
  openApps.push(app)

  await registerRateLimit(app, {
    RATE_LIMIT_MAX_REQUESTS: MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS: WINDOW_SECONDS,
  })

  app.get(PROBE_PATH, async () => ({ ok: true }))
  app.get(HEALTH_PATH, { config: { rateLimit: false } }, async () => ({ ok: true }))
  await app.ready()

  return app
}

const get = (app: FastifyInstance, url: string, forwardedFor?: string) =>
  app.inject({
    method: GET_METHOD,
    url,
    ...(forwardedFor === undefined
      ? {}
      : { headers: { [FORWARDED_FOR_HEADER]: forwardedFor } }),
  })

describe('registerRateLimit', () => {
  it('answers 429 in the project envelope once the ceiling is passed', async () => {
    const app = await buildLimitedServer()

    for (let attempt = 0; attempt < MAX_REQUESTS; attempt++) {
      expect((await get(app, PROBE_PATH)).statusCode).toBe(OK_STATUS)
    }

    const blocked = await get(app, PROBE_PATH)

    expect(blocked.statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
    expect(blocked.json().error.code).toBe(TOO_MANY_REQUESTS_CODE)
    expect(blocked.json().error.traceId).toEqual(expect.any(String))
    // Set by the limiter before it throws, and it survives the error handler.
    expect(blocked.headers[RETRY_AFTER_HEADER]).toBeDefined()
  })

  // If this goes red, a Kubernetes liveness probe starts taking 429s and the
  // orchestrator kills the pod: the limiter would take down the application it
  // exists to protect.
  //
  // It also pins the MECHANISM. `allowList: ['/health']` looks like the way to
  // do this and exempts nothing — measured — because the list is compared
  // against the generated key, not against the path.
  it('never throttles a route that opted out', async () => {
    const app = await buildLimitedServer()

    for (let attempt = 0; attempt < MAX_REQUESTS * 3; attempt++) {
      expect((await get(app, HEALTH_PATH)).statusCode).toBe(OK_STATUS)
    }
  })

  // `request.ip` can be attacker-written text, so two forged values must not
  // buy two budgets — otherwise the limiter is decoration behind a proxy.
  it('gives every malformed client address one shared budget', async () => {
    const app = await buildLimitedServer()

    await get(app, PROBE_PATH, 'naoehip')
    await get(app, PROBE_PATH, 'outro-lixo-diferente')

    const blocked = await get(app, PROBE_PATH, 'um-terceiro-valor')

    expect(blocked.statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
  })

  // The other half of the rule above: real addresses must still be told apart,
  // or the limiter would punish everyone for one attacker.
  it('keeps distinct real addresses in distinct budgets', async () => {
    const app = await buildLimitedServer()

    for (let attempt = 0; attempt < MAX_REQUESTS; attempt++) {
      expect((await get(app, PROBE_PATH, '203.0.113.7')).statusCode).toBe(OK_STATUS)
    }

    expect((await get(app, PROBE_PATH, '198.51.100.4')).statusCode).toBe(OK_STATUS)
  })
})
