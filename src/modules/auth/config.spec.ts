import { describe, expect, it } from 'vitest'
import {
  authEnvSchema,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS,
  DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_GOOGLE_JWKS_URI,
  DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,
  DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,
  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,
  DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS,
  DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS,
  DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS,
  DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,
  DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS,
  DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS,
} from '#modules/auth/config'

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60
const VALID_SECRET = 'a-test-secret-with-at-least-32-chars'
const TOO_SHORT_SECRET = 'a'.repeat(31)
const VALID_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com'
/** The two required, no-default fields — spread into every otherwise-minimal env. */
const VALID_ISSUER = 'api-clean-platform'
const VALID_AUDIENCE = 'api-clean-platform'
const MINIMAL_ENV = {
  JWT_SECRET: VALID_SECRET,
  GOOGLE_CLIENT_ID: VALID_GOOGLE_CLIENT_ID,
  JWT_ISSUER: VALID_ISSUER,
  JWT_AUDIENCE: VALID_AUDIENCE,
}

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
      ...MINIMAL_ENV,
      ACCESS_TOKEN_TTL_SECONDS: '',
    })

    expect(result.success).toBe(false)
  })

  it('defaults the TTL to one hour', () => {
    const result = authEnvSchema.safeParse(MINIMAL_ENV)

    expect(result.success).toBe(true)
    expect(result.data?.ACCESS_TOKEN_TTL_SECONDS).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS)
  })

  it('defaults the verification code TTL to 15 minutes', () => {
    const result = authEnvSchema.safeParse(MINIMAL_ENV)

    expect(result.success).toBe(true)
    expect(result.data?.EMAIL_VERIFICATION_TTL_SECONDS).toBe(
      DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS,
    )
  })

  it('rejects an empty verification TTL instead of coercing it to zero', () => {
    // A TTL of zero would expire every code before it could ever be used.
    const result = authEnvSchema.safeParse({
      ...MINIMAL_ENV,
      EMAIL_VERIFICATION_TTL_SECONDS: '',
    })

    expect(result.success).toBe(false)
  })

  it('gives register its own rate limit pair, not the login one', () => {
    const result = authEnvSchema.safeParse(MINIMAL_ENV)

    expect(result.success).toBe(true)
    expect(result.data?.REGISTER_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS,
    )
  })

  it('defaults the email-verify and resend rate limits independently', () => {
    const result = authEnvSchema.safeParse(MINIMAL_ENV)

    expect(result.success).toBe(true)
    expect(result.data?.EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS,
    )
    expect(result.data?.EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS,
    )
  })

  it('defaults the password recovery knobs', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.PASSWORD_RESET_TTL_SECONDS).toBe(1800)
    expect(config.PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS).toBe(60)
    expect(config.PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS).toBe(10)
    expect(config.PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS).toBe(60)
    expect(config.PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS).toBe(10)
    expect(config.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS).toBe(60)
  })

  it('rejects a zero TTL for the reset token', () => {
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, PASSWORD_RESET_TTL_SECONDS: '0' }),
    ).toThrow()
  })

  it('defaults the per-table prune retention windows', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.REFRESH_TOKEN_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS,
    )
    expect(config.PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS,
    )
    expect(config.PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS,
    )
  })

  it('rejects an empty prune retention instead of coercing it to zero', () => {
    // A retention of zero deletes rows the instant they expire, taking the
    // post-mortem window with them.
    expect(() =>
      authEnvSchema.parse({
        ...MINIMAL_ENV,
        PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS: '',
      }),
    ).toThrow()
  })

  it('requires GOOGLE_CLIENT_ID and has no default for it', () => {
    // Like JWT_SECRET: a missing value must fail at boot, not ship undefined.
    expect(authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET }).success).toBe(false)
  })

  it('defaults GOOGLE_JWKS_URI and the Google sign-in rate limit pair', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.GOOGLE_JWKS_URI).toBe(DEFAULT_GOOGLE_JWKS_URI)
    expect(config.GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS).toBe(
      DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
    )
    expect(config.GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS).toBe(
      DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
    )
  })

  it('defaults the outbox dispatch and prune settings', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.OUTBOX_DISPATCH_MAX_ATTEMPTS).toBe(DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS)
    expect(config.OUTBOX_DISPATCH_BATCH_SIZE).toBe(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE)
    expect(config.OUTBOX_DISPATCH_LEASE_SECONDS).toBe(
      DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,
    )
    expect(config.OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS,
    )
  })

  it('rejects an empty outbox prune retention instead of coercing it to zero', () => {
    expect(() =>
      authEnvSchema.parse({
        ...MINIMAL_ENV,
        OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS: '',
      }),
    ).toThrow()
  })

  it('rejects an empty outbox max attempts instead of coercing it to zero', () => {
    // Zero would mark every row failed on its very first attempt.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_MAX_ATTEMPTS: '' }),
    ).toThrow()
  })

  it('rejects an empty outbox claim lease instead of coercing it to zero', () => {
    // Zero would expire every claim the moment it is taken.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_LEASE_SECONDS: '' }),
    ).toThrow()
  })

  it('defaults the refresh token lifetime ceiling to 90 days', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.REFRESH_TOKEN_MAX_LIFETIME_SECONDS).toBe(
      DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,
    )
    expect(DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS).toBe(NINETY_DAYS_SECONDS)
  })

  it('rejects an empty lifetime ceiling instead of coercing it to zero', () => {
    // Zero would refuse every login: every token would be born past its ceiling.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, REFRESH_TOKEN_MAX_LIFETIME_SECONDS: '' }),
    ).toThrow()
  })
})
