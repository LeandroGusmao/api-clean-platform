import { describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { toPersistenceOutboxMessage } from './outbox-message-mapper.js'

const NOW = new Date('2026-09-19T12:00:00.000Z')

describe('toPersistenceOutboxMessage', () => {
  // A message is born unclaimed, and only `claimNext` ever writes the column:
  // the insert leaves it out and the database stores NULL.
  it('leaves the claim out of the insert', () => {
    const message = OutboxMessage.create({
      id: 'message-1',
      message: { to: 'joao@example.com', subject: 'subject', text: 'text' },
      now: NOW,
    })

    expect(toPersistenceOutboxMessage(message)).not.toHaveProperty('claimedUntil')
  })
})
