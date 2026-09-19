import type {
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
} from '@fastify/rate-limit'
import LocalStore from '@fastify/rate-limit/store/LocalStore.js'
import { type RateLimitRedis, RedisRateLimitStore } from './redis-rate-limit-store.js'

/** A constant, so every replica reads and writes the same keys. */
const RATE_LIMIT_KEY_PREFIX = 'api-clean-platform:rate-limit:'
const KEY_SEPARATOR = ':'

/** The plugin's two optional behaviours for the in-process counter, neither enabled anywhere. */
const CONTINUE_EXCEEDING = false
const EXPONENTIAL_BACKOFF = false

/**
 * What the plugin really passes to `child`: the route's merged options, with
 * the route itself under `routeInfo`. Its typings say `RouteOptions`, which the
 * runtime object is not — checked against 11.2.0, and pinned by the specs that
 * count one route apart from another.
 */
interface ChildParams {
  routeInfo: { method?: string | string[]; url?: string }
}

/**
 * The store handed to `@fastify/rate-limit`, splitting routes by who declares
 * the ceiling (decision 39).
 *
 * The plugin calls `child` for a route that declares its own `config.rateLimit`
 * and uses the store itself for every other route. So the routes whose ceiling
 * defends against guessing count in Redis, shared by every replica, while the
 * global ceiling stays in process: no round trip on ordinary routes, and a
 * Redis outage does not reach them.
 */
export function createScopedRateLimitStore(
  redis: RateLimitRedis,
): FastifyRateLimitStoreCtor {
  return class ScopedRateLimitStore implements FastifyRateLimitStore {
    private readonly perProcess = new LocalStore(CONTINUE_EXCEEDING, EXPONENTIAL_BACKOFF)

    incr(...args: Parameters<FastifyRateLimitStore['incr']>): void {
      this.perProcess.incr(...args)
    }

    child(
      routeOptions: Parameters<FastifyRateLimitStore['child']>[0],
    ): FastifyRateLimitStore {
      const { routeInfo } = routeOptions as unknown as ChildParams
      const route = `${String(routeInfo.method ?? '')}${KEY_SEPARATOR}${routeInfo.url ?? ''}`

      return new RedisRateLimitStore(
        redis,
        `${RATE_LIMIT_KEY_PREFIX}${route}${KEY_SEPARATOR}`,
      )
    }
  }
}
