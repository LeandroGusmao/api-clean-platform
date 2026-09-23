import { describe, expect, it } from 'vitest'
import {
  AuditEvent,
  type AuditEventDevice,
  AuditEventType,
} from '#modules/auth/entities/audit-event'

const EVENT_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const NOW = new Date('2026-09-20T12:00:00.000Z')
const AN_OLD_YEAR = 1999

const create = (device: AuditEventDevice = { ip: IP, label: DEVICE_LABEL }) =>
  AuditEvent.create({
    id: EVENT_ID,
    type: AuditEventType.PasswordChanged,
    userId: USER_ID,
    device,
    now: NOW,
  })

describe('AuditEvent', () => {
  it('carries the type, the user, the device and the instant', () => {
    const event = create()

    expect(event.id).toBe(EVENT_ID)
    expect(event.type).toBe('PASSWORD_CHANGED')
    expect(event.userId).toBe(USER_ID)
    expect(event.ip).toBe(IP)
    expect(event.deviceLabel).toBe(DEVICE_LABEL)
    expect(event.occurredAt).toEqual(NOW)
  })

  it('accepts an address that did not parse, keeping the label', () => {
    const event = create({ ip: null, label: DEVICE_LABEL })

    expect(event.ip).toBeNull()
    expect(event.deviceLabel).toBe(DEVICE_LABEL)
  })

  it('has exactly the five security event types', () => {
    expect(Object.values(AuditEventType).sort()).toEqual([
      'ACCOUNT_DELETED',
      'GOOGLE_ACCOUNT_LINKED',
      'PASSWORD_CHANGED',
      'PASSWORD_RESET_COMPLETED',
      'REFRESH_TOKEN_REUSE_DETECTED',
    ])
  })

  it('does not let a caller mutate its date through a getter', () => {
    const event = create()

    event.occurredAt.setFullYear(AN_OLD_YEAR)

    expect(event.occurredAt).toEqual(NOW)
  })

  it('does not let the supplied instant be mutated after creation', () => {
    const mutable = new Date(NOW.getTime())
    const event = AuditEvent.create({
      id: EVENT_ID,
      type: AuditEventType.AccountDeleted,
      userId: USER_ID,
      device: { ip: IP, label: DEVICE_LABEL },
      now: mutable,
    })

    mutable.setFullYear(AN_OLD_YEAR)

    expect(event.occurredAt).toEqual(NOW)
  })

  it('keeps its state out of JSON, so a stray log cannot leak it', () => {
    expect(JSON.stringify(create())).toBe('{}')
  })
})
