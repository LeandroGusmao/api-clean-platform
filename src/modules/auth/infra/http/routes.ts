import type { FastifyPluginAsync } from 'fastify'
import type { AuthContainer } from '#modules/auth/container'
import { registerRoute } from './endpoints/register.js'

/**
 * The module's HTTP surface. Thin by design: a new endpoint is a new file plus
 * one line here.
 *
 * It receives only the module's own slice of the container (decision 23), so
 * reaching another module's use case is a compile error rather than something
 * a lint rule has to catch.
 */
export const authRoutes: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  await app.register(registerRoute, { container })
}
