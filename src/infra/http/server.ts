import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  LogController,
} from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { Env } from '#infra/config/env'
import { type AppLogger, createLogger } from '#infra/observability/logger'
import { runWithRequestContext } from '#infra/observability/request-context'
import { registerErrorHandling } from './errors/error-handler.js'

const TRACE_ID_LOG_LABEL = 'traceId'

export interface BuildServerOptions {
  /** Where the logger writes, when this function builds the logger itself. */
  logStream?: Writable
  /**
   * The process-wide logger. `buildApp` passes the one it shares with the
   * container, so a transaction retry and a request land in the same stream
   * with the same redaction. Left out — as the specs that exercise this
   * function alone do — one is built here from `env`.
   */
  logger?: AppLogger
}

/**
 * Builds the Fastify instance WITHOUT routes.
 * `main/http.ts` is responsible for registering module plugins and their prefixes.
 */
export function buildServer(env: Env, options: BuildServerOptions = {}): FastifyInstance {
  // Annotated rather than inlined: Fastify infers the instance's logger generic
  // from this value, and a `pino.Logger` would specialise `FastifyInstance` into
  // a type no longer assignable to the one this function declares.
  const logger: FastifyBaseLogger =
    options.logger ?? createLogger(env, { stream: options.logStream })

  const app = Fastify({
    // Decides whether `request.ip` means anything at all. Behind a load
    // balancer with this unset, every request carries the balancer's address,
    // so anything keyed on the client — a rate limit, an audit line — puts the
    // whole world in one bucket. It works perfectly on a laptop, where there is
    // no proxy, which is what makes it worth a boot-time guard: the env schema
    // refuses the two forms (`true` and a hop count) that fail in silence.
    trustProxy: env.TRUST_PROXY,
    // Fastify's default is a per-process counter (`req-1`): two replicas emit
    // the same id and a restart resets it, so a traceId cannot correlate
    // anything beyond a single process.
    genReqId: () => randomUUID(),
    // Aligns the Fastify log field with the `traceId` from the error body.
    // New form: the top-level `requestIdLogLabel` option ships in Fastify 6.
    logController: new LogController({ requestIdLogLabel: TRACE_ID_LOG_LABEL }),
    loggerInstance: logger,
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
