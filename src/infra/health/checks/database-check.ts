import { sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'

const DATABASE_CHECK_NAME = 'database'

export interface HealthCheckResult {
  name: string
  up: boolean
  error?: unknown
}

export async function checkDatabase(db: Database): Promise<HealthCheckResult> {
  try {
    await db.execute(sql`select 1`)
    return { name: DATABASE_CHECK_NAME, up: true }
  } catch (error) {
    return { name: DATABASE_CHECK_NAME, up: false, error }
  }
}
