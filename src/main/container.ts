import type { Database } from '#infra/database/client'
import { makeAuthContainer } from '#modules/auth/container'

/**
 * The whole dependency graph, built without Fastify. That independence is what
 * decision 10 requires: a worker and a cron share this graph and never see an
 * HTTP framework.
 *
 * No `env` parameter yet — no module declares configuration of its own so far.
 * It gains one when login brings `JWT_SECRET` (decision 14).
 */
export function makeContainer(db: Database) {
  return { auth: makeAuthContainer(db) }
}

export type Container = ReturnType<typeof makeContainer>
