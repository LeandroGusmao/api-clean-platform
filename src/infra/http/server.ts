import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'
import Fastify, { type FastifyInstance, LogController } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { type Env, NODE_ENV_DEVELOPMENT } from '#infra/config/env'
import { REDACT_PATHS } from '#infra/observability/redact-paths'
import { runWithRequestContext } from '#infra/observability/request-context'
import { registerErrorHandling } from './error-handler.js'

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
    // Fastify's default is a per-process counter (`req-1`): two replicas emit
    // the same id and a restart resets it, so a traceId cannot correlate
    // anything beyond a single process.
    genReqId: () => randomUUID(),
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

  // Opens the ambient context for everything downstream — routes, hooks and the
  // error handler alike. Verified: the store survives an `await` and is still
  // readable inside `setErrorHandler` and `setNotFoundHandler`.
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestContext(request.id, done)
  })

  // Instance configuration, not a route: every server built here — production,
  // unit spec, integration spec — answers errors with the same contract.
  registerErrorHandling(app)

  return app
}
