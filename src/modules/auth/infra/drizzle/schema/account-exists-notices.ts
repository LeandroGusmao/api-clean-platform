import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * When an account last received the "someone tried to register with your
 * address" notice. `register` is anonymous, so without this row anyone who knows
 * an address could put that notice in its inbox as often as the rate limiter
 * lets one IP ask — and as often as a botnet has IPs.
 *
 * The primary key on `user_id` is the arbiter of the `INSERT ... ON CONFLICT
 * (user_id)` the use case runs: two replicas registering the same address at
 * once serialize on it, and only one of them sends.
 *
 * NO column default, like `password-reset-tokens.ts`: `sent_at` comes from
 * `IClock`, the same source the cooldown cutoff it is compared with comes from.
 *
 * Cascades with the account: a notice has nothing to say about an address whose
 * account is gone, and the table stays bounded by `users`.
 */
export const accountExistsNotices = pgTable('account_exists_notices', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
})
