import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import type { Env } from '#infra/config/env'
import { clientIpKey } from './client-ip.js'

const MILLISECONDS_PER_SECOND = 1000

/**
 * Only the two values the limiter consumes. Declaring the narrow type IS the
 * slice (decision 23): a caller passes `env` whole and this function still
 * cannot see `DATABASE_URL` — reaching for it is a compile error, not a review
 * comment.
 */
export type RateLimitEnv = Pick<
  Env,
  'RATE_LIMIT_MAX_REQUESTS' | 'RATE_LIMIT_WINDOW_SECONDS'
>

/**
 * A per-address ceiling on every route.
 *
 * It counts REQUESTS, not failed authentications — no transport limiter can
 * know a password was wrong. That half was deliberately delegated to the edge
 * and to the cost of argon2; what it buys, what it costs and what reopens it
 * are in `docs/superpowers/specs/2026-09-02-rate-limiting-design.md` §10.1.
 * If you find yourself adding an attempt counter here, read that section first.
 *
 * Registered as a function rather than inline in `buildApp`, for the same
 * reason `registerErrorHandling` and `registerOpenApi` are: a spec can then
 * mount a bare server and exercise the limiter without a database.
 *
 * The store is in-process. With N replicas the effective ceiling is N times the
 * configured one — one more reason the limit that matters belongs at the edge.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  env: RateLimitEnv,
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    /**
     * Replaces the plugin's default, which reads `request.ip` raw — and that
     * value is attacker-written text whenever a proxy is trusted. `normalizeIP`
     * is applied on top because overriding the generator would otherwise throw
     * away the /64 grouping the default gives IPv6, and without it a single
     * subscriber has unlimited buckets.
     *
     * Routes opt OUT through `config: { rateLimit: false }` on the route
     * itself. Not through `allowList`: measured, its string array is compared
     * against this key and never against the path, so a list of paths exempts
     * nothing at all while looking exactly like it should work.
     */
    keyGenerator: (request) => normalizeIP(clientIpKey(request)),
  })
}
