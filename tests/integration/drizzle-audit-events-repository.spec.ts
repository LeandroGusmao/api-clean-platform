import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { auditEvents } from '#modules/auth/infra/drizzle/schema/audit-events'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'

const EVENT_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_EVENT_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const THIRD_EVENT_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
/** A user id with NO row in `users`: the trail has no foreign key to it. */
const UNKNOWN_USER_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const CUTOFF = new Date('2026-09-20T12:00:00.000Z')
const ONE_SECOND_MS = 1000
const ONE_ROW = 1
const TWO_ROWS = 2

let db: Database
let pool: Pool
let repository: IAuditEventsRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = authRepositories(db).auditEvents
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(auditEvents)
})

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.PasswordChanged,
    userId: UNKNOWN_USER_ID,
    device: { ip: IP, label: DEVICE_LABEL },
    now: occurredAt,
  })

const offset = (ms: number) => new Date(CUTOFF.getTime() + ms)

describe('DrizzleAuditEventsRepository', () => {
  it('saves an event with its type, device and instant', async () => {
    await repository.save(eventAt(EVENT_ID, CUTOFF))

    const [row] = await db.select().from(auditEvents)

    expect(row).toEqual({
      id: EVENT_ID,
      type: 'PASSWORD_CHANGED',
      userId: UNKNOWN_USER_ID,
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      occurredAt: CUTOFF,
    })
  })

  it('keeps an event for a user that has no row: there is no foreign key', async () => {
    await repository.save(eventAt(EVENT_ID, CUTOFF))

    expect(await db.select().from(auditEvents)).toHaveLength(ONE_ROW)
  })

  it('deletes what happened at or before the cutoff and returns how many', async () => {
    await repository.save(eventAt(EVENT_ID, offset(-ONE_SECOND_MS)))
    await repository.save(eventAt(OTHER_EVENT_ID, CUTOFF))
    await repository.save(eventAt(THIRD_EVENT_ID, offset(ONE_SECOND_MS)))

    const deleted = await repository.deleteOccurredBefore(CUTOFF)

    expect(deleted).toBe(TWO_ROWS)
    const remaining = await db.select().from(auditEvents)
    expect(remaining.map((row) => row.id)).toEqual([THIRD_EVENT_ID])
  })
})
