import { Writable } from 'node:stream'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { buildServer, REDACTED_CENSOR } from '#infra/http/server'
import { getTraceId } from '#infra/observability/request-context'

const SECRET_VALUE = 'super-secret'
const LOG_MESSAGE = 'log line under test'
const NO_LOG_LINE_MESSAGE = 'the logger wrote nothing'

const TRACE_PROBE_PATH = '/trace-probe'
const GET_METHOD = 'GET'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function createLogCollector() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, stream }
}

type LogLine = Record<string, unknown>

/**
 * pino writes one JSON object per line. A single request produces several, so
 * the collected chunks are joined and split rather than parsed whole.
 */
function parseLogLines(lines: string[]): LogLine[] {
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine)
}

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

async function logAndCapture(payload: Record<string, unknown>) {
  const { lines, stream } = createLogCollector()
  const app = buildServer(TEST_ENV, { logStream: stream })
  close = () => app.close()

  app.log.info(payload, LOG_MESSAGE)

  const [first] = parseLogLines(lines)
  if (first === undefined) throw new Error(NO_LOG_LINE_MESSAGE)

  return first
}

/**
 * Mirrors `error-handler.ts`'s `request.log.error({ err: error }, ...)` call,
 * the one real place an unhandled error reaches the logger. Returns the raw
 * joined text alongside the parsed line: a secret hiding in some field the
 * assertions do not think to check would still show up in the raw text.
 */
async function logErrorAndCapture(err: unknown) {
  const { lines, stream } = createLogCollector()
  const app = buildServer(TEST_ENV, { logStream: stream })
  close = () => app.close()

  app.log.error({ err }, LOG_MESSAGE)

  const rawLogText = lines.join('')
  const [first] = parseLogLines(lines)
  if (first === undefined) throw new Error(NO_LOG_LINE_MESSAGE)

  return { rawLogText, logged: first }
}

describe('buildServer logger redaction', () => {
  it('redacts secrets logged at the top level', async () => {
    const logged = await logAndCapture({ password: SECRET_VALUE, token: SECRET_VALUE })

    expect(logged.password).toBe(REDACTED_CENSOR)
    expect(logged.token).toBe(REDACTED_CENSOR)
  })

  it('redacts the authorization header', async () => {
    const logged = await logAndCapture({ headers: { authorization: SECRET_VALUE } })

    expect(logged).toMatchObject({ headers: { authorization: REDACTED_CENSOR } })
  })

  it('leaves secrets nested deeper than one level exposed', async () => {
    const logged = await logAndCapture({ outer: { inner: { password: SECRET_VALUE } } })

    // Documents the pino limitation behind the "never log whole objects" rule:
    // `*.password` matches exactly one level, so this value survives in the clear.
    expect(logged).toMatchObject({ outer: { inner: { password: SECRET_VALUE } } })
  })

  it('redacts a password hash at the top level and one level deep', async () => {
    const logged = await logAndCapture({
      passwordHash: SECRET_VALUE,
      user: { passwordHash: SECRET_VALUE },
    })

    // `password` does not cover `passwordHash`: pino matches whole key names,
    // not prefixes. Without its own entry the hash reaches the log in clear.
    expect(logged.passwordHash).toBe(REDACTED_CENSOR)
    expect(logged).toMatchObject({ user: { passwordHash: REDACTED_CENSOR } })
  })

  it('redacts an access token at the top level and one level deep', async () => {
    const logged = await logAndCapture({
      accessToken: SECRET_VALUE,
      session: { accessToken: SECRET_VALUE },
    })

    // Every other secret key carries both the bare and the `*.`-prefixed form;
    // `accessToken` only had the bare one, so a nested `session.accessToken`
    // survived in clear until `*.accessToken` was added.
    expect(logged.accessToken).toBe(REDACTED_CENSOR)
    expect(logged).toMatchObject({ session: { accessToken: REDACTED_CENSOR } })
  })
})

describe('buildServer error serialization', () => {
  // A realistic shape for `DrizzleQueryError`: its `.message` is not the query
  // text alone but `Failed query: ${query}\nparams: ${params}`, and `params` is
  // an enumerable own property — so both the message and a plain property walk
  // reach the bound values, one of which here is the argon2 hash.
  const QUERY_TEXT =
    'insert into "users" ("id", "email", "password_hash") values ($1, $2, $3)'
  const BOUND_USER_ID = '0f1c8a2e-58cf-4b1a-9d9e-1f7b6c9e2a10'
  const BOUND_EMAIL = 'registrant@example.com'
  const BOUND_ARGON2_HASH =
    '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$c29tZWhhc2hjb250ZW50c29tZWQ'
  const PG_UNIQUE_VIOLATION_CODE = '23505'
  const USERS_PKEY_CONSTRAINT = 'users_pkey'

  function buildParameterBearingError(): DrizzleQueryError {
    const cause = Object.assign(
      new Error(
        `duplicate key value violates unique constraint "${USERS_PKEY_CONSTRAINT}"`,
      ),
      { code: PG_UNIQUE_VIOLATION_CODE, constraint: USERS_PKEY_CONSTRAINT },
    )

    return new DrizzleQueryError(
      QUERY_TEXT,
      [BOUND_USER_ID, BOUND_EMAIL, BOUND_ARGON2_HASH],
      cause,
    )
  }

  it('keeps bound query parameters — the argon2 hash included — out of the log', async () => {
    const { rawLogText } = await logErrorAndCapture(buildParameterBearingError())

    expect(rawLogText).not.toContain(BOUND_ARGON2_HASH)
    expect(rawLogText).not.toContain(BOUND_EMAIL)
  })

  it('keeps the query text and the cause details a diagnosis needs', async () => {
    const { logged } = await logErrorAndCapture(buildParameterBearingError())

    expect(logged).toMatchObject({
      err: {
        message: QUERY_TEXT,
        cause: { code: PG_UNIQUE_VIOLATION_CODE, constraint: USERS_PKEY_CONSTRAINT },
      },
    })
  })
})

describe('buildServer request correlation', () => {
  async function injectProbe(): Promise<{
    body: { traceId?: string }
    logged: LogLine[]
  }> {
    const { lines, stream } = createLogCollector()
    const app: FastifyInstance = buildServer(TEST_ENV, { logStream: stream })
    close = () => app.close()

    app.get(TRACE_PROBE_PATH, async () => ({ traceId: getTraceId() }))

    const response = await app.inject({ method: GET_METHOD, url: TRACE_PROBE_PATH })

    return { body: response.json(), logged: parseLogLines(lines) }
  }

  it('generates a uuid traceId instead of a per-process counter', async () => {
    const { body } = await injectProbe()

    // `req-1` from two replicas is the same string: the default counter cannot
    // correlate anything beyond a single process.
    expect(body.traceId).toMatch(UUID_PATTERN)
  })

  it('logs the same traceId the request context exposes', async () => {
    const { body, logged } = await injectProbe()

    expect(logged.length).toBeGreaterThan(0)
    expect(logged.every((entry) => entry.traceId === body.traceId)).toBe(true)
  })
})
