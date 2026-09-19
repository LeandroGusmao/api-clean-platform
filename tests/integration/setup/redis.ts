import { Redis } from 'ioredis'
import { env } from '#infra/config/env'

/**
 * Empties the test Redis. Counters outlive an app instance — unlike the
 * in-process store they replace — so a case that asserts on a ceiling has to
 * start from zero. `env.REDIS_URL` is the fixture `vitest.config.ts` injects,
 * never a `.env` value.
 */
export async function flushRedis(): Promise<void> {
  const redis = new Redis(env.REDIS_URL)

  try {
    await redis.flushdb()
  } finally {
    redis.disconnect()
  }
}
