import type { FastifyRateLimitStore } from '@fastify/rate-limit'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { RateLimitStoreUnavailableError } from './rate-limit-store-unavailable-error.js'

/** The one command this store issues, so a test double needs only this. */
export type RateLimitRedis = Pick<Redis, 'eval'>

const SINGLE_KEY = 1

/**
 * Count and expiry in ONE script, so they are atomic: as two commands, a
 * connection dropped between `INCR` and `PEXPIRE` would leave a key with no
 * expiry, and that address would stay blocked for good. The `ttl < 0` branch
 * also gives a key that already lost its expiry a fresh one.
 */
const COUNT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`

const scriptReplySchema = z.tuple([z.number(), z.number()])

type IncrCallback = Parameters<FastifyRateLimitStore['incr']>[1]

/**
 * The counter of one route, kept in Redis so every replica sees the same number.
 *
 * Any failure — the client's, or a reply this store cannot read — is reported as
 * `RateLimitStoreUnavailableError`. The driver's own error is dropped on purpose:
 * see that class for why it carries no cause.
 */
export class RedisRateLimitStore implements FastifyRateLimitStore {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly keyPrefix: string,
  ) {}

  incr(key: string, callback: IncrCallback, timeWindow: number): void {
    this.count(key, timeWindow).then(
      (result) => callback(null, result),
      () => callback(new RateLimitStoreUnavailableError()),
    )
  }

  /** The plugin derives per-route stores from the store it was given, never from one of these. */
  child(): FastifyRateLimitStore {
    return this
  }

  private async count(key: string, timeWindow: number) {
    const reply = await this.redis.eval(
      COUNT_SCRIPT,
      SINGLE_KEY,
      `${this.keyPrefix}${key}`,
      timeWindow,
    )
    const [current, ttl] = scriptReplySchema.parse(reply)

    return { current, ttl }
  }
}
