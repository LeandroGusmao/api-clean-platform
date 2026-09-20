import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * One row per security event, kept for the retention window and then pruned.
 *
 * `user_id` deliberately has NO `references`: the trail has to outlive the
 * account it describes, and a foreign key would either block the delete or
 * cascade the evidence away with it.
 *
 * NO column defaults, like `outbox-messages.ts`: `occurred_at` comes from
 * `IClock` so any later instant comparison has both sides from one source.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    userId: uuid('user_id').notNull(),
    ip: text('ip'),
    deviceLabel: text('device_label'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // "What happened to this account", newest first.
    index('audit_events_user_id_occurred_at_idx').on(table.userId, table.occurredAt),
    // The prune job's `occurred_at <= cutoff`.
    index('audit_events_occurred_at_idx').on(table.occurredAt),
  ],
)
