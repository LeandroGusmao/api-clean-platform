import { describe, expect, it } from 'vitest'
import {
  authEnvSchema,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS,
  DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS,
} from '#modules/auth/config'

const VALID_SECRET = 'a-test-secret-with-at-least-32-chars'
const TOO_SHORT_SECRET = 'a'.repeat(31)

describe('authEnvSchema', () => {
  it('rejects a secret shorter than 32 characters', () => {
    // jose signs happily with a 5-byte secret and enforces no minimum of its
    // own, so this schema is the only entropy guard in the system.
    const result = authEnvSchema.safeParse({ JWT_SECRET: TOO_SHORT_SECRET })

    expect(result.success).toBe(false)
  })

  it('rejects an empty TTL instead of coercing it to zero', () => {
    // A TTL of zero would mint every token already expired.
    const result = authEnvSchema.safeParse({
      JWT_SECRET: VALID_SECRET,
      ACCESS_TOKEN_TTL_SECONDS: '',
    })

    expect(result.success).toBe(false)
  })

  it('defaults the TTL to one hour', () => {
    const result = authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET })

    expect(result.success).toBe(true)
    expect(result.data?.ACCESS_TOKEN_TTL_SECONDS).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS)
  })

  it('defaults the verification code TTL to 15 minutes', () => {
    const result = authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET })

    expect(result.success).toBe(true)
    expect(result.data?.EMAIL_VERIFICATION_TTL_SECONDS).toBe(
      DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS,
    )
  })

  it('rejects an empty verification TTL instead of coercing it to zero', () => {
    // A TTL of zero would expire every code before it could ever be used.
    const result = authEnvSchema.safeParse({
      JWT_SECRET: VALID_SECRET,
      EMAIL_VERIFICATION_TTL_SECONDS: '',
    })

    expect(result.success).toBe(false)
  })

  it('gives register its own rate limit pair, not the login one', () => {
    const result = authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET })

    expect(result.success).toBe(true)
    expect(result.data?.REGISTER_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS,
    )
  })

  it('defaults the email-verify and resend rate limits independently', () => {
    const result = authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET })

    expect(result.success).toBe(true)
    expect(result.data?.EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS,
    )
    expect(result.data?.EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS,
    )
  })
})
