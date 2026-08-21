import type { Writable } from 'node:stream'
import Fastify, { type FastifyInstance, LogController } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { type Env, NODE_ENV_DEVELOPMENT } from '#infra/config/env'
import { REDACT_PATHS } from '#infra/observability/redact-paths'

const TRACE_ID_LOG_LABEL = 'traceId'
export const REDACTED_CENSOR = '[REDACTED]'
const PRETTY_TRANSPORT_TARGET = 'pino-pretty'

export interface BuildServerOptions {
  /**
   * Where the logger writes. The destination is external world, so it enters by
   * contract like everything else. Left out, pino keeps its default (stdout).
   * Mutually exclusive with the pretty transport, which is development-only.
   */
  logStream?: Writable
}

/**
 * Builds the Fastify instance WITHOUT routes.
 * `main/http.ts` is responsible for registering module plugins and their prefixes.
 */
export function buildServer(env: Env, options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    // Aligns the Fastify log field with the `traceId` from the error body.
    // New form: the top-level `requestIdLogLabel` option ships in Fastify 6.
    logController: new LogController({ requestIdLogLabel: TRACE_ID_LOG_LABEL }),
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [...REDACT_PATHS],
        censor: REDACTED_CENSOR,
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
      ...(env.NODE_ENV === NODE_ENV_DEVELOPMENT
        ? {
            transport: { target: PRETTY_TRANSPORT_TARGET, options: { singleLine: true } },
          }
        : {}),
    },
  })

  // Required for any endpoint declaring a raw Zod schema: without these
  // compilers, Fastify expects JSON Schema and fails at runtime.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  return app
}
