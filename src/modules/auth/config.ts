import { z } from 'zod'

/** 1 hour — decision 11. Short by design: the refresh token carries the session. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600

/**
 * 256 bits of secret for HS256. Verified: `jose` signs with a 5-byte secret and
 * enforces no minimum of its own, so this line is the only entropy guard in the
 * system — not a redundancy over a library check.
 */
const MIN_JWT_SECRET_LENGTH = 32

/** 60 days — decision 11. Sliding: every rotation issues a fresh window. */
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 5_184_000

/**
 * 30 seconds — decision 11. The window in which a refresh that has already been
 * rotated is still accepted, because the response carrying its successor may
 * have died in a tunnel. Without it, rotation in a mobile app produces random
 * logouts.
 */
export const DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS = 30

/**
 * The module owns its own variables (decision 14). `infra/config/env.ts` merges
 * this into the core schema so the process dies at boot listing every problem
 * at once, instead of revealing one per restart.
 */
export const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  // `.int().positive()` is not decoration: bare `z.coerce.number()` turns an
  // empty value into 0 in silence, and a TTL of zero mints expired tokens.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ACCESS_TOKEN_TTL_SECONDS),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_TTL_SECONDS),
  // `.positive()` and not `.nonnegative()`: a grace window of zero brings back
  // the random logout the window exists to remove, and rejecting zero is also
  // what rejects an empty value — exactly as for `PORT`.
  REFRESH_TOKEN_GRACE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS),
})

export type AuthConfig = z.infer<typeof authEnvSchema>
