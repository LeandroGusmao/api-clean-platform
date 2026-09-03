import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
  DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_DATABASE_LOCK_TIMEOUT_MS,
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  NODE_ENV_DEVELOPMENT,
  parseEnv,
} from '#infra/config/env'
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
} from '#modules/auth/config'

const VALID_DATABASE_URL = 'postgres://user:pass@localhost:5432/app'
const VALID_JWT_SECRET = 'a-test-secret-with-at-least-32-chars'

describe('parseEnv', () => {
  it('rejects an empty PORT instead of coercing it to zero', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      PORT: '',
    })

    expect(result.success).toBe(false)
  })

  it('rejects a missing DATABASE_URL', () => {
    const result = parseEnv({})

    expect(result.success).toBe(false)
  })

  // New: proves the module's schema actually reached the merge. Without this,
  // dropping the `.extend()` line would leave every other case green.
  it('rejects a missing JWT_SECRET', () => {
    const result = parseEnv({ DATABASE_URL: VALID_DATABASE_URL })

    expect(result.success).toBe(false)
  })

  it('applies defaults when only the required variables are provided', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      NODE_ENV: NODE_ENV_DEVELOPMENT,
      TRUST_PROXY: false,
      HOST: DEFAULT_HOST,
      PORT: DEFAULT_PORT,
      LOG_LEVEL: DEFAULT_LOG_LEVEL,
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      ACCESS_TOKEN_TTL_SECONDS: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      REFRESH_TOKEN_TTL_SECONDS: DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
      REFRESH_TOKEN_GRACE_WINDOW_SECONDS: DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS,
      DATABASE_POOL_MAX: DEFAULT_DATABASE_POOL_MAX,
      DATABASE_CONNECTION_TIMEOUT_MS: DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
      DATABASE_STATEMENT_TIMEOUT_MS: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
      DATABASE_LOCK_TIMEOUT_MS: DEFAULT_DATABASE_LOCK_TIMEOUT_MS,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS:
        DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    })
  })

  // The three Postgres timeouts read `0` as DISABLED, so an empty value must
  // not reach the schema as a number. `PORT` is protected by `.positive()`
  // rejecting the coerced zero; these accept zero on purpose, so emptiness has
  // to be caught before coercion. Without this test the safety net turns itself
  // off whenever someone blanks the value in a `.env`.
  it('rejects an empty database timeout instead of silently deferring', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      DATABASE_STATEMENT_TIMEOUT_MS: '',
    })

    expect(result.success).toBe(false)
  })

  // The other half of the rule above: rejecting emptiness must not cost the
  // ability to hand the decision to the server on purpose. Zero does not
  // disable the timeout — `pg` sends these only when truthy, so it leaves the
  // server's own setting in effect.
  it('accepts an explicit zero, which defers to the server setting', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      DATABASE_STATEMENT_TIMEOUT_MS: '0',
    })

    expect(result.success).toBe(true)
    expect(result.data?.DATABASE_STATEMENT_TIMEOUT_MS).toBe(0)
  })

  it('rejects a negative database timeout', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      DATABASE_LOCK_TIMEOUT_MS: '-1',
    })

    expect(result.success).toBe(false)
  })

  // A pool of zero connections serves no request at all, so unlike the
  // timeouts this one has no legitimate zero — and `.positive()` gives the
  // empty-value rejection for free, exactly as it does for `PORT`.
  it('rejects a pool size of zero', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      DATABASE_POOL_MAX: '0',
    })

    expect(result.success).toBe(false)
  })

  // `true` trusts the LEFTMOST X-Forwarded-For entry, which the client writes:
  // anyone could forge a fresh address per request and walk past every limit
  // keyed on the client address.
  it('refuses TRUST_PROXY=true, which trusts a client-written header', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: 'true',
    })

    expect(result.success).toBe(false)
  })

  // Measured on Fastify 5.12.1: a numeric trustProxy is fail-closed and never
  // trusts anyone, so accepting it would publish a knob that looks configured
  // and does nothing. It is also the value every tutorial shows.
  it('refuses a hop count, which Fastify accepts and then ignores', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: '1',
    })

    expect(result.success).toBe(false)
  })

  // Absent, empty and zero are one behaviour, and it is the safe one: behind a
  // proxy without configuration the limiter over-blocks, which is noisy and
  // found within the hour. The opposite failure is silent.
  it.each([undefined, '', '0', '00'])(
    'treats %o as trusting no proxy at all',
    (value) => {
      const result = parseEnv({
        DATABASE_URL: VALID_DATABASE_URL,
        JWT_SECRET: VALID_JWT_SECRET,
        ...(value === undefined ? {} : { TRUST_PROXY: value }),
      })

      expect(result.success).toBe(true)
      expect(result.data?.TRUST_PROXY).toBe(false)
    },
  )

  it('keeps a trusted network list as the string Fastify parses', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: ' 10.0.0.0/8,loopback ',
    })

    expect(result.success).toBe(true)
    expect(result.data?.TRUST_PROXY).toBe('10.0.0.0/8,loopback')
  })
})
