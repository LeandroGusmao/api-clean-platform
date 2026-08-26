import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './test-database-url.js'

const MIGRATIONS_FOLDER = './drizzle'

/**
 * Applies every committed migration before the integration suite runs.
 *
 * The test database is `tmpfs` (see docker-compose.yml), so it is empty again
 * after every container restart. CI applies migrations as its own pipeline step;
 * this keeps the local run identical without asking anyone to remember a manual
 * command.
 *
 * Idempotent: Drizzle records which migrations it has already applied.
 */
export async function setup() {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL })

  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}
