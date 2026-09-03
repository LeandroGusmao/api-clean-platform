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
 * Ten guesses a minute from one address on the login route.
 *
 * It counts REQUESTS and not failures — the transport cannot know a password
 * was wrong — so it is a cost multiplier on brute force, never a lockout. Far
 * above human retry after a typo, far below anything useful to an attacker.
 *
 * These live in the MODULE and not in the core env because the route declares
 * the ceiling, through `config` on the endpoint's schema, and the route belongs
 * to the module (decisions 14 and 23). That is also why the window is the
 * module's own: reusing the core's would make this module read a core variable.
 */
export const DEFAULT_LOGIN_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60

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
  // `.positive()` for the same reason as everywhere else here: a ceiling of
  // zero would refuse every login, and rejecting zero is what rejects empty.
  LOGIN_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LOGIN_RATE_LIMIT_MAX_REQUESTS),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS),
})

export type AuthConfig = z.infer<typeof authEnvSchema>
