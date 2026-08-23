import type { FastifyInstance } from 'fastify'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { healthRoute } from '#infra/http/endpoints/health'
import { registerOpenApi } from '#infra/http/openapi'
import { type BuildServerOptions, buildServer } from '#infra/http/server'

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

  return app
}
