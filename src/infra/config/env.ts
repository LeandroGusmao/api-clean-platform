import { z } from 'zod'
import { authEnvSchema } from '#modules/auth/config'

/**
 * Only place in the project that reads `process.env` (R6).
 * Every consumer receives the already-validated config via injection.
 */
export const NODE_ENV_DEVELOPMENT = 'development'
export const NODE_ENV_TEST = 'test'
export const NODE_ENV_PRODUCTION = 'production'
const NODE_ENVS = [NODE_ENV_DEVELOPMENT, NODE_ENV_TEST, NODE_ENV_PRODUCTION] as const

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/**
 * Pool and connection limits. Defaults are deliberately conservative: they suit
 * development, and production tunes them from the arithmetic in
 * `ARCHITECTURE.md` §6 — the ceiling is
 * `instances × DATABASE_POOL_MAX <= max_connections - reserve`, so raising this
 * per instance is the wrong lever past a handful of replicas.
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

/**
 * Redis backs the routes that declare their own rate limit ceiling, and those
 * routes refuse while it is down. These bound how long a request
 * waits on it: a command that is not answered quickly must fail, not queue.
 * The command timeout is far above a healthy round trip and far below any
 * request timeout.
 */
export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1_000
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 250

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

/**
 * A flood ceiling, not a UX limit. A chatty single-page app does not come near
 * 300 requests a minute from one address, and whoever does is not browsing.
 *
 * The limit that actually matters lives at the edge, which sees every replica
 * at once; this one exists so a single origin cannot saturate the process
 * before the edge notices.
 */
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 300
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60

export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_PORT = 3000
export const DEFAULT_LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info'

/**
 * Development points at the Mailpit service in `docker-compose.yml`. Production
 * must be explicit — see the refinement below.
 */
export const DEFAULT_MAIL_HOST = '127.0.0.1'
export const DEFAULT_MAIL_PORT = 1025
export const DEFAULT_MAIL_FROM = 'API Clean Platform <no-reply@localhost>'

/**
 * Zod gives no boolean coercion that rejects garbage: `z.coerce.boolean()`
 * turns every non-empty string into `true`, so `MAIL_REQUIRE_TLS=false` would
 * read as true.
 *
 * `.default()` sits BEFORE `.transform()`, exactly as in `trustProxySchema`
 * above and for the same reason: Zod 4's default is the OUTPUT type of
 * whatever it is attached to, and short-circuits that schema's own parsing —
 * but chained calls placed AFTER it still run on the resulting value. Placed
 * before `.transform()` here, the string default flows through the transform
 * like any parsed input and comes out as the right boolean; attached after
 * `.transform()` instead, the default would have to be a `boolean` already,
 * and passing the string `'false'` there both fails to typecheck and — were
 * the type forced through — would hand every default consumer the STRING
 * `'false'`, which is truthy.
 */
const BOOLEAN_TRUE = 'true'
const BOOLEAN_FALSE = 'false'
function booleanFromString(defaultValue: typeof BOOLEAN_TRUE | typeof BOOLEAN_FALSE) {
  return z
    .enum([BOOLEAN_TRUE, BOOLEAN_FALSE])
    .default(defaultValue)
    .transform((raw) => raw === BOOLEAN_TRUE)
}

const TRUST_PROXY_NUMERIC_PATTERN = /^\d+$/
const TRUST_PROXY_BOOLEAN_LITERALS = ['true', 'false']
/** Fastify treats `false`, `0` and `''` identically; this is the one form. */
const TRUST_PROXY_TRUST_NOTHING = false

const TRUST_PROXY_REFUSAL =
  'must be empty (trust nothing) or a comma-separated list of trusted ' +
  'networks, such as `10.0.0.0/8,loopback`. `true` is refused because it ' +
  'trusts the LEFTMOST X-Forwarded-For entry, which the client writes — ' +
  'anyone could then forge a fresh address per request. A hop count is ' +
  'refused because Fastify 5 ignores it: a numeric trustProxy is fail-closed ' +
  'and never trusts anyone, so the knob would look configured and do nothing.'

/**
 * Which proxies may speak for the client, and therefore whether `request.ip`
 * means anything at all. Behind a load balancer with this unset, every request
 * carries the balancer's address.
 *
 * The output is `string | false` — no number ever reaches Fastify, by the
 * refusal above. Both refused forms fail SILENTLY if allowed through, which is
 * why they are rejected at boot rather than documented.
 *
 * `.default('')` sits BEFORE the refinements on purpose: Zod 4's default is the
 * OUTPUT type and short-circuits parsing (ARCHITECTURE.md §11), so placed at the
 * end it would have to be `string | false` and would skip every check.
 *
 * The CIDR syntax itself is deliberately NOT validated here. Fastify compiles
 * the list eagerly and dies at boot on an invalid entry — even one inside an
 * otherwise valid list — so a second implementation would only add a way for
 * the two to drift apart.
 */
