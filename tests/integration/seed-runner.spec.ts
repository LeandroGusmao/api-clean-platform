import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import type { SeedModule } from '#infra/database/seeds/seed-module'
import { runSeed, type SeedLogger, SeedTargetError } from '#main/seeds/runner'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const PRIMARY_DOMAIN = 'runner-primary.local'
const SECONDARY_DOMAIN = 'runner-secondary.local'
const PASSWORD_HASH = 'argon2-irrelevant'
const MARKER = 'prepared'
const SCENARIO_FAILURE = 'scenario blew up'
const REMOTE_DATABASE_URL = 'postgres://user:pass@db.example.com:5432/app'
const LIKE_ANY_PREFIX = '%@'

const PREPARED_EMAIL = `${MARKER}@${PRIMARY_DOMAIN}`
/** Written by `second`, which counts the rows `first` left: 1 proves the order. */
const SECOND_SAW_FIRST_EMAIL = `second-saw-1@${PRIMARY_DOMAIN}`
const STALE_SECONDARY_EMAIL = `stale@${SECONDARY_DOMAIN}`
const HALF_WRITTEN_EMAIL = `half-written@${PRIMARY_DOMAIN}`

const SILENT_LOGGER: SeedLogger = { info: () => {}, warn: () => {} }

interface PrimaryPreparation {
  marker: string
}

let db: Database
let pool: Pool
let wipes: string[]

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  wipes = []
  await db.delete(users)
})

const insertUser = (tx: Database, email: string) =>
  tx.insert(users).values({ email, passwordHash: PASSWORD_HASH })

const deleteDomain = (tx: Database, domain: string) =>
  tx.delete(users).where(sql`lower(${users.email}) like ${`${LIKE_ANY_PREFIX}${domain}`}`)

const primary: SeedModule<PrimaryPreparation> = {
  name: 'primary',
  scenarios: [
    {
      name: 'first',
      description: 'first',
      byDefault: true,
      async run({ tx, preparation }) {
        await insertUser(tx, `${preparation.marker}@${PRIMARY_DOMAIN}`)
      },
    },
    {
      name: 'second',
      description: 'second',
      dependsOn: ['primary:first'],
      async run({ tx }) {
        const firstRows = await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${PREPARED_EMAIL}`)
        await insertUser(tx, `second-saw-${firstRows.length}@${PRIMARY_DOMAIN}`)
      },
    },
  ],
  async prepare() {
    return { marker: MARKER }
  },
  async wipe(tx) {
    wipes.push('primary')
    await deleteDomain(tx, PRIMARY_DOMAIN)
  },
}

const secondary: SeedModule = {
  name: 'secondary',
  scenarios: [{ name: 'only', description: 'only', async run() {} }],
  async prepare() {
    return undefined
  },
  async wipe(tx) {
    wipes.push('secondary')
    await deleteDomain(tx, SECONDARY_DOMAIN)
  },
}

const failing: SeedModule = {
  name: 'failing',
  scenarios: [
    {
      name: 'boom',
      description: 'boom',
      async run({ tx }) {
        await insertUser(tx, HALF_WRITTEN_EMAIL)
        throw new Error(SCENARIO_FAILURE)
      },
    },
  ],
  async prepare() {
    return undefined
  },
  async wipe() {},
}

async function storedEmails(): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users)
  return rows.map((row) => row.email).sort()
}

describe('runSeed', () => {
  it('runs dependencies first and hands each scenario its module preparation', async () => {
    const ran = await runSeed(env, SILENT_LOGGER, ['primary:second'], [primary])

    expect(ran).toEqual(['primary:first', 'primary:second'])
    expect(await storedEmails()).toEqual([PREPARED_EMAIL, SECOND_SAW_FIRST_EMAIL])
  })

  it('lands on the same rows when run twice', async () => {
    await runSeed(env, SILENT_LOGGER, [], [primary])
    const afterFirstRun = await storedEmails()
    await runSeed(env, SILENT_LOGGER, [], [primary])

    expect(afterFirstRun).toEqual([PREPARED_EMAIL])
    expect(await storedEmails()).toEqual(afterFirstRun)
  })

  it('wipes every module, in reverse order, even when only one is selected', async () => {
    await insertUser(db, STALE_SECONDARY_EMAIL)

    await runSeed(env, SILENT_LOGGER, ['primary:first'], [primary, secondary])

    expect(wipes).toEqual(['secondary', 'primary'])
    expect(await storedEmails()).toEqual([PREPARED_EMAIL])
  })

  it('rolls the whole run back when a scenario throws', async () => {
    await runSeed(env, SILENT_LOGGER, [], [primary])

    await expect(
      runSeed(env, SILENT_LOGGER, ['failing:boom'], [primary, failing]),
    ).rejects.toThrow(SCENARIO_FAILURE)

    expect(await storedEmails()).toEqual([PREPARED_EMAIL])
  })

  it('refuses a remote database before touching any module', async () => {
    await expect(
      runSeed(
        { ...env, DATABASE_URL: REMOTE_DATABASE_URL },
        SILENT_LOGGER,
        [],
        [primary],
      ),
    ).rejects.toThrow(SeedTargetError)

    expect(wipes).toEqual([])
  })
})
