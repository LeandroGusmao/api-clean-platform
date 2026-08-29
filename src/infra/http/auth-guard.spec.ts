import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  type Env,
  NODE_ENV_TEST,
} from '#infra/config/env'
import {
  getPrincipal,
  makeAuthGuard,
  type VerifyAccessToken,
} from '#infra/http/auth-guard'
import { buildServer } from '#infra/http/server'
import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS } from '#modules/auth/config'

// Duplicated from server.spec.ts and error-handler.spec.ts on purpose: it is a
// fixture, not a shared constant, and it is built from the same exported
// defaults, so the values cannot drift. A shared fixture module under `src/`
// would be compiled into `dist/` — `tsconfig.build.json` excludes only
// `*.spec.ts` — so extracting it is not free the way it looks; this is the
// third spec to carry the duplicate, and the duplication stays on purpose.
const testEnv: Env = {
  NODE_ENV: NODE_ENV_TEST,
  HOST: DEFAULT_HOST,
  PORT: DEFAULT_PORT,
  LOG_LEVEL: DEFAULT_LOG_LEVEL,
  DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
  JWT_SECRET: 'a-test-secret-with-at-least-32-chars',
  ACCESS_TOKEN_TTL_SECONDS: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
}

const GUARDED_PATH = '/probe/guarded'
const UNGUARDED_PATH = '/probe/unguarded'
const GET_METHOD = 'GET'
const VALID_TOKEN = 'a-valid-token'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'

/** Stands in for anything a verifier library might put in an error: never client-visible. */
const VERIFIER_INTERNAL_MESSAGE =
  'token verification failed with a message from the library'

const OK_STATUS = 200
const UNAUTHORIZED_STATUS = 401
const INTERNAL_SERVER_ERROR_STATUS = 500

const INVALID_ACCESS_TOKEN_CODE = 'INVALID_ACCESS_TOKEN'
const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR'

let app: FastifyInstance
const logLines: string[] = []

/** Both routes exist on every instance: one guarded, one deliberately not. */
function buildApp(verify: VerifyAccessToken): FastifyInstance {
  logLines.length = 0
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk))
      callback()
    },
  })

  const instance = buildServer(testEnv, { logStream })
  instance.get(GUARDED_PATH, { preHandler: makeAuthGuard(verify) }, async (request) => ({
    id: getPrincipal(request).id,
  }))
  instance.get(UNGUARDED_PATH, async (request) => ({ id: getPrincipal(request).id }))

  return instance
}

const acceptAnyToken: VerifyAccessToken = async () => ({ sub: USER_ID })
const rejectEveryToken: VerifyAccessToken = async () => {
  throw new Error(VERIFIER_INTERNAL_MESSAGE)
}

afterEach(async () => {
  await app?.close()
})

describe('makeAuthGuard', () => {
  it('passes the token subject to the handler', async () => {
    app = buildApp(acceptAnyToken)

    const response = await app.inject({
      method: GET_METHOD,
      url: GUARDED_PATH,
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })

    expect(response.statusCode).toBe(OK_STATUS)
    expect(response.json()).toEqual({ id: USER_ID })
  })

  it.each([
    ['no Authorization header', undefined],
    ['a Basic header', 'Basic dXNlcjpwYXNz'],
    ['a bare Bearer with no token', 'Bearer '],
    ['a header missing the scheme', VALID_TOKEN],
  ])('answers 401 in the project envelope for %s', async (_label, authorization) => {
    app = buildApp(acceptAnyToken)

    const response = await app.inject({
      method: GET_METHOD,
      url: GUARDED_PATH,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS)
    expect(response.json().error.code).toBe(INVALID_ACCESS_TOKEN_CODE)
    expect(response.json().error.traceId).toEqual(expect.any(String))
  })

  it('answers 401 without leaking why verification failed', async () => {
    app = buildApp(rejectEveryToken)

    const response = await app.inject({
      method: GET_METHOD,
      url: GUARDED_PATH,
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS)
    expect(response.body).not.toContain(VERIFIER_INTERNAL_MESSAGE)
  })
})

describe('getPrincipal on a route registered without the guard', () => {
  it('answers 500, not 401', async () => {
    // A wiring mistake by the developer, not a credential failure by the
    // client. A 401 here would read exactly like an expired token and send
    // whoever forgot the preHandler hunting in the client.
    app = buildApp(acceptAnyToken)

    const response = await app.inject({ method: GET_METHOD, url: UNGUARDED_PATH })

    expect(response.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(response.json().error.code).toBe(INTERNAL_SERVER_ERROR_CODE)
  })

  it('logs the reason while the client sees only the generic body', async () => {
    // Both halves are the assertion: the log is what makes the 500 better than
    // a silent 401, and the body is what keeps it from being a leak.
    app = buildApp(acceptAnyToken)

    const response = await app.inject({ method: GET_METHOD, url: UNGUARDED_PATH })

    expect(logLines.join('')).toContain('without the auth guard')
    expect(response.body).not.toContain('without the auth guard')
  })
})
