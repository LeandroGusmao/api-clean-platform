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
const NO_ROW_AFFECTED = 0

/** One row increment for attempts counter. */
const ONE_INCREMENT = 1

/** One message per claim, so the lease only has to cover one send. */
const ONE_MESSAGE_PER_CLAIM = 1

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

  async claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null> {
    try {
      // `SKIP LOCKED` is what keeps two callers from waiting on, or receiving,
      // the same row; the whole thing is ONE statement, so no transaction stays
      // open while the caller sends.
      const next = this.db
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(
          and(
            isNull(outboxMessages.dispatchedAt),
            isNull(outboxMessages.failedAt),
            or(
              isNull(outboxMessages.claimedUntil),
              lte(outboxMessages.claimedUntil, now),
            ),
          ),
        )
        .orderBy(outboxMessages.createdAt)
        .limit(ONE_MESSAGE_PER_CLAIM)
        .for('update', { skipLocked: true })

      const [row] = await this.db
        .update(outboxMessages)
        .set({ claimedUntil: leaseUntil })
        .where(eq(outboxMessages.id, next))
        .returning()

      return row === undefined ? null : toDomainOutboxMessage(row)
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
      await this.db
        .update(outboxMessages)
        .set({
          attempts: sql`${outboxMessages.attempts} + ${ONE_INCREMENT}`,
          lastError: error,
          failedAt: sql`case when ${outboxMessages.attempts} + ${ONE_INCREMENT} >= ${maxAttempts} then ${at} else ${outboxMessages.failedAt} end`,
        })
        .where(eq(outboxMessages.id, id))
    } catch (err) {
      throw toPersistenceError(err)
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

      return result.rowCount ?? NO_ROW_AFFECTED
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}
