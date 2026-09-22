import type { Pool, PoolClient, QueryConfig } from 'pg'

const DATABASE_CHECK_NAME = 'database'
const PROBE_QUERY = 'select 1'

const CHECKOUT_TIMEOUT_MESSAGE =
  'database health check timed out waiting for a pooled connection'
const QUERY_TIME_EXHAUSTED_MESSAGE =
  'database health check spent its whole deadline waiting for a pooled connection'
const PREVIOUS_CHECKOUT_PENDING_MESSAGE =
  'a previous database health check is still waiting for a pooled connection'

/**
 * `pg` reads `query_timeout` as "no timeout" when it is 0, so a remaining budget
 * that rounds down to nothing must never reach it.
 */
const MIN_QUERY_TIMEOUT_MS = 1

/** `release(true)` makes the pool end the client instead of keeping it. */
const DISCARD_CLIENT = true

export interface HealthCheckResult {
  name: string
  up: boolean
  error?: unknown
}

/** The one call the probe makes on the pool, so a test double needs only this. */
export type HealthPool = Pick<Pool, 'connect'>

export type DatabaseCheck = () => Promise<HealthCheckResult>

/**
 * `@types/pg` leaves it out of `QueryConfig`, but `pg` reads it per query: a
 * client-side deadline, counted from when the query is queued on the client.
 */
type ProbeQueryConfig = QueryConfig & { query_timeout: number }

function down(error: unknown): HealthCheckResult {
  return { name: DATABASE_CHECK_NAME, up: false, error }
}

/**
 * Builds the database probe, which answers within `timeoutMs` whatever the
 * server does.
 *
 * The pool's Postgres timeouts (`statement_timeout` and friends) are enforced
 * BY the server, so a server that accepted the connection and then stopped
 * answering — paused, partitioned, wedged — never enforces them, and a bare
 * `select 1` waits forever. The deadline therefore lives here, on the client,
 * and covers both halves of the probe:
 *
 * - **the checkout**, raced against the deadline. `pg-pool` cannot cancel a
 *   checkout, so one that loses is not forgotten: when it finally settles, the
 *   client goes back to the pool. Until then later probes report down at once
 *   instead of queueing another connection attempt behind it, so a probe
 *   polling a dead database holds at most one.
 * - **the query**, with `pg`'s own per-query `query_timeout`. On expiry the
 *   client is released with `DISCARD_CLIENT`: the pool drops it, and `pg` ends
 *   a client whose query is still in flight by destroying its socket. Handing
 *   it back instead would park a client whose next user queues behind a reply
 *   that may never come.
 */
export function createDatabaseCheck(pool: HealthPool, timeoutMs: number): DatabaseCheck {
  let checkoutPending = false

  function checkoutWithin(deadlineMs: number): Promise<PoolClient> {
    return new Promise((resolve, reject) => {
      let abandoned = false
      const timer = setTimeout(() => {
        abandoned = true
        checkoutPending = true
        reject(new Error(CHECKOUT_TIMEOUT_MESSAGE))
      }, deadlineMs)

      pool.connect().then(
        (client) => {
          clearTimeout(timer)
          if (!abandoned) return resolve(client)
          checkoutPending = false
          client.release()
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (!abandoned) return reject(error)
          checkoutPending = false
        },
      )
    })
  }

  return async () => {
    if (checkoutPending) return down(new Error(PREVIOUS_CHECKOUT_PENDING_MESSAGE))

    const startedAt = performance.now()
    let client: PoolClient
    try {
      client = await checkoutWithin(timeoutMs)
    } catch (error) {
      return down(error)
    }

    const remainingMs = Math.floor(timeoutMs - (performance.now() - startedAt))
    if (remainingMs < MIN_QUERY_TIMEOUT_MS) {
      client.release()
      return down(new Error(QUERY_TIME_EXHAUSTED_MESSAGE))
    }

    const probe: ProbeQueryConfig = { text: PROBE_QUERY, query_timeout: remainingMs }
    try {
      await client.query(probe)
    } catch (error) {
      client.release(DISCARD_CLIENT)
      return down(error)
    }

    client.release()
    return { name: DATABASE_CHECK_NAME, up: true }
  }
}
