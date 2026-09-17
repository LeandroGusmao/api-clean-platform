import { describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { EmailMessage } from '#shared/ports/email-sender'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const NOW = new Date('2026-09-15T12:00:00.000Z')
const NO_ATTEMPTS = 0

const MESSAGE: EmailMessage = {
  to: 'joao@example.com',
  subject: 'Your password was changed',
  text: 'Your password was just changed.',
}

const fresh = () => OutboxMessage.create({ id: ID, message: MESSAGE, now: NOW })

describe('OutboxMessage.create', () => {
  it('is born with no attempts and neither dispatched nor failed', () => {
    const message = fresh()

    expect(message.id).toBe(ID)
    expect(message.to).toBe(MESSAGE.to)
    expect(message.subject).toBe(MESSAGE.subject)
    expect(message.text).toBe(MESSAGE.text)
    expect(message.attempts).toBe(NO_ATTEMPTS)
    expect(message.lastError).toBeNull()
    expect(message.dispatchedAt).toBeNull()
    expect(message.failedAt).toBeNull()
    expect(message.createdAt).toEqual(NOW)
  })

  it('yields {} under JSON.stringify, so a message body cannot leak into a stray log', () => {
    expect(JSON.stringify(fresh())).toBe('{}')
  })

  it('hands out a copy of createdAt, not the internal instance', () => {
    const message = fresh()
    message.createdAt.setFullYear(1970)

    expect(message.createdAt).toEqual(NOW)
  })

  it('reconstitutes the EmailMessage it was built from', () => {
    expect(fresh().toEmailMessage()).toEqual(MESSAGE)
  })
})

describe('OutboxMessage.fromTrusted', () => {
  it('rehydrates every field as given, including a permanent failure', () => {
    const failedAt = new Date('2026-09-15T13:00:00.000Z')
    const message = OutboxMessage.fromTrusted({
      id: ID,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      attempts: 5,
      lastError: 'connection refused',
      dispatchedAt: null,
      failedAt,
      createdAt: NOW,
    })

    expect(message.attempts).toBe(5)
    expect(message.lastError).toBe('connection refused')
    expect(message.dispatchedAt).toBeNull()
    expect(message.failedAt).toEqual(failedAt)
  })
})
