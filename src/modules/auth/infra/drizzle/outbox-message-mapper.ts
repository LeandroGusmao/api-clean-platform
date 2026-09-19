import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { outboxMessages } from './schema/outbox-messages.js'

type OutboxMessageRow = typeof outboxMessages.$inferSelect

/**
 * The claim is not part of the insert: a message is born unclaimed, and only
 * `claimNext` ever writes the column, so the database stores NULL.
 */
export function toPersistenceOutboxMessage(
  message: OutboxMessage,
): Omit<OutboxMessageRow, 'id' | 'claimedUntil'> & { id: string } {
  return {
    id: message.id,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attempts: message.attempts,
    lastError: message.lastError,
    dispatchedAt: message.dispatchedAt,
    failedAt: message.failedAt,
    createdAt: message.createdAt,
  }
}

export function toDomainOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.fromTrusted({
    id: row.id,
    to: row.to,
    subject: row.subject,
    text: row.text,
    attempts: row.attempts,
    lastError: row.lastError,
    dispatchedAt: row.dispatchedAt,
    failedAt: row.failedAt,
    createdAt: row.createdAt,
  })
}
