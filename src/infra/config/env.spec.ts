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
import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS } from '#modules/auth/config'

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
      HOST: DEFAULT_HOST,
      PORT: DEFAULT_PORT,
      LOG_LEVEL: DEFAULT_LOG_LEVEL,
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      ACCESS_TOKEN_TTL_SECONDS: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
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
})
