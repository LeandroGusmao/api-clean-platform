import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { registerRateLimit } from '#infra/http/rate-limit'
import type { RateLimitRedis } from '#infra/http/redis-rate-limit-store'
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

const GLOBAL_CEILING = 100
const OWN_CEILING = 2
const MILLISECONDS_PER_SECOND = 1000
const SERVICE_UNAVAILABLE_STATUS = 503
const STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const DRIVER_ADDRESS = '10.0.0.5'

const PLAIN_PATH = '/probe/plain'
const OWN_PATH = '/probe/own'
const OTHER_OWN_PATH = '/probe/other-own'

/** A Redis that counts like the real one, keyed the way the script receives it. */
function countingRedis() {
  const counts = new Map<string, number>()
  const evalScript = vi.fn(
    async (_script: string, _keyCount: number, key: string, windowMs: number) => {
      const current = (counts.get(key) ?? 0) + 1
      counts.set(key, current)

      return [current, windowMs]
    },
  )

  return { redis: { eval: evalScript } as unknown as RateLimitRedis, evalScript }
}

function brokenRedis(): RateLimitRedis {
  return {
    eval: vi
      .fn()
      .mockRejectedValue(new Error(`connect ECONNREFUSED ${DRIVER_ADDRESS}:6379`)),
  } as unknown as RateLimitRedis
}

/**
 * Two routes declaring their own ceiling and one that does not — the split the
 * store makes. The global ceiling is far above what any case spends, so a 429
 * here can only come from a route's own.
 */
async function buildRedisBackedServer(
  redis: RateLimitRedis,
  logStream: Writable = discardedLog(),
): Promise<FastifyInstance> {
  const app = buildServer(
    { ...TEST_ENV, RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING },
    { logStream },
  )
  openApps.push(app)

  await registerRateLimit(
    app,
    {
      RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING,
      RATE_LIMIT_WINDOW_SECONDS: WINDOW_SECONDS,
    },
    redis,
  )

  const ownCeiling = {
    config: {
      rateLimit: {
        max: OWN_CEILING,
        timeWindow: WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
      },
    },
  }
  app.get(PLAIN_PATH, async () => ({ ok: true }))
  app.get(OWN_PATH, ownCeiling, async () => ({ ok: true }))
  app.get(OTHER_OWN_PATH, ownCeiling, async () => ({ ok: true }))
  await app.ready()

  return app
}

describe('registerRateLimit with a Redis store', () => {
  it('counts a route with its own ceiling in Redis and every other route in process', async () => {
    const { redis, evalScript } = countingRedis()
    const app = await buildRedisBackedServer(redis)

    await get(app, PLAIN_PATH)
    expect(evalScript).not.toHaveBeenCalled()

    await get(app, OWN_PATH)
    expect(evalScript).toHaveBeenCalledTimes(1)
  })

  // The whole point of the store: two replicas, one number.
  it('shares the count of a route with its own ceiling across servers', async () => {
    const { redis } = countingRedis()
    const first = await buildRedisBackedServer(redis)
    const second = await buildRedisBackedServer(redis)

    expect((await get(first, OWN_PATH)).statusCode).toBe(OK_STATUS)
    expect((await get(second, OWN_PATH)).statusCode).toBe(OK_STATUS)

    expect((await get(first, OWN_PATH)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
  })

  it('keeps one count per route', async () => {
    const { redis } = countingRedis()
    const app = await buildRedisBackedServer(redis)

    for (let attempt = 0; attempt < OWN_CEILING; attempt++) {
      expect((await get(app, OWN_PATH)).statusCode).toBe(OK_STATUS)
    }

    expect((await get(app, OTHER_OWN_PATH)).statusCode).toBe(OK_STATUS)
  })

  it('refuses a route with its own ceiling while Redis fails, and keeps answering the others', async () => {
    const app = await buildRedisBackedServer(brokenRedis())

    const refused = await get(app, OWN_PATH)

    expect(refused.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS)
    expect(refused.json().error.code).toBe(STORE_UNAVAILABLE_CODE)
    expect(refused.headers[RETRY_AFTER_HEADER]).toBeDefined()
    expect((await get(app, PLAIN_PATH)).statusCode).toBe(OK_STATUS)
  })

  // A 503 with no log line would make a control that stopped controlling look
  // like ordinary traffic; and the driver error must not ride along with it.
  it('leaves a security event in the log, without the driver error', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
    const app = await buildRedisBackedServer(brokenRedis(), stream)

    const refused = await get(app, OWN_PATH)

    const logged = lines.join('')
    expect(logged).toContain(`"code":"${STORE_UNAVAILABLE_CODE}"`)
    expect(logged).toContain('security event')
    expect(logged).not.toContain(DRIVER_ADDRESS)
    expect(refused.body).not.toContain(DRIVER_ADDRESS)
  })
})
