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

const CONNECTION_TIMEOUT_MS = 5_000
const POOL_ERROR_MESSAGE = 'unexpected error on idle database client'

export function createDatabase(env: Env): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  })

  pool.on('error', (err) => {
    console.error(POOL_ERROR_MESSAGE, err)
  })

  const db = drizzle({ client: pool })
  return { db, pool }
}
