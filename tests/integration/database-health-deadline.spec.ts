import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Env, env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { createDatabaseCheck } from '#infra/health/checks/database-check'
import { buildApp } from '#main/app'
import {
  type FreezableTcpProxy,
  startFreezableTcpProxy,
} from './setup/freezable-tcp-proxy.js'
import { TEST_DATABASE_URL } from './setup/test-database-url.js'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract.
const HEALTH_PATH = '/health'
const GET_METHOD = 'GET'
const OK_STATUS_CODE = 200
const SERVICE_UNAVAILABLE_STATUS_CODE = 503
const DOWN_BODY = { status: 'error', database: 'down', redis: 'up' }

const PROBE_TIMEOUT_MS = 500
/**
 * Scheduling slack on a loaded machine. Far below the failure this guards
 * against, which is a probe that never answers at all.
 */
const DEADLINE_SLACK_MS = 400
const WITHIN_DEADLINE_MS = PROBE_TIMEOUT_MS + DEADLINE_SLACK_MS

/**
 * Longer than the probe on purpose: the probe's own deadline, not the pool's
 * connection timeout, has to be what ends it.
 */
const CONNECTION_TIMEOUT_LONGER_THAN_THE_PROBE_MS = 10_000

const PROBES_WHILE_FROZEN = 5
/** At most one probe connection may be outstanding, however many probes ran. */
const AT_MOST_ONE = 1
const NONE = 0

const NEVER_RECOVERED_MESSAGE = 'the condition was not met before the recovery timeout'

const RECOVERY_POLL_INTERVAL_MS = 50
const RECOVERY_TIMEOUT_MS = 5_000

const silentStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

let proxy: FreezableTcpProxy
const pools: Pool[] = []
const apps: FastifyInstance[] = []

beforeEach(async () => {
  const target = new URL(TEST_DATABASE_URL)
  proxy = await startFreezableTcpProxy(target.hostname, Number(target.port))
})

afterEach(async () => {
  proxy.thaw()
  for (const app of apps.splice(0)) await app.close()
  for (const pool of pools.splice(0)) await pool.end()
  await proxy.close()
})

function proxiedEnv(): Env {
  return {
    ...env,
    DATABASE_URL: proxy.proxiedUrl(env.DATABASE_URL),
    DATABASE_CONNECTION_TIMEOUT_MS: CONNECTION_TIMEOUT_LONGER_THAN_THE_PROBE_MS,
    DATABASE_HEALTH_CHECK_TIMEOUT_MS: PROBE_TIMEOUT_MS,
  }
}

function proxiedPool(): Pool {
  const { pool } = createDatabase(proxiedEnv())
  pools.push(pool)
  return pool
}

async function timed<T>(
  work: () => Promise<T>,
): Promise<{ result: T; elapsedMs: number }> {
  const startedAt = performance.now()
  const result = await work()
  return { result, elapsedMs: performance.now() - startedAt }
}

async function eventually(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(NEVER_RECOVERED_MESSAGE)
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_INTERVAL_MS))
  }
}

describe('database health check against a database that stops answering', () => {
  it('reports down within its deadline when a connected database goes silent, and leaves no connection behind', async () => {
    const pool = proxiedPool()
    const check = createDatabaseCheck(pool, PROBE_TIMEOUT_MS)
    expect((await check()).up).toBe(true)

    proxy.freeze()

    const first = await timed(check)
    expect(first.result.up).toBe(false)
    expect(first.elapsedMs).toBeLessThan(WITHIN_DEADLINE_MS)
    // The client whose query never came back is dropped, not parked in the pool
    // for the next caller to queue behind — and its socket is closed.
    expect(pool.totalCount).toBe(NONE)
    await eventually(async () => proxy.openConnections() === NONE)

    for (let probe = 1; probe < PROBES_WHILE_FROZEN; probe++) {
      const { result, elapsedMs } = await timed(check)

      expect(result.up).toBe(false)
      expect(elapsedMs).toBeLessThan(WITHIN_DEADLINE_MS)
    }

    // The probes did not stack one connection attempt per call.
    expect(pool.totalCount).toBeLessThanOrEqual(AT_MOST_ONE)
    expect(pool.waitingCount).toBe(0)
    expect(proxy.openConnections()).toBeLessThanOrEqual(AT_MOST_ONE)
  })

  it('reports down within its deadline when the database goes silent before the first connection', async () => {
    const pool = proxiedPool()
    const check = createDatabaseCheck(pool, PROBE_TIMEOUT_MS)
    proxy.freeze()

    for (let probe = 0; probe < PROBES_WHILE_FROZEN; probe++) {
      const { result, elapsedMs } = await timed(check)

      expect(result.up).toBe(false)
      expect(elapsedMs).toBeLessThan(WITHIN_DEADLINE_MS)
    }

    expect(pool.totalCount).toBeLessThanOrEqual(AT_MOST_ONE)
    expect(proxy.openConnections()).toBeLessThanOrEqual(AT_MOST_ONE)
  })

  it('reports up again once the database answers, on the same pool', async () => {
    const pool = proxiedPool()
    const check = createDatabaseCheck(pool, PROBE_TIMEOUT_MS)
    expect((await check()).up).toBe(true)

    proxy.freeze()
    expect((await check()).up).toBe(false)
    expect((await check()).up).toBe(false)
    proxy.thaw()

    await eventually(async () => (await check()).up)
    expect(pool.totalCount).toBeLessThanOrEqual(AT_MOST_ONE)
  })

  it('answers GET /health with 503 within its deadline, still reporting Redis, and 200 once the database is back', async () => {
    const app = await buildApp(proxiedEnv(), { logStream: silentStream })
    apps.push(app)
    expect((await app.inject({ method: GET_METHOD, url: HEALTH_PATH })).statusCode).toBe(
      OK_STATUS_CODE,
    )

    proxy.freeze()
    const { result: response, elapsedMs } = await timed(() =>
      app.inject({ method: GET_METHOD, url: HEALTH_PATH }),
    )

    expect(response.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS_CODE)
    expect(response.json()).toEqual(DOWN_BODY)
    expect(elapsedMs).toBeLessThan(WITHIN_DEADLINE_MS)

    proxy.thaw()
    await eventually(
      async () =>
        (await app.inject({ method: GET_METHOD, url: HEALTH_PATH })).statusCode ===
        OK_STATUS_CODE,
    )
  })
})
