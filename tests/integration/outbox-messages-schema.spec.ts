import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological.
const TABLE_NAME = 'outbox_messages'
const PENDING_INDEX = 'outbox_messages_pending_idx'
const PENDING_INDEX_PREDICATE = 'WHERE ((dispatched_at IS NULL) AND (failed_at IS NULL))'
const NOT_NULL_VIOLATION = '23502'

const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const CREATED_AT = new Date('2026-09-15T00:00:00.000Z')
const ZERO_ATTEMPTS = 0
const ONE_INDEX = 1

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(outboxMessages)
})

const row = (overrides: Partial<typeof outboxMessages.$inferInsert> = {}) => ({
  id: ROW_ID,
  to: 'joao@example.com',
  subject: 'subject',
  text: 'text',
  attempts: ZERO_ATTEMPTS,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('outbox_messages table', () => {
  it('stores a row with every column, dispatchedAt/failedAt/lastError null by default input', async () => {
    await db.insert(outboxMessages).values(row())

    const [stored] = await db.select().from(outboxMessages)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.to).toBe('joao@example.com')
    expect(stored?.subject).toBe('subject')
    expect(stored?.text).toBe('text')
    expect(stored?.attempts).toBe(ZERO_ATTEMPTS)
    expect(stored?.lastError).toBeNull()
    expect(stored?.dispatchedAt).toBeNull()
    expect(stored?.failedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without attempts, proving there is no default', async () => {
    const { attempts: _attempts, ...withoutAttempts } = row()

    await expect(
      db.insert(outboxMessages).values(withoutAttempts as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('carries the partial pending index', async () => {
    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
      indexdef: string
    }>

    const pending = rows.filter((r) => r.indexname === PENDING_INDEX)
    expect(pending).toHaveLength(ONE_INDEX)
    expect(pending[0]?.indexdef).toContain(PENDING_INDEX_PREDICATE)
  })
})
