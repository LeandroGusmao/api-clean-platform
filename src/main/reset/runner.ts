import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import type { Env } from '#infra/config/env'
import { assertSeedTarget, runSeed, type SeedLogger } from '#main/seeds/runner'

const MIGRATIONS_FOLDER = './drizzle'

/** Where the application's own tables live. */
const PUBLIC_SCHEMA = 'public'
/** Where `drizzle-orm/node-postgres/migrator` records which migrations ran. */
const MIGRATIONS_SCHEMA = 'drizzle'

const DROP_PUBLIC_SCHEMA = `DROP SCHEMA IF EXISTS ${PUBLIC_SCHEMA} CASCADE`
const CREATE_PUBLIC_SCHEMA = `CREATE SCHEMA ${PUBLIC_SCHEMA}`
const DROP_MIGRATIONS_SCHEMA = `DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`

const NO_ARGS: readonly string[] = []

/**
 * Rebuilds the target database from the current schema and repopulates it, so
 * a simulated environment never needs a migration run of its own: drop both
 * schemas, apply every committed migration, then run the default seed
 * scenarios. One call per schema drop, not one transaction — `DROP SCHEMA`
 * commits its own DDL and a migration runner manages its own transactions.
 *
 * Guarded by `assertSeedTarget` before opening any connection, the same guard
 * `runSeed` applies on its own: production and remote hosts are refused twice
 * on the same call, once here and once inside `runSeed`, which costs nothing
 * and means this file's guard can never drift out of sync with a change to
 * the other.
 *
 * Returns the qualified scenario names `runSeed` ran, in order — the same
 * contract `runSeed` itself returns.
 */
export async function runReset(env: Env, logger: SeedLogger): Promise<string[]> {
  assertSeedTarget(env)

  const pool = new Pool({ connectionString: env.DATABASE_URL })
  try {
    await pool.query(DROP_PUBLIC_SCHEMA)
    await pool.query(CREATE_PUBLIC_SCHEMA)
    // The migrations schema tracks tables that just left with `public`;
    // dropping it too means the migrator recreates it from nothing rather than
    // replaying history against a schema it never touched.
    await pool.query(DROP_MIGRATIONS_SCHEMA)
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }

  return runSeed(env, logger, NO_ARGS)
}
