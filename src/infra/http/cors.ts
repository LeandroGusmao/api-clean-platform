import cors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'

/**
 * Temporary allowance for the local front-end dev server. Single hard-coded
 * origin on purpose: a real allow-list belongs in `env` once more than one
 * origin needs it.
 */
const LOCAL_FRONTEND_ORIGIN = 'http://localhost:8081'

/**
 * Cross-origin access for the browser front-end.
 *
 * `credentials: true` because the auth flow rides on a cookie, and a cookie is
 * only sent cross-origin when the response also names an explicit origin — the
 * `*` wildcard is rejected by the browser alongside credentials, which is why
 * `origin` is a concrete string and not `true`.
 *
 * Registered as a function for the same reason as `registerRateLimit`: a spec
 * can mount a bare server and exercise it without a database.
 */
export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: LOCAL_FRONTEND_ORIGIN,
    credentials: true,
  })
}
