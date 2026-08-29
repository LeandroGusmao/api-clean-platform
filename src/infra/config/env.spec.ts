import { describe, expect, it } from 'vitest'
import {
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
    })
  })
})
