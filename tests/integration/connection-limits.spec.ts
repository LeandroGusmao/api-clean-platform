import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'

/**
 * Spelled out rather than imported from `client.ts`, following the same rule
 * `drizzle-users-repository.spec.ts` states: in a test this IS the contract
 * being asserted, and importing it would make the assertion tautological.
 */
const EXPECTED_APPLICATION_NAME = 'api-clean-platform'

/**
 * `pg_settings.setting` reports these in their base unit — milliseconds — as a
 * plain number. `current_setting()` would normalise 10000 into `'10s'`, so the
 * assertion would be comparing formatting rather than value.
 */
const TIMEOUT_SETTING_NAMES = [
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
] as const

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

async function readSettings(): Promise<Map<string, string>> {
  const result = await db.execute(
    sql`select name, setting from pg_settings where name in (${sql.join(
      TIMEOUT_SETTING_NAMES.map((name) => sql`${name}`),
      sql`, `,
    )})`,
  )
  const rows = (Array.isArray(result) ? result : result.rows) as Array<{
    name: string
    setting: string
  }>

  return new Map(rows.map((row) => [row.name, row.setting]))
}

describe('connection limits (integration — real Postgres)', () => {
  /**
   * The failure this exists for is not a wrong value — the compiler types these
   * options, so a typo cannot reach here. It is a value that is configured and
   * never takes effect: a pooler that drops startup parameters, a `DATABASE_URL`
   * carrying a conflicting `?options=`, a driver change. Nothing in the unit
   * suite can tell that apart from success.
   */
  it('puts every configured timeout in effect on the session', async () => {
    const settings = await readSettings()

    expect(settings.get('statement_timeout')).toBe(
      String(env.DATABASE_STATEMENT_TIMEOUT_MS),
    )
    expect(settings.get('lock_timeout')).toBe(String(env.DATABASE_LOCK_TIMEOUT_MS))
    expect(settings.get('idle_in_transaction_session_timeout')).toBe(
      String(env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    )
  })

  it('names its connections so pg_stat_activity can tell them apart', async () => {
    const result = await db.execute(
      sql`select current_setting('application_name') as name`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{ name: string }>

    expect(rows[0]?.name).toBe(EXPECTED_APPLICATION_NAME)
  })

  it('caps the pool at the configured size', async () => {
    expect(pool.options.max).toBe(env.DATABASE_POOL_MAX)
  })
})
