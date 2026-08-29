import type { FastifyInstance } from 'fastify'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { makeAuthGuard } from '#infra/http/auth-guard'
import { healthRoute } from '#infra/http/endpoints/health'
import { registerOpenApi } from '#infra/http/openapi'
import { type BuildServerOptions, buildServer } from '#infra/http/server'
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
  const app = buildServer(env, options)

  const { db, pool } = createDatabase(env)
  // Makes `app.close()` the single teardown: callers never end the pool by hand.
  app.addHook('onClose', () => pool.end())

  // Must come before any route: `@fastify/swagger` only documents what is
  // registered after it.
  await registerOpenApi(app, env)

  await app.register(healthRoute, { db })

  // The graph is built here, not in `http.ts`: `buildApp` is the composition
  // root the suites exercise, so anything wired here reaches the tests too.
  const container = makeContainer(db, env)

  // Built here, from the auth module's verifier, and handed to whichever module
  // needs it. The guard itself knows nothing about auth, so protecting a route
  // never makes a module import another module.
  const guard = makeAuthGuard(container.auth.verifyAccessToken)

  await app.register(authRoutes, {
    prefix: AUTH_PREFIX,
    container: container.auth,
    guard,
  })

  return app
}
