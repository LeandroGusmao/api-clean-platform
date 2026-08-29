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

export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_PORT = 3000
export const DEFAULT_LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info'

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(NODE_ENV_DEVELOPMENT),
  HOST: z.string().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  DATABASE_URL: z.url(),
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
