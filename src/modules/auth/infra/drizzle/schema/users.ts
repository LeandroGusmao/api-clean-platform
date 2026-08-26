import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Credentials of an application user. This module owns the table: a foreign key
 * may point here only from inside `auth`. Other modules reference a user by id,
 * with no database constraint, so that a module stays extractable.
 *
 * Every default below is defense-in-depth for direct writes (seeds, psql). The
 * application is the source of truth: from the next slice on, `IIdGenerator` and
 * `IClock` produce `id`, `created_at` and `updated_at`, and the repository sends
 * them explicitly.
 *
 * The domain normalizes email to lowercase; the functional unique index enforces
 * case-insensitive uniqueness without requiring the `citext` extension.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`)],
)
