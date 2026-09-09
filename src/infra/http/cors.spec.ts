import { describe, expect, it } from 'vitest'
import { registerCors } from './cors.js'
import { buildServer } from './server.js'

const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
} as never

const ALLOWED_ORIGIN = 'http://localhost:8081'

describe('registerCors', () => {
  it('answers a preflight from the local front-end with credentialed CORS headers', async () => {
    const app = buildServer(TEST_ENV)
    await registerCors(app)
    app.get('/ping', async () => ({ ok: true }))

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
    })

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    await app.close()
  })

  it('never echoes an origin outside the allow-list back to the caller', async () => {
    const app = buildServer(TEST_ENV)
    await registerCors(app)
    app.get('/ping', async () => ({ ok: true }))

    const response = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://evil.example' },
    })

    // The plugin pins a single static origin, so a foreign caller only ever
    // sees the local one — which its browser then rejects as a mismatch.
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(response.headers['access-control-allow-origin']).not.toContain('evil')
    await app.close()
  })
})
