import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { runReset } from '#main/reset/runner'
import { type SeedLogger, SeedTargetError } from '#main/seeds/runner'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { SEED_DEV_EMAIL } from '#modules/auth/infra/seeds/base-users'

const SILENT_LOGGER: SeedLogger = { info: () => {}, warn: () => {} }
const DEFAULT_SCENARIO = 'auth:base-users'
const REMOTE_DATABASE_URL = 'postgres://user:pass@db.example.com:5432/app'

const STRAY_TABLE = 'reset_runner_spec_leftover'
const CREATE_STRAY_TABLE = `CREATE TABLE ${STRAY_TABLE} (id int)`
const STRAY_TABLE_COUNT_QUERY = `
  SELECT count(*)::int AS count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = '${STRAY_TABLE}'
`

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

describe('runReset', () => {
  it('drops everything the current migrations do not know about, then reseeds the default scenarios', async () => {
    await pool.query(CREATE_STRAY_TABLE)

    const ran = await runReset(env, SILENT_LOGGER)

    expect(ran).toEqual([DEFAULT_SCENARIO])

    const { rows } = await pool.query(STRAY_TABLE_COUNT_QUERY)
    expect(rows[0]?.count).toBe(0)

    const [seeded] = await db.select().from(users).where(eq(users.email, SEED_DEV_EMAIL))
    expect(seeded).toBeDefined()
  })

  it('refuses a remote database before dropping anything', async () => {
    await pool.query(CREATE_STRAY_TABLE)

    await expect(
      runReset({ ...env, DATABASE_URL: REMOTE_DATABASE_URL }, SILENT_LOGGER),
    ).rejects.toThrow(SeedTargetError)

    const { rows } = await pool.query(STRAY_TABLE_COUNT_QUERY)
    expect(rows[0]?.count).toBe(1)

    await pool.query(`DROP TABLE ${STRAY_TABLE}`)
  })
})
