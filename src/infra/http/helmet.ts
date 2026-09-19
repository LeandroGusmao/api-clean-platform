import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'

/**
 * Transport security headers, on the plugin's defaults.
 *
 * HSTS is the one that matters most here: the cookie transport of decision 12
 * is exactly what a downgrade to plain HTTP would expose.
 *
 * Registered as a function for the same reason as `registerCors` and
 * `registerRateLimit`: a spec can mount a bare server and assert the headers
 * without a database.
 */
export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(helmet)
}
