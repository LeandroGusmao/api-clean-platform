import type { Redis } from 'ioredis'
import type { HealthCheckResult } from '#infra/health/checks/database-check'

const REDIS_CHECK_NAME = 'redis'

/** The one command the probe issues, so a test double needs only this. */
export type HealthRedis = Pick<Redis, 'ping'>

export async function checkRedis(redis: HealthRedis): Promise<HealthCheckResult> {
  try {
    await redis.ping()
    return { name: REDIS_CHECK_NAME, up: true }
  } catch (error) {
    return { name: REDIS_CHECK_NAME, up: false, error }
  }
}
