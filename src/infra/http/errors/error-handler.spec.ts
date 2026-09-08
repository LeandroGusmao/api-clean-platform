import { Writable } from 'node:stream'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Env, NODE_ENV_DEVELOPMENT } from '#infra/config/env'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { ValidationDetail } from '#infra/http/errors/validation-issues'
import { DOCS_ROUTE_PREFIX, registerOpenApi } from '#infra/http/openapi'
import { buildServer } from '#infra/http/server'
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransientError,
  UnauthorizedError,
  ValidationError,
} from '#shared/errors/app-error'

const THROW_PATH = '/probe/throw'
const GET_METHOD = 'GET'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const PROBE_ERROR_CODE = 'PROBE_ERROR'
const PROBE_ERROR_MESSAGE = 'Probe failed'
/** Stands in for anything a driver might put in an error: never client-visible. */
const INTERNAL_DETAIL = 'connection to 10.0.0.5:5432 refused'

// Wire contract — spelled out rather than imported, so a rename of the
// constants cannot keep this suite green while breaking every client.
const BAD_REQUEST_STATUS = 400
const UNAUTHORIZED_STATUS = 401
const FORBIDDEN_STATUS = 403
const NOT_FOUND_STATUS = 404
const CONFLICT_STATUS = 409
const UNPROCESSABLE_ENTITY_STATUS = 422
const INTERNAL_SERVER_ERROR_STATUS = 500
const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR'
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

const VALIDATE_PATH = '/probe/validate'
const POST_METHOD = 'POST'
const MIN_PASSWORD_LENGTH = 8
const INVALID_EMAIL = 'not-an-email'
const SHORT_PASSWORD = 'abc'

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const VALIDATION_ERROR_MESSAGE = 'Invalid payload'
const EMAIL_FIELD = 'email'
const PASSWORD_FIELD = 'password'
const INVALID_FORMAT_CODE = 'INVALID_FORMAT'
const TOO_SMALL_CODE = 'TOO_SMALL'

const UNKNOWN_PATH = '/definitely-not-a-route'
// Fastify ships parsers for `application/json` AND `text/plain`, so neither is
// unsupported. XML has none, which is what makes it raise the 415.
const UNSUPPORTED_CONTENT_TYPE = 'application/xml'
const CONTENT_TYPE_HEADER = 'content-type'
const UNSUPPORTED_PAYLOAD = '<request/>'
const UNSUPPORTED_MEDIA_TYPE_STATUS = 415
const SERVICE_UNAVAILABLE_STATUS = 503
const TOO_MANY_REQUESTS_STATUS = 429
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'
const RETRY_AFTER_HEADER = 'retry-after'
const RETRY_AFTER_SECONDS = 1
const OK_STATUS = 200
const DOCS_JSON_PATH = `${DOCS_ROUTE_PREFIX}/json`

const BAD_REQUEST_CODE = 'BAD_REQUEST'
const ROUTE_NOT_FOUND_CODE = 'ROUTE_NOT_FOUND'
const ROUTE_NOT_FOUND_MESSAGE = 'Route not found'

class ProbeNotFoundError extends NotFoundError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeConflictError extends ConflictError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeUnauthorizedError extends UnauthorizedError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeForbiddenError extends ForbiddenError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeValidationError extends ValidationError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeBusinessRuleError extends BusinessRuleError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeTransientError extends TransientError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
/** Extends the base directly, skipping the taxonomy: a programming mistake. */
class RogueAppError extends AppError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(INTERNAL_DETAIL)
  }
}

/** Same status and code as `ProbeUnauthorizedError`; only the marker differs. */
class ProbeSecurityEventError extends UnauthorizedError {
  readonly code = PROBE_ERROR_CODE
  override readonly securityEvent = true
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}

const openApps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

/** pino's numeric level for `warn`. Every other line in these suites is 30 (info) or 50 (error). */
const PINO_WARN_LEVEL = 40

/** Parses each captured line as its own JSON log record, skipping blanks. */
function logEntries(log: string): Array<Record<string, unknown>> {
  return log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/** A server whose log is captured instead of printed. Closed in `afterEach`. */
function createApp(): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  const app = buildServer(TEST_ENV, { logStream: stream })
  openApps.push(app)

  return { app, lines }
}