const trustProxySchema = z
  .string()
  .trim()
  .default('')
  .refine((raw) => !TRUST_PROXY_BOOLEAN_LITERALS.includes(raw), TRUST_PROXY_REFUSAL)
  .refine(
    (raw) => !(TRUST_PROXY_NUMERIC_PATTERN.test(raw) && Number(raw) > 0),
    TRUST_PROXY_REFUSAL,
  )
  .transform((raw) =>
    raw === '' || TRUST_PROXY_NUMERIC_PATTERN.test(raw) ? TRUST_PROXY_TRUST_NOTHING : raw,
  )

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(NODE_ENV_DEVELOPMENT),
  TRUST_PROXY: trustProxySchema,
  HOST: z.string().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  DATABASE_URL: z.url(),
  // `.positive()` and not `.nonnegative()`, exactly as for `PORT`: a ceiling of
  // zero would refuse every request, and rejecting zero is also what rejects an
  // empty value.
  RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_MAX_REQUESTS),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
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
  // No default, like `DATABASE_URL`: two deployments must not share a Redis by
  // accident and count each other's requests.
  REDIS_URL: z.url(),
  // `.positive()`, as for `PORT`: no legitimate zero, and rejecting zero is what
  // rejects an empty value.
  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_COMMAND_TIMEOUT_MS),
  // `.optional()` and NOT `.default(...)`: the production refinement below
  // needs to tell "the operator set this" from "Zod filled it in", and after a
  // `.default()` the parsed value is never `undefined` — that distinction would
  // be gone. The effective default is applied in the `.transform()` at the
  // bottom, once the refinement has already seen the raw `undefined`.
  MAIL_HOST: z.string().min(1).optional(),
  MAIL_PORT: z.coerce.number().int().positive().optional(),
  // These two keep `.default()`: production does not require their PRESENCE,
  // it requires a VALUE (`MAIL_REQUIRE_TLS` must be `true`), so there is no
  // "operator vs. Zod" distinction to lose here.
  MAIL_SECURE: booleanFromString(BOOLEAN_FALSE),
  MAIL_REQUIRE_TLS: booleanFromString(BOOLEAN_FALSE),
  MAIL_FROM: z.string().min(1).optional(),
  MAIL_USER: z.string().min(1).optional(),
  MAIL_PASSWORD: z.string().min(1).optional(),
})

/** The mail settings that must never be inherited from a development default. */
const REQUIRED_MAIL_KEYS_IN_PRODUCTION = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_FROM'] as const

const MAIL_REQUIRED_IN_PRODUCTION_MESSAGE =
  'must be set explicitly in production, never inherited from the development default'
const MAIL_TLS_REQUIRED_MESSAGE =
  'must be true in production: without STARTTLS a man in the middle reads every verification code'

/** The pair that authenticates against the relay: present together, or absent together. */
const MAIL_USER_KEY = 'MAIL_USER'
const MAIL_PASSWORD_KEY = 'MAIL_PASSWORD'
const MAIL_CREDENTIALS_PAIR_MESSAGE =
  'MAIL_USER and MAIL_PASSWORD must be set together or left unset together: ' +
  'one without the other passes this validation and then hands nodemailer an ' +
  'undefined password, so every send fails at runtime instead of the process ' +
  'refusing to start'

/**
 * Every module's schema merged, validated once at boot. A module
 * declaring a variable and forgetting this line would ship an unvalidated
 * `undefined` to production — which is why no module reads `process.env` itself.
 *
 * `.superRefine()` has to come AFTER `.extend()`: `.extend()` clones the shape
 * into a fresh object schema and drops any check already attached, so a
 * refinement added before it would simply vanish.
 *
 * `.transform()` runs last and applies the mail defaults that `.default()`
 * cannot: it sees the object exactly as `.superRefine()` left it, `MAIL_HOST` /
 * `MAIL_PORT` / `MAIL_FROM` still genuinely `undefined` when unset, and turns
 * that into the effective value the rest of the app receives. That keeps the
 * exported `Env` type free of `undefined` on these fields — no consumer has to
 * special-case a value the refinement above has already guaranteed present.
 */
const envSchema = coreEnvSchema
  .extend(authEnvSchema.shape)
  .superRefine((value, ctx) => {
    // Applies in EVERY environment, not just production — unlike the checks
    // below this one, which the early `return` right after it skips outside
    // production. Setting only one of the pair boots clean today (both are
    // independent optionals) and only fails once a request tries to send,
    // handing nodemailer `pass: undefined` — the opposite of this file's own
    // rule, which is to fail loudly at boot with every problem listed at once.
    const hasMailUser = value.MAIL_USER !== undefined
    const hasMailPassword = value.MAIL_PASSWORD !== undefined
    if (hasMailUser !== hasMailPassword) {
      ctx.addIssue({
        code: 'custom',
        path: [hasMailUser ? MAIL_PASSWORD_KEY : MAIL_USER_KEY],
        message: MAIL_CREDENTIALS_PAIR_MESSAGE,
      })
    }

    if (value.NODE_ENV !== NODE_ENV_PRODUCTION) return

    for (const key of REQUIRED_MAIL_KEYS_IN_PRODUCTION) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: MAIL_REQUIRED_IN_PRODUCTION_MESSAGE,
        })
      }
    }

    if (!value.MAIL_REQUIRE_TLS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_REQUIRE_TLS'],
        message: MAIL_TLS_REQUIRED_MESSAGE,
      })
    }
  })
  .transform((value) => ({
    ...value,
    MAIL_HOST: value.MAIL_HOST ?? DEFAULT_MAIL_HOST,
    MAIL_PORT: value.MAIL_PORT ?? DEFAULT_MAIL_PORT,
    MAIL_FROM: value.MAIL_FROM ?? DEFAULT_MAIL_FROM,
  }))

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
