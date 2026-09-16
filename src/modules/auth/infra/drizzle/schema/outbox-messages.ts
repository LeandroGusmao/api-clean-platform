import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Notices promised inside a transaction and sent later by the dispatch job.
 * One row per notice, in FIFO order by `created_at`. Three states tracked by
 * nullable timestamps: pending (neither set), dispatched (dispatchedAt set),
 * or failed permanently (failedAt set after maxAttempts reached).
 *
 * NO column defaults, like `refresh-tokens.ts`: `created_at` comes from `IClock`
 * so that any later instant comparison has both sides from one source.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('outbox_messages_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} is null and ${table.failedAt} is null`),
  ],
)
