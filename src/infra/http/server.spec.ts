import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  type Env,
  NODE_ENV_TEST,
} from '#infra/config/env'
import { buildServer, REDACTED_CENSOR } from '#infra/http/server'

const SECRET_VALUE = 'super-secret'
const LOG_MESSAGE = 'log line under test'

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

  return JSON.parse(lines.join(''))
}

describe('buildServer logger redaction', () => {
  it('redacts secrets logged at the top level', async () => {
    const logged = await logAndCapture({ password: SECRET_VALUE, token: SECRET_VALUE })

    expect(logged.password).toBe(REDACTED_CENSOR)
    expect(logged.token).toBe(REDACTED_CENSOR)
  })

  it('redacts the authorization header', async () => {
    const logged = await logAndCapture({ headers: { authorization: SECRET_VALUE } })

    expect(logged.headers.authorization).toBe(REDACTED_CENSOR)
  })

  it('leaves secrets nested deeper than one level exposed', async () => {
    const logged = await logAndCapture({ outer: { inner: { password: SECRET_VALUE } } })

    // Documents the pino limitation behind the "never log whole objects" rule:
    // `*.password` matches exactly one level, so this value survives in the clear.
    expect(logged.outer.inner.password).toBe(SECRET_VALUE)
  })
})