async function injectThrow(error: unknown): Promise<{
  statusCode: number
  body: string
  json: () => unknown
  headers: Record<string, unknown>
  log: string
}> {
  const { app, lines } = createApp()

  app.get(THROW_PATH, async () => {
    throw error
  })

  const response = await app.inject({ method: GET_METHOD, url: THROW_PATH })

  return {
    statusCode: response.statusCode,
    body: response.body,
    json: () => response.json(),
    headers: response.headers,
    log: lines.join(''),
  }
}

describe('error handler — taxonomy', () => {
  // Status before factory so the `%i` in the test name picks the status up.
  const STATUS_TABLE: ReadonlyArray<[string, number, () => AppError]> = [
    ['NotFoundError', NOT_FOUND_STATUS, () => new ProbeNotFoundError()],
    ['ConflictError', CONFLICT_STATUS, () => new ProbeConflictError()],
    ['UnauthorizedError', UNAUTHORIZED_STATUS, () => new ProbeUnauthorizedError()],
    ['ForbiddenError', FORBIDDEN_STATUS, () => new ProbeForbiddenError()],
    ['ValidationError', BAD_REQUEST_STATUS, () => new ProbeValidationError()],
    [
      'BusinessRuleError',
      UNPROCESSABLE_ENTITY_STATUS,
      () => new ProbeBusinessRuleError(),
    ],
    ['TransientError', SERVICE_UNAVAILABLE_STATUS, () => new ProbeTransientError()],
  ]

  it.each(STATUS_TABLE)('answers %s with %i', async (_name, expectedStatus, create) => {
    const result = await injectThrow(create())

    expect(result.statusCode).toBe(expectedStatus)
  })

  it('answers with the contract envelope', async () => {
    const result = await injectThrow(new ProbeNotFoundError())

    expect(result.json()).toEqual({
      error: {
        code: PROBE_ERROR_CODE,
        message: PROBE_ERROR_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a body that satisfies the published error schema', async () => {
    // Keeps the handler and the schema that OpenAPI publishes from drifting
    // apart: they are the same contract, described in two places.
    const result = await injectThrow(new ProbeNotFoundError())

    expect(errorResponseSchema.safeParse(result.json()).success).toBe(true)
  })

  // The header is what makes 503 actionable: without it the client knows the
  // request may be retried but not when, and a tight retry loop against a
  // database already under contention is worse than not retrying at all.
  it('tells the client when to come back on a transient failure', async () => {
    const result = await injectThrow(new ProbeTransientError())

    expect(result.headers[RETRY_AFTER_HEADER]).toBe(String(RETRY_AFTER_SECONDS))
  })

  // Every other category answers without one: a 409 is not going to resolve
  // itself, and a Retry-After there would invite a pointless retry.
  it('sends no Retry-After on a failure that repeating cannot fix', async () => {
    const result = await injectThrow(new ProbeConflictError())

    expect(result.headers[RETRY_AFTER_HEADER]).toBeUndefined()
  })
})

describe('error handler — security events', () => {
  // Reuse of a spent refresh token is the case this exists for: the response
  // is an ordinary 401, so without this the only trace that detection ever
  // fired is gone the moment the reply is sent.
  it('logs a warning naming the code, for an error marked as a security event', async () => {
    const result = await injectThrow(new ProbeSecurityEventError())

    const warnings = logEntries(result.log).filter(
      (entry) => entry.level === PINO_WARN_LEVEL,
    )

    expect(warnings).toEqual([expect.objectContaining({ code: PROBE_ERROR_CODE })])
  })

  // Same status and code as the security-event probe above — only the marker
  // differs — so this proves the branch reads `securityEvent` and not `code`
  // or `status`.
  it('logs nothing extra for an ordinary AppError of the same status and code', async () => {
    const result = await injectThrow(new ProbeUnauthorizedError())

    const warnings = logEntries(result.log).filter(
      (entry) => entry.level === PINO_WARN_LEVEL,
    )

    expect(warnings).toEqual([])
  })
})

describe('error handler — unexpected errors', () => {
  it('answers 500 with a generic envelope', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.json()).toEqual({
      error: {
        code: INTERNAL_ERROR_CODE,
        message: INTERNAL_ERROR_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('never leaks the internal message to the client', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.body).not.toContain(INTERNAL_DETAIL)
  })

  it('records the internal message in the log', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.log).toContain(INTERNAL_DETAIL)
  })

  it('treats an AppError outside the six categories as unexpected', async () => {
    const result = await injectThrow(new RogueAppError())

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.body).not.toContain(PROBE_ERROR_CODE)
    expect(result.log).toContain(INTERNAL_DETAIL)
  })
})

async function injectPayload(
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const { app } = createApp()

  app.withTypeProvider<ZodTypeProvider>().post(
    VALIDATE_PATH,
    {
      schema: {
        body: z.object({
          email: z.email(),
          password: z.string().min(MIN_PASSWORD_LENGTH),
        }),
      },
    },
    async () => ({ accepted: true }),
  )

  // The return type is spelled out: `inject` is chainable, and TypeScript
  // infers its call signature as an intersection that has no `json()`.
  return await app.inject({ method: POST_METHOD, url: VALIDATE_PATH, payload })
}

describe('error handler — validation', () => {
  it('answers 400 rather than 500 for an invalid payload', async () => {
    const response = await injectPayload({
      email: INVALID_EMAIL,
      password: SHORT_PASSWORD,
    })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS)
  })

  it('reports one detail per invalid field, in the contract codes', async () => {
    const response = await injectPayload({
      email: INVALID_EMAIL,
      password: SHORT_PASSWORD,
    })

    expect(response.json()).toEqual({
      error: {
        code: VALIDATION_ERROR_CODE,
        message: VALIDATION_ERROR_MESSAGE,
        details: [
          { field: EMAIL_FIELD, code: INVALID_FORMAT_CODE },
          { field: PASSWORD_FIELD, code: TOO_SMALL_CODE },
        ],
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a validation body that satisfies the published error schema', async () => {
    const response = await injectPayload({
      email: INVALID_EMAIL,
      password: SHORT_PASSWORD,
    })

    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true)
  })
})

describe('error handler — framework errors', () => {
  it('answers an unsupported content type with 415 in the envelope', async () => {
    const { app } = createApp()

    app.post(VALIDATE_PATH, async () => ({ accepted: true }))

    const response = await app.inject({
      method: POST_METHOD,
      url: VALIDATE_PATH,
      payload: UNSUPPORTED_PAYLOAD,
      headers: { [CONTENT_TYPE_HEADER]: UNSUPPORTED_CONTENT_TYPE },
    })

    expect(response.statusCode).toBe(UNSUPPORTED_MEDIA_TYPE_STATUS)
    expect(response.json()).toMatchObject({
      error: {
        code: BAD_REQUEST_CODE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('does not pass through a 5xx raised by the framework', async () => {
    const frameworkError = Object.assign(new Error(INTERNAL_DETAIL), {
      statusCode: SERVICE_UNAVAILABLE_STATUS,
    })

    const result = await injectThrow(frameworkError)

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.body).not.toContain(INTERNAL_DETAIL)
  })

  it('answers an unregistered route with the envelope, not the Fastify default shape', async () => {
    const { app } = createApp()

    const response = await app.inject({ method: GET_METHOD, url: UNKNOWN_PATH })

    expect(response.statusCode).toBe(NOT_FOUND_STATUS)
    expect(response.json()).toEqual({
      error: {
        code: ROUTE_NOT_FOUND_CODE,
        message: ROUTE_NOT_FOUND_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('leaves the OpenAPI document reachable', async () => {
    // The one open question from the design spec: a custom not-found handler
    // installed on the root instance could plausibly shadow the docs routes.
    const developmentEnv: Env = { ...TEST_ENV, NODE_ENV: NODE_ENV_DEVELOPMENT }
    const { app } = createApp()

    await registerOpenApi(app, developmentEnv)
    app.post(VALIDATE_PATH, async () => ({ accepted: true }))
    await app.ready()

    const response = await app.inject({ method: GET_METHOD, url: DOCS_JSON_PATH })

    expect(response.statusCode).toBe(OK_STATUS)
  })
})

describe('validation vocabulary', () => {
  // This is the guard the translation table used to pretend to be. It drives a
  // real payload through real Zod and pins every code the API publishes, so a
  // Zod upgrade that renames an issue turns the suite red instead of silently
  // changing a public contract.
  const VOCABULARY_PATH = '/probe/vocabulary'
  const ROOT_FIELD = '(body)'
  const MIN_AGE = 18
  const MIN_TAGS = 1
  const MAX_BIO_LENGTH = 10
  const QUANTITY_STEP = 5
  const SLUG_PREFIX = 'x'
  const SLUG_MESSAGE = 'must start with the slug prefix'

  const vocabularySchema = z
    .object({
      email: z.email(),
      password: z.string().min(MIN_PASSWORD_LENGTH),
      age: z.number().min(MIN_AGE),
      role: z.enum(['admin', 'member']),
      tags: z.array(z.string()).min(MIN_TAGS),
      bio: z.string().max(MAX_BIO_LENGTH),
      qty: z.number().multipleOf(QUANTITY_STEP),
      slug: z.string().refine((value) => value.startsWith(SLUG_PREFIX), SLUG_MESSAGE),
      either: z.union([z.number(), z.boolean()]),
      meta: z.record(z.string(), z.number()),
    })
    .strict()

  const invalidPayload = {
    email: 'nope',
    password: 'abc',
    age: 12,
    role: 'wizard',
    tags: [],
    bio: 'a bio well past the limit',
    qty: 3,
    slug: 'zzz',
    either: 'neither',
    meta: { a: 'not a number' },
    unexpected: true,
  }

  it('publishes exactly these codes for real Zod issues', async () => {
    const { app } = createApp()

    app
      .withTypeProvider<ZodTypeProvider>()
      .post(VOCABULARY_PATH, { schema: { body: vocabularySchema } }, async () => ({
        accepted: true,
      }))

    const response = await app.inject({
      method: POST_METHOD,
      url: VOCABULARY_PATH,
      payload: invalidPayload,
    })
    const details = (response.json() as { error: { details: ValidationDetail[] } }).error
      .details
    const published = Object.fromEntries(
      details.map((d) => [d.field ?? ROOT_FIELD, d.code]),
    )

    expect(published).toEqual({
      email: 'INVALID_FORMAT',
      password: 'TOO_SMALL',
      age: 'TOO_SMALL',
      role: 'INVALID_VALUE',
      tags: 'TOO_SMALL',
      bio: 'TOO_BIG',
      qty: 'NOT_MULTIPLE_OF',
      slug: 'INVALID_VALUE',
      either: 'INVALID_VALUE',
      'meta.a': 'INVALID_TYPE',
      [ROOT_FIELD]: 'UNRECOGNIZED_KEYS',
    })
  })
})

describe('error handler — rate limiting', () => {
  const RATE_LIMIT_MESSAGE = 'Rate limit exceeded, retry in 1 minute'

  /**
   * Shaped like what `@fastify/rate-limit` throws: a plain `Error` carrying
   * `statusCode` and no `code` of its own (measured on 11.2.0). Built here
   * rather than imported, so this suite never needs the plugin to run.
   */
  const rateLimitError = () => {
    const error = new Error(RATE_LIMIT_MESSAGE)
    Object.assign(error, { statusCode: TOO_MANY_REQUESTS_STATUS })

    return error
  }

  // Without a branch of its own it lands in the generic 4xx path and publishes
  // BAD_REQUEST — "you sent something wrong" instead of "you sent too much,
  // come back later", which are opposite instructions to a client.
  it('publishes TOO_MANY_REQUESTS rather than BAD_REQUEST', async () => {
    const result = await injectThrow(rateLimitError())

    expect(result.statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
    expect(result.json()).toEqual({
      error: {
        code: TOO_MANY_REQUESTS_CODE,
        message: RATE_LIMIT_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a body that satisfies the published error schema', async () => {
    const result = await injectThrow(rateLimitError())

    expect(errorResponseSchema.safeParse(result.json()).success).toBe(true)
  })

  // The handler adds none: the plugin already put one on the reply before
  // throwing, carrying the seconds that actually remain in the window. A second
  // one here would overwrite a real value with a guess.
  it('leaves the Retry-After the limiter itself measured', async () => {
    const result = await injectThrow(rateLimitError())

    expect(result.headers[RETRY_AFTER_HEADER]).toBeUndefined()
  })
})
