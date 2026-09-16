import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import {
  toDomainOutboxMessage,
  toPersistenceOutboxMessage,
} from './outbox-message-mapper.js'
import { outboxMessages } from './schema/outbox-messages.js'

/** How many rows affected when none matched. */
const NO_ROWS_AFFECTED = 0

/** One row increment for attempts counter. */
const ONE_INCREMENT = 1

/**
 * Drizzle adapter for OutboxMessagesRepository, wrapping the transactional
 * database operations that are specific to this persistence layer.
 */
export class DrizzleOutboxMessagesRepository implements IOutboxMessagesRepository {
  constructor(private readonly db: Database) {}

  async save(message: OutboxMessage): Promise<void> {
    try {
      await this.db.insert(outboxMessages).values(toPersistenceOutboxMessage(message))
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    try {
      const rows = await this.db
        .select()
        .from(outboxMessages)
        .where(and(isNull(outboxMessages.dispatchedAt), isNull(outboxMessages.failedAt)))
        .orderBy(outboxMessages.createdAt)
        .limit(limit)

      return rows.map(toDomainOutboxMessage)
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async markDispatched(id: string, at: Date): Promise<void> {
    try {
      await this.db
        .update(outboxMessages)
        .set({ dispatchedAt: at })
        .where(eq(outboxMessages.id, id))
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async recordFailure(
    id: string,
    at: Date,
    error: string,
    maxAttempts: number,
  ): Promise<void> {
    try {
      const rows = await this.db
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.id, id))

      const message = rows[0]
      if (!message) return

      const attempts = message.attempts + ONE_INCREMENT
      const failedAt = attempts >= maxAttempts ? at : null

      await this.db
        .update(outboxMessages)
        .set({
          attempts,
          lastError: error,
          failedAt,
        })
        .where(eq(outboxMessages.id, id))
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number> {
    try {
      const result = await this.db
        .delete(outboxMessages)
        .where(
          or(
            and(
              sql`${outboxMessages.dispatchedAt} IS NOT NULL`,
              lte(outboxMessages.dispatchedAt, cutoff),
            ),
            and(
              sql`${outboxMessages.failedAt} IS NOT NULL`,
              lte(outboxMessages.failedAt, cutoff),
            ),
          ),
        )

      return result.rowCount ?? NO_ROWS_AFFECTED
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}
