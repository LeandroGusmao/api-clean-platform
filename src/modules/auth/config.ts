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
 * Ten attempts a minute from one address, the same numbers as the login route
 * and for the same reason: a request here carries a password guess, it counts
 * REQUESTS rather than failures, and the number sits far above human retry and
 * far below anything useful to an attacker.
 *
 * Its own variables rather than reusing the login ones, because the two
 * ceilings may need to diverge — and a field named `login` declared on a route
 * that is not login is a comment that lies.
 *
 * The vector this closes is concrete: stolen access token -> password changed
 * -> account taken. Without it the route would inherit only the global 300/min.
 */
export const DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * A request here carries a password guess, like login and the password change.
 * Its own pair, not a shared one, for the reason those two document: a field
 * named for one route and used by another is a comment that lies.
 *
 * The vector it closes is narrower than the password change's, and worse: a
 * stolen access token escalated into an account that no longer exists.
 */
export const DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * 15 minutes. Short because the code is only six digits: what makes 10^6
 * acceptable is not entropy, it is the TTL, the attempt cap and the resend
 * cooldown together. Lengthen any one of them and the other two have to answer
 * for it.
 */
export const DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS = 900

/** Five wrong guesses kill the code. The second half of what substitutes for entropy. */
export const DEFAULT_EMAIL_VERIFICATION_MAX_ATTEMPTS = 5

/**
 * One minute between codes for the same account. Without it, the resend endpoint
 * is an oracle that mints fresh attempt budget on demand — and a way to fill a
 * stranger's inbox from an anonymous request.
 */
export const DEFAULT_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60

/**
 * Registration sends mail to an arbitrary address from an anonymous request,
 * which makes it a spam amplifier; the global 300/min is not a ceiling for that.
 * Its own pair, not a shared one, for the reason the login pair documents: a
 * field named for one route, used by another, is a comment that lies.
 */
export const DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_REGISTER_RATE_LIMIT_WINDOW_SECONDS = 60

/** A request here carries a code guess. Same reasoning as login. */
export const DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS = 60

/** Same amplifier as register, plus the ability to burn a victim's live code. */
export const DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS = 5
export const DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * 30 minutes. The token is 256 bits of entropy, so brute force is not the
 * threat the TTL answers — it caps how long a reset link left in an inbox
 * stays live. Longer than the six-digit code's 15 minutes on purpose.
 */
export const DEFAULT_PASSWORD_RESET_TTL_SECONDS = 1800

/**
 * One minute between reset emails for the same account. Without it, `forgot` is
 * a way to fill a stranger's inbox from an anonymous request.
 */
export const DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS = 60

/**
 * `forgot` sends mail to an arbitrary address from an anonymous request — a
 * spam amplifier, like `register`. Its own pair, not a shared one: a field
 * named for one route and used by another is a comment that lies.
 */
export const DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * `reset` carries a token guess. Same shape as `confirm`: it counts requests,
 * not failures, and sits far above human retry and far below anything useful
 * to an attacker.
 */
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * How long a dead token row survives past `expires_at` before the cron prunes
 * it (design §3.4). One window per table: the trail worth keeping differs, and
 * seven days of dead reset tokens is more clutter than their 30-minute TTL
 * warrants.
 */
export const DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS = 604_800
export const DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS = 86_400
export const DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS = 86_400

/**
 * Five attempts before a pending notice gives up and stops being retried
 * (design §3, §8). The interval BETWEEN attempts is whatever the external
 * scheduler invoking `cron.ts` is set to — that already is the backoff
 * (decision 30, §3.1 of the slice 13 design).
 */
export const DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS = 5

/** How many pending rows one dispatch run picks up. */
export const DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE = 100

/**
 * Seven days, same window as `refresh_tokens`: a dispatched or given-up-on
 * notice stays available for a post-mortem before the prune job removes it.
 */
export const DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS = 604_800

/**
 * Where `jose` fetches Google's signing keys. A default of the real endpoint,
 * the way `MAIL_HOST` defaults to the dev Mailpit host: it is a service
 * endpoint, and the integration test overrides it to a local JWKS server the
 * same way `verify-email.spec.ts` overrides the rate-limit ceilings.
 */
export const DEFAULT_GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'

/**
 * Ten attempts a minute from one address on `POST /auth/google`. The link path
 * of that route carries a password guess, so the reasoning is login's: it counts
 * REQUESTS not failures, sits far above human retry and far below anything
 * useful to an attacker. Its own pair, not login's — a field named for one route
 * used by another is a comment that lies.
 */
export const DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * The module owns its own variables (decision 14). `infra/config/env.ts` merges
 * this into the core schema so the process dies at boot listing every problem
 * at once, instead of revealing one per restart.
 */
export const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  /**
   * The OAuth client id from Google Cloud Console. Public, not a secret:
   * ID-token verification is public-key crypto. Required, no default, like
   * `JWT_SECRET` — ship a placeholder in `.env.example` for setups without
   * Google sign-in.
   */
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_JWKS_URI: z.url().default(DEFAULT_GOOGLE_JWKS_URI),
  GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS),
  GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS),
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
  // `.positive()` for the reason it is used everywhere else here: a ceiling of
  // zero would refuse every password change, and rejecting zero is what rejects
  // an empty value.
  PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS),
  // `.positive()` for the reason every ceiling here carries it: zero would
  // refuse every deletion, and rejecting zero is what rejects an empty value.
  ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS),
  ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS),
  // `.positive()` for the same reason as every TTL above: a value of zero would
  // expire the code before it could ever be used, and rejecting zero is what
  // rejects an empty value.
  EMAIL_VERIFICATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFICATION_MAX_ATTEMPTS),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS),
  // `.positive()` for the reason it is used everywhere else here: a ceiling of
  // zero would refuse every registration, and rejecting zero is what rejects
  // an empty value.
  REGISTER_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS),
  REGISTER_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REGISTER_RATE_LIMIT_WINDOW_SECONDS),
  EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS),
  EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS),
  EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS),
  EMAIL_VERIFY_RESEND_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_WINDOW_SECONDS),
  // `.positive()` for the reason every value here carries it: a value of zero
  // would expire the token before it could be used, and rejecting zero is what
  // rejects an empty value.
  PASSWORD_RESET_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_TTL_SECONDS),
  PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS),
  PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS),
  PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS),
  // `.int().positive()` for the reason every value here carries it: bare
  // `z.coerce.number()` turns an empty value into 0, and a retention of zero
  // prunes a row the moment it expires, taking the post-mortem window with it.
  REFRESH_TOKEN_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS),
  PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS),
  PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS),
  // `.int().positive()` for the same reason as every retention above: an
  // empty value coerced to 0 would mark a message failed on its first
  // attempt, or prune it the instant it is dispatched.
  OUTBOX_DISPATCH_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS),
  OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE),
  OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS),
})

export type AuthConfig = z.infer<typeof authEnvSchema>
