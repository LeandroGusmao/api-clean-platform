import { once } from 'node:events'
import type { Redis } from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '#infra/config/env'
import { closeRedis, connectRedis, createRedis } from '#infra/redis/client'

// Port 1 is never a Redis: the connection is refused, which is a real failure
// and not a stubbed one.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'
const PONG = 'PONG'

// Log lines are read by whoever is paged: spelled out, not imported.
const CONNECTION_READY_LOG = 'redis connection ready'
const CONNECTION_LOST_LOG = 'redis connection lost'

const openClients: Redis[] = []

const recordingLog = () => ({ warn: vi.fn(), info: vi.fn() })

function startClient(
  overrides: Partial<Pick<typeof env, 'REDIS_URL'>> = {},
  log = recordingLog(),
): Redis {
  const redis = createRedis({ ...env, ...overrides }, log)
  openClients.push(redis)

  return redis
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(closeRedis))
})

describe('the Redis client', () => {
  it('answers a command once connected', async () => {
    const redis = startClient()

    expect(await connectRedis(redis)).toBe(true)
    expect(await redis.ping()).toBe(PONG)
  })

  // The offline queue is what would hold this command until the reconnect
  // succeeded — and a login request with it. Failing inside the command
  // timeout, and in practice at once, is the whole point of the options.
  it('fails a command at once, instead of queuing it, when the server is unreachable', async () => {
    const redis = startClient({ REDIS_URL: UNREACHABLE_REDIS_URL })

    expect(await connectRedis(redis)).toBe(false)

    const startedAt = performance.now()
    await expect(redis.ping()).rejects.toThrow()

    expect(performance.now() - startedAt).toBeLessThan(env.REDIS_COMMAND_TIMEOUT_MS)
  })

  it('closes without throwing while the connection is down', async () => {
    const redis = startClient({ REDIS_URL: UNREACHABLE_REDIS_URL })
    await connectRedis(redis)

    await expect(closeRedis(redis)).resolves.toBeUndefined()
  })

  // One line per transition: `close` also fires on every failed reconnection
  // attempt, and a log line each would bury the one that matters.
  it('reports a lost connection once and its return', async () => {
    const log = recordingLog()
    const redis = startClient({}, log)
    await connectRedis(redis)

    const reconnected = once(redis, 'ready')
    redis.disconnect(true)
    await reconnected

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(CONNECTION_LOST_LOG)
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenNthCalledWith(1, CONNECTION_READY_LOG)
    expect(log.info).toHaveBeenNthCalledWith(2, CONNECTION_READY_LOG)
  })
})
