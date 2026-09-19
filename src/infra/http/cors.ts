import cors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'

/**
 * Temporary allowance for local browser clients. Hard-coded on purpose: a real
 * allow-list belongs in `env` once a deployed origin needs it.
 *
 * The API's own origin is listed so the Swagger UI "Try it out" button works
 * when the docs tab is not on the same origin as the fetch target.
 */
const LOCAL_ALLOWED_ORIGINS = [
  'http://localhost:8081', // front-end dev server
  'http://localhost:3000', // this API — Swagger UI "Try it out"
]

/**
 * The plugin's default is `GET,HEAD,POST`, which makes the browser refuse the
 * preflight of any other verb. `DELETE` is here for `DELETE /me`; add a verb
 * only when a route actually uses it.
 */
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'DELETE']

/**
 * Cross-origin access for the browser front-end.
 *
 * `credentials: true` because the auth flow rides on a cookie, and a cookie is
 * only sent cross-origin when the response also names an explicit origin — the
 * `*` wildcard is rejected by the browser alongside credentials, which is why
 * `origin` is a concrete list and not `true`. Passed as an array so the plugin
 * reflects whichever listed origin actually called, rather than pinning one.
 *
 * Registered as a function for the same reason as `registerRateLimit`: a spec
 * can mount a bare server and exercise it without a database.
 */
export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: LOCAL_ALLOWED_ORIGINS,
    credentials: true,
    methods: ALLOWED_METHODS,
  })
}
