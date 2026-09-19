import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Env, env } from '#infra/config/env'
import { buildApp } from '#main/app'

// Spelled out rather than imported from the endpoint on purpose: these values
// ARE the wire contract. Importing them would make the assertions tautological
// — renaming `OK_STATUS` to `'okay'` would break every client and still keep
// this suite green.
const HEALTH_PATH = '/health'
const GET_METHOD = 'GET'
const OK_STATUS_CODE = 200
const SERVICE_UNAVAILABLE_STATUS_CODE = 503
const OK_BODY = { status: 'ok', database: 'up' }

const CONTENT_TYPE_OPTIONS_HEADER = 'x-content-type-options'
const NO_SNIFF = 'nosniff'
const DOWN_BODY = { status: 'error', database: 'down' }

// Port 1 is never a Postgres: the connection is refused, which is a real
// failure rather than a stubbed one.
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/nowhere'

/** Low enough that a probe polling every few seconds would trip it at once. */
const CEILING_A_PROBE_WOULD_TRIP = 2
const PROBES_SENT = CEILING_A_PROBE_WOULD_TRIP * 3

/** Keeps the expected error log off the suite output. */
const silentStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

async function injectHealth(withEnv: Env) {
  // The same function `main/http.ts` calls: whatever gets composed there is
  // exercised here, with no second list to keep in sync by hand.
  const app = await buildApp(withEnv, { logStream: silentStream })

  try {
    return await app.inject({ method: GET_METHOD, url: HEALTH_PATH })
  } finally {
    // Closes the database pool too, through the `onClose` hook in `buildApp`.
    await app.close()
  }
}

describe('GET /health', () => {
  it('reports 200 while the database answers', async () => {
    const response = await injectHealth(env)

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toEqual(OK_BODY)
  })

  it('sends transport security headers on every response', async () => {
    // Asserted on the cheapest route there is, because the headers are global:
    // a route-local assertion would pass while every other route went bare.
    const response = await injectHealth(env)

    expect(response.headers[CONTENT_TYPE_OPTIONS_HEADER]).toBe(NO_SNIFF)
  })

  it('reports 503 when the database is unreachable', async () => {
    const response = await injectHealth({
      ...env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    })

    expect(response.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS_CODE)
    expect(response.json()).toEqual(DOWN_BODY)
  })

  /**
   * The rate limiter must never reach this route. A liveness probe polls it
   * every few seconds from ONE address — the orchestrator's — so under any
   * realistic ceiling it would start taking 429s, and the orchestrator would
   * kill the pod. The limiter would take down the application it protects.
   *
   * `rate-limit.spec.ts` proves the opt-out MECHANISM works. This proves this
   * route actually uses it, which is a different claim: the measured trap is
   * that `allowList` looks like the way to do it and exempts nothing.
   */
  it('is never rate limited, however low the ceiling', async () => {
    const app = await buildApp(
      { ...env, RATE_LIMIT_MAX_REQUESTS: CEILING_A_PROBE_WOULD_TRIP },
      { logStream: silentStream },
    )

    try {
      for (let probe = 0; probe < PROBES_SENT; probe++) {
        const response = await app.inject({ method: GET_METHOD, url: HEALTH_PATH })

        expect(response.statusCode).toBe(OK_STATUS_CODE)
      }
    } finally {
      await app.close()
    }
  })
})
