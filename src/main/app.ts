import fastifyCookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { makeAuthGuard } from '#infra/http/auth-guard'
import { healthRoute } from '#infra/http/endpoints/health'
import { registerOpenApi } from '#infra/http/openapi'
import { registerRateLimit } from '#infra/http/rate-limit'
import { type BuildServerOptions, buildServer } from '#infra/http/server'
import { createLogger } from '#infra/observability/logger'
import { authRoutes } from '#modules/auth/infra/http/routes'
import { makeContainer } from './container.js'

const AUTH_PREFIX = '/auth'

/**
 * Composes the whole application — instance, dependencies, docs and routes —
 * and returns it WITHOUT listening on a port.
 *
 * The split from `http.ts` is what lets a test exercise the real application:
 * anything registered here reaches every suite for free, so a global hook can
 * never be live in production and absent from the tests.
 */
export async function buildApp(
  env: Env,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  // One logger for the whole process, handed to both halves. Without this the
  // container would have to build its own, and a worker or cron entrypoint
  // (decision 10) would rebuild `redact` alongside it — the list that keeps a
  // password hash out of the logs is not something to have two copies of.
  const logger = createLogger(env, { stream: options.logStream })
  const app = buildServer(env, { ...options, logger })

  const { db, pool } = createDatabase(env)
  // Makes `app.close()` the single teardown: callers never end the pool by hand.
  app.addHook('onClose', () => pool.end())

  // Global infra: the auth module never registers a transport plugin of its
  // own. Unlike `registerOpenApi` below, the position is NOT load-bearing —
  // verified that `request.cookies` works even when the plugin is registered
  // after the routes, because it decorates the request rather than hooking
  // `onRoute` — but it belongs with the rest of the global setup.
  await app.register(fastifyCookie)

  // Before any route, because the ceiling has to cover everything registered
  // after it. It counts requests and not failed logins — that half is the
  // edge's job, deliberately (see the slice's design §10.1).
  await registerRateLimit(app, env)

  // Must come before any route: `@fastify/swagger` only documents what is
  // registered after it.
  await registerOpenApi(app, env)

  await app.register(healthRoute, { db })

  // The graph is built here, not in `http.ts`: `buildApp` is the composition
  // root the suites exercise, so anything wired here reaches the tests too.
  const container = makeContainer(db, env, logger)

  // Built here, from the auth module's verifier, and handed to whichever module
  // needs it. The guard itself knows nothing about auth, so protecting a route
  // never makes a module import another module.
  const guard = makeAuthGuard(container.auth.verifyAccessToken)

  // Same teardown story as the database pool above: `app.close()` stays the
  // single shutdown path, so nothing outside this module has to remember the
  // SMTP transport is pooled and needs draining.
  app.addHook('onClose', () => container.auth.closeEmailTransport())

  await app.register(authRoutes, {
    prefix: AUTH_PREFIX,
    container: container.auth,
    guard,
  })

  return app
}
