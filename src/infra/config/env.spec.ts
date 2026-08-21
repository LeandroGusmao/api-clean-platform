import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  NODE_ENV_DEVELOPMENT,
  parseEnv,
} from '#infra/config/env'

const VALID_DATABASE_URL = 'postgres://user:pass@localhost:5432/app'

describe('parseEnv', () => {
  it('rejects an empty PORT instead of coercing it to zero', () => {
    const result = parseEnv({ DATABASE_URL: VALID_DATABASE_URL, PORT: '' })

    expect(result.success).toBe(false)
  })

  it('rejects a missing DATABASE_URL', () => {
    const result = parseEnv({})

    expect(result.success).toBe(false)
  })

  it('applies defaults when only DATABASE_URL is provided', () => {
    const result = parseEnv({ DATABASE_URL: VALID_DATABASE_URL })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      NODE_ENV: NODE_ENV_DEVELOPMENT,
      HOST: DEFAULT_HOST,
      PORT: DEFAULT_PORT,
      LOG_LEVEL: DEFAULT_LOG_LEVEL,
      DATABASE_URL: VALID_DATABASE_URL,
    })
  })
})
