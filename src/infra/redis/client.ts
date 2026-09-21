import { Redis } from 'ioredis'
import type { Env } from '#infra/config/env'

/**
 * Only what the client reads, so reaching for another variable is a compile
 * error rather than a review comment.
 */
export type RedisEnv = Pick<
  Env,
  'REDIS_URL' | 'REDIS_CONNECT_TIMEOUT_MS' | 'REDIS_COMMAND_TIMEOUT_MS'
>

/**
 * Its own shape rather than `Pick<AppLogger, ...>`: pino's `warn` is an
 * overloaded `LogFn`, which no hand-written double can satisfy.
 */
export interface RedisLogger {
  warn(message: string): void
  info(message: string): void
}

/** Reconnection backs off in steps and stops growing here, so recovery is quick. */
const RECONNECT_STEP_MS = 50
const RECONNECT_MAX_DELAY_MS = 500

/** A command in flight when the connection drops is not re-sent after the reconnection. */
const NO_COMMAND_RETRIES = 0

const CONNECTION_READY_MESSAGE = 'redis connection ready'
const CONNECTION_LOST_MESSAGE = 'redis connection lost'
const CLIENT_ENDED_STATUS = 'end'

/**
 * Builds the client without connecting: `connectRedis` does, so a Redis that is
 * down at boot is reported by the caller instead of surfacing as an event.
 *
 * A command with no live connection fails at once. ioredis's default is to hold
 * it in an offline queue until the reconnect succeeds, which would leave a
 * request on a route that counts here hanging instead of answering 503.
 * `commandTimeout` covers the other case: a connection that is up and no
 * longer answering.
 */
export function createRedis(env: RedisEnv, log: RedisLogger): Redis {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: NO_COMMAND_RETRIES,
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt) =>
      Math.min(attempt * RECONNECT_STEP_MS, RECONNECT_MAX_DELAY_MS),
  })

  redis.on('error', () => {
    // Every failed reconnection attempt emits one; the outage is reported once,
    // through `close` below.
  })

  // One line per transition. `close` also fires on every failed reconnection
  // attempt, so it counts only while the connection was up; and a deliberate
  // shutdown ends the client, which is not a loss.
  let up = false
  redis.on('ready', () => {
    up = true
    log.info(CONNECTION_READY_MESSAGE)
  })
  redis.on('close', () => {
    if (!up) return
    up = false
    if (redis.status !== CLIENT_ENDED_STATUS) log.warn(CONNECTION_LOST_MESSAGE)
  })

  return redis
}

/**
 * False, without throwing, when the server cannot be reached: the process may
 * start before Redis, and the client keeps reconnecting in the background.
 */
export async function connectRedis(redis: Redis): Promise<boolean> {
  try {
    await redis.connect()
    return true
  } catch {
    return false
  }
}

/**
 * `QUIT` is a command, so it fails when the connection is down; `disconnect`
 * needs none, and also stops the reconnection timer that would keep the process
 * alive.
 */
export async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}
