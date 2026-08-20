import Fastify, { type FastifyInstance, LogController } from 'fastify'
import type { Env } from '#infra/config/env'

/**
 * Builds the Fastify instance WITHOUT routes.
 * `main/http.ts` is responsible for registering module plugins and their prefixes.
 */
export function buildServer(env: Env): FastifyInstance {
  return Fastify({
    // Aligns the Fastify log field with the `traceId` from the error body.
    // New form: the top-level `requestIdLogLabel` option ships in Fastify 6.
    logController: new LogController({ requestIdLogLabel: 'traceId' }),
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'password',
          'token',
          'refreshToken',
          'accessToken',
          '*.password',
          '*.token',
          '*.refreshToken',
          'headers.authorization',
          'headers.cookie',
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    },
  })
}
