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
const DOWN_BODY = { status: 'error', database: 'down' }

// Port 1 is never a Postgres: the connection is refused, which is a real
// failure rather than a stubbed one.
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/nowhere'

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

  it('reports 503 when the database is unreachable', async () => {
    const response = await injectHealth({
      ...env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    })

    expect(response.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS_CODE)
    expect(response.json()).toEqual(DOWN_BODY)
  })
})
