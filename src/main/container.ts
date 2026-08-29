import type { Env } from '#infra/config/env'
import type { Database } from '#infra/database/client'
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
export function makeContainer(db: Database, env: Env) {
  return { auth: makeAuthContainer(db, env) }
}

export type Container = ReturnType<typeof makeContainer>
