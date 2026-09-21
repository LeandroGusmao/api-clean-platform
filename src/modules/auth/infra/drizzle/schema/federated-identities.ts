import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One link between a local user and an identity a provider vouches for. This
 * module owns the table, and the foreign key to `users` is legal because both
 * live inside `auth`. Cascade on delete: the link is meaningless
 * without its user.
 *
 * NO column defaults, like `refresh-tokens.ts`: `created_at` comes from `IClock`
 * so that any later instant comparison has both sides from one source. `users`
 * can afford defaults as defence in depth for direct writes; a link row has no
 * legitimate direct write to defend.
 *
 * Names spelled inline: each appears exactly once, and the repository does NOT
 * match a `23505` against any of them — a duplicate link is rare, and re-running
 * the sign-in resolves it through the fast path (design §4.4).
 */
export const federatedIdentities = pgTable(
  'federated_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `'google'` today; a closed set carried as text (design §2). */
    provider: text('provider').notNull(),
    /** The provider's stable subject id — Google's `sub`. Never reassigned. */
    providerUserId: text('provider_user_id').notNull(),
    /** Audit: the address the provider asserted when the link was made. */
    emailAtLink: text('email_at_link').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The fast-path lookup, and the guarantee that one provider identity maps
    // to exactly one user.
    uniqueIndex('federated_identities_provider_subject_unique').on(
      table.provider,
      table.providerUserId,
    ),
    // One identity per provider per user.
    uniqueIndex('federated_identities_user_provider_unique').on(
      table.userId,
      table.provider,
    ),
    index('federated_identities_user_id_idx').on(table.userId),
  ],
)
