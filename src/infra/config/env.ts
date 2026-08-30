import { z } from 'zod'
import { authEnvSchema } from '#modules/auth/config'

/**
 * Only place in the project that reads `process.env` (R6).
 * Every consumer receives the already-validated config via injection.
 */
export const NODE_ENV_DEVELOPMENT = 'development'
export const NODE_ENV_TEST = 'test'
const NODE_ENV_PRODUCTION = 'production'
const NODE_ENVS = [NODE_ENV_DEVELOPMENT, NODE_ENV_TEST, NODE_ENV_PRODUCTION] as const

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/**
 * Pool and connection limits. Defaults are deliberately conservative: they suit
 * development, and production tunes them from the arithmetic in
 * `docs/superpowers/specs/2026-08-30-connection-limits-design.md` §4 — the
 * ceiling is `instances × DATABASE_POOL_MAX <= max_connections - reserve`, so
 * raising this per instance is the wrong lever past a handful of replicas.
 *
 * These matter more since the unit of work landed: a connection is now held for
 * the duration of a CALLBACK, not of a query.
 */
export const DEFAULT_DATABASE_POOL_MAX = 10
export const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 5_000
export const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 10_000
/** Half the statement timeout, so waiting on a lock fails as 55P03 rather than 57014. */
export const DEFAULT_DATABASE_LOCK_TIMEOUT_MS = 5_000
/** The net against a hung callback holding a connection AND its locks forever. */
export const DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000

const EMPTY_TIMEOUT_MESSAGE =
  "must not be empty; set it to 0 to leave the server's own setting in effect"

/**
 * A Postgres timeout in milliseconds, where **0 means "do not override"**.
 *
 * Not "disabled": `pg` guards each of these with `if (params.x)`, so a zero is
 * simply never sent and the server's own setting stays in effect — which on a
 * managed Postgres may be a non-zero parameter-group value.
 *
 * That is why this cannot be `z.coerce.number()` like `PORT`: coercion turns an
 * empty value into 0, and `PORT` is only safe because `.positive()` then
 * rejects it. Here 0 is legitimate, so emptiness has to be caught BEFORE
 * coercion — otherwise blanking the value in a `.env` silently switches the
 * safety net off. That failure is open, which is the wrong direction for a
 * timeout.
 */
function timeoutMs(defaultMs: number) {
  return (
    z
      .string()
      .trim()
      .min(1, EMPTY_TIMEOUT_MESSAGE)
      // `.transform(Number)` and not `.pipe(z.coerce.number())`: the coerced
      // schema declares an `unknown` input, which does not fit downstream of a
      // string schema — the pipe fails to typecheck and the whole inferred `Env`
      // silently degrades to `any`.
      .transform(Number)
      .pipe(z.number().int().nonnegative())
      // The default is the OUTPUT type and short-circuits parsing: Zod 4 returns
      // it as given, so a `String(defaultMs)` here would hand the pool a literal
      // "5000" instead of 5000. Caught by the defaults test, not by the compiler.
      .default(defaultMs)
  )
}

export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_PORT = 3000
export const DEFAULT_LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info'

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(NODE_ENV_DEVELOPMENT),
  HOST: z.string().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  DATABASE_URL: z.url(),
  // `.positive()` here, `nonnegative` in the timeouts: a pool of zero serves no
  // request at all, so it has no legitimate zero — and rejecting zero is also
  // what rejects an empty value, exactly as it does for `PORT`.
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_DATABASE_POOL_MAX),
  DATABASE_CONNECTION_TIMEOUT_MS: timeoutMs(DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS),
  DATABASE_STATEMENT_TIMEOUT_MS: timeoutMs(DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS),
  DATABASE_LOCK_TIMEOUT_MS: timeoutMs(DEFAULT_DATABASE_LOCK_TIMEOUT_MS),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: timeoutMs(
    DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  ),
})

/**
 * Every module's schema merged, validated once at boot (decision 14). A module
 * declaring a variable and forgetting this line would ship an unvalidated
 * `undefined` to production — which is why no module reads `process.env` itself.
 */
const envSchema = coreEnvSchema.extend(authEnvSchema.shape)

export type Env = z.infer<typeof envSchema>

/**
 * Validation without the side effect, so it can be exercised in isolation.
 * Reading `process.env` and killing the process stay below, where they belong.
 */
export function parseEnv(source: unknown) {
  return envSchema.safeParse(source)
}

const parsed = parseEnv(process.env)

if (!parsed.success) {
  // Before the logger exists: the process must not start with invalid env.
  console.error('Invalid environment variables:\n')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

export const env: Env = parsed.data
