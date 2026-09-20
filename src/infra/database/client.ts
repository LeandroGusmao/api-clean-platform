import type { EmptyRelations } from 'drizzle-orm'
import {
  drizzle,
  type NodePgDatabase,
  type NodePgTransaction,
} from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Env } from '#infra/config/env'

// The object Drizzle hands to a `db.transaction()` callback isn't the same
// type as the top-level handle; repositories accepting both need this union.
export type Database = NodePgDatabase | NodePgTransaction<EmptyRelations>

const POOL_ERROR_MESSAGE = 'unexpected error on idle database client'

/**
 * Names this API's connections in `pg_stat_activity`. Without it every row
 * reads `node-postgres`, and the query you run while diagnosing pool exhaustion
 * cannot tell this API apart from a migration, a seed or a psql session.
 *
 * Constant rather than per-replica: identifying a replica is the log's job via
 * hostname, and a name per replica would break the grouping that makes the
 * query useful in the first place.
 */
const APPLICATION_NAME = 'api-clean-platform'

export function createDatabase(env: Env): { db: Database; pool: Pool } {
  // Every limit comes from the environment, because the right value depends on
  // how many instances run: the ceiling is
  // `instances × DATABASE_POOL_MAX <= max_connections - reserve`, so raising the
  // pool per instance is the wrong lever past a handful of replicas. The
  // reasoning lives in `ARCHITECTURE.md` §6.
  //
  // The three Postgres timeouts are sent only when truthy — `pg` guards each
  // with `if (params.x)`. A configured 0 therefore does NOT disable them; it
  // leaves whatever the server already has in effect, which on a managed
  // Postgres may well be a non-zero parameter-group value.
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    application_name: APPLICATION_NAME,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: env.DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  })

  pool.on('error', (err) => {
    console.error(POOL_ERROR_MESSAGE, err)
  })

  const db = drizzle({ client: pool })
  return { db, pool }
}
