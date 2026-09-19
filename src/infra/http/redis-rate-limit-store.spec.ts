import type { FastifyRateLimitStore } from '@fastify/rate-limit'
import { describe, expect, it, vi } from 'vitest'
import { RateLimitStoreUnavailableError } from './rate-limit-store-unavailable-error.js'
import { type RateLimitRedis, RedisRateLimitStore } from './redis-rate-limit-store.js'

const KEY_PREFIX = 'test:route:'
const ADDRESS = '203.0.113.7'
const WINDOW_MS = 60_000
const MAX_REQUESTS = 10
const SCRIPT_KEY_COUNT = 1
const DRIVER_ADDRESS = '10.0.0.5'
const DRIVER_ERROR_MESSAGE = `connect ECONNREFUSED ${DRIVER_ADDRESS}:6379`

interface Outcome {
  error: Error | null
  result: { current: number; ttl: number } | undefined
}

function redisAnswering(reply: unknown) {
  const evalScript = vi.fn().mockResolvedValue(reply)

  return { redis: { eval: evalScript } as unknown as RateLimitRedis, evalScript }
}

function redisFailing(error: Error): RateLimitRedis {
  return { eval: vi.fn().mockRejectedValue(error) } as unknown as RateLimitRedis
}

/** Typed as the plugin's interface, whose `incr` takes the `max` this store ignores. */
function increment(store: FastifyRateLimitStore): Promise<Outcome> {
  return new Promise((resolve) => {
    store.incr(
      ADDRESS,
      (error, result) => resolve({ error, result }),
      WINDOW_MS,
      MAX_REQUESTS,
    )
  })
}

describe('RedisRateLimitStore', () => {
  it('returns the count and the time left, as the script reports them', async () => {
    const { redis } = redisAnswering([3, 42_000])

    const { error, result } = await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(error).toBeNull()
    expect(result).toEqual({ current: 3, ttl: 42_000 })
  })

  it('counts under the route prefix and sends the window as the expiry', async () => {
    const { redis, evalScript } = redisAnswering([1, WINDOW_MS])

    await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      SCRIPT_KEY_COUNT,
      `${KEY_PREFIX}${ADDRESS}`,
      WINDOW_MS,
    )
  })

  // The driver error carries the server address, and pino prints a cause chain:
  // dropping it here is what keeps that address out of the log and the response.
  it('reports any failure of the client as unavailable, dropping the driver error', async () => {
    const store = new RedisRateLimitStore(
      redisFailing(new Error(DRIVER_ERROR_MESSAGE)),
      KEY_PREFIX,
    )

    const { error, result } = await increment(store)

    expect(error).toBeInstanceOf(RateLimitStoreUnavailableError)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(error?.message).not.toContain(DRIVER_ADDRESS)
    expect(result).toBeUndefined()
  })

  it('reports a reply it cannot read as unavailable', async () => {
    const { redis } = redisAnswering('OK')

    const { error } = await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(error).toBeInstanceOf(RateLimitStoreUnavailableError)
  })
})
