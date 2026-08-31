import type { Env } from '#infra/config/env'
import type { Database } from '#infra/database/client'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import type { AppLogger } from '#infra/observability/logger'
import { makeAuthContainer } from '#modules/auth/container'

/**
 * The whole dependency graph, built without Fastify. That independence is what
 * decision 10 requires: a worker and a cron share this graph and never see an
 * HTTP framework.
 *
 * `env` is passed whole, and each module's factory declares only the slice it
 * needs — `makeAuthContainer` takes `AuthConfig`, so `auth` cannot even see
 * `DATABASE_URL`. Structural typing gives decision 23's rule for free, with no
 * slicing code.
 */
export function makeContainer(db: Database, env: Env, logger: AppLogger) {
  // One per process, shared by every module's unit of work. The nesting guard
  // lives in module-level storage inside transaction-runner.ts, not on this
  // instance, so every runner already shares it regardless of how many get
  // built. Sharing ONE runner instead is about the connection, not the guard:
  // today there is a single `db` pool, so one instance is all there is to
  // build. The hazard to watch for is the inverse of what a second runner
  // would do — a future second datasource (a read replica, an analytics pool)
  // would still share the ONE module-level flag, and a transaction on one
  // connection would falsely block a call on the other datasource that is
  // nested inside the first one's async context — not a merely concurrent,
  // independent transaction on the other, which runs in its own context.
  const runner = createTransactionRunner(db, logger)

  return { auth: makeAuthContainer(db, env, runner) }
}

export type Container = ReturnType<typeof makeContainer>
