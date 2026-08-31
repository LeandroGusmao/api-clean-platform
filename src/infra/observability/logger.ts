import type { Writable } from 'node:stream'
import { type Logger, pino } from 'pino'
import { type Env, NODE_ENV_DEVELOPMENT } from '#infra/config/env'
import { serializeError } from './error-serializer.js'
import { REDACT_PATHS } from './redact-paths.js'

export const REDACTED_CENSOR = '[REDACTED]'
const PRETTY_TRANSPORT_TARGET = 'pino-pretty'

/**
 * The logger every entrypoint shares. `pino` is the same instance Fastify used
 * to build for itself — what changed is who owns it.
 *
 * It had to leave `server.ts` because the composition root is shared by `http`,
 * `worker` and `cron` (decision 10), and a worker forced to build its own pino
 * would rebuild `redact` alongside it. That list is what keeps a password hash
 * or a bearer token out of the logs, so a second copy of it is how the first
 * worker leaks one. Owning the logger here is what makes the protection
 * inherited rather than re-derived.
 */
export type AppLogger = Logger

/**
 * The only thing the transaction runner needs from a logger, declared as its
 * own shape rather than as `Pick<AppLogger, 'warn'>`.
 *
 * pino's `warn` is an overloaded `LogFn`, so picking it drags every overload
 * along and no hand-written double can satisfy them all — the runner would
 * become untestable without a full pino instance. This narrower contract is
 * what the runner actually depends on, and `AppLogger` satisfies it
 * structurally.
 */
export interface WarnLogger {
  warn(details: Record<string, unknown>, message: string): void
}

export interface CreateLoggerOptions {
  /**
   * Where the logger writes. The destination is external world, so it enters by
   * contract like everything else. Left out, pino keeps its default (stdout).
   * Mutually exclusive with the pretty transport, which is development-only.
   */
  stream?: Writable | undefined
}

export function createLogger(env: Env, options: CreateLoggerOptions = {}): AppLogger {
  const settings = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED_CENSOR,
    },
    serializers: { err: serializeError },
    ...(env.NODE_ENV === NODE_ENV_DEVELOPMENT
      ? {
          transport: { target: PRETTY_TRANSPORT_TARGET, options: { singleLine: true } },
        }
      : {}),
  }

  // `stream` is pino's SECOND argument, not an option key — passing it inside
  // the settings object silently does nothing, and every spec that reads the
  // emitted line would then be reading stdout instead.
  return options.stream === undefined ? pino(settings) : pino(settings, options.stream)
}
