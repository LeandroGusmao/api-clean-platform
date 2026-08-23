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
import { buildServer, REDACTED_CENSOR } from '#infra/http/server'
import { getTraceId } from '#infra/observability/request-context'

const SECRET_VALUE = 'super-secret'
const LOG_MESSAGE = 'log line under test'
const NO_LOG_LINE_MESSAGE = 'the logger wrote nothing'

const TRACE_PROBE_PATH = '/trace-probe'
const GET_METHOD = 'GET'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const testEnv: Env = {
  NODE_ENV: NODE_ENV_TEST,
  HOST: DEFAULT_HOST,
  PORT: DEFAULT_PORT,
  LOG_LEVEL: DEFAULT_LOG_LEVEL,
  DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
}

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
  const app = buildServer(testEnv, { logStream: stream })
  close = () => app.close()

  app.log.info(payload, LOG_MESSAGE)

  const [first] = parseLogLines(lines)
  if (first === undefined) throw new Error(NO_LOG_LINE_MESSAGE)

  return first
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
})

describe('buildServer request correlation', () => {
  async function injectProbe(): Promise<{
    body: { traceId?: string }
    logged: LogLine[]
  }> {
    const { lines, stream } = createLogCollector()
    const app: FastifyInstance = buildServer(testEnv, { logStream: stream })
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
