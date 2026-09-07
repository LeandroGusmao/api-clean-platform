import type { Database } from '#infra/database/client'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Argon2HashProvider } from '#modules/auth/infra/providers/argon2-hash-provider'

/**
 * Inserts a `users` row directly, with a real argon2 hash of `password`.
 *
 * Since slice 11 `POST /auth/register` writes a `pending_registrations` row, not
 * a `users` row — so every suite that only needs an account to already exist
 * (login, refresh, logout, me, change-password) arranges it here instead of
 * driving the register/confirm flow. The real, SMTP-delivered flow is
 * `verify-email.spec.ts`'s job.
 *
 * `verified` defaults to true because that is what every caller but the login
 * gate test wants; the row's `id`, `created_at` and `updated_at` come from the
 * schema defaults.
 */
const hashProvider = new Argon2HashProvider()

export async function arrangeAccount(
  db: Database,
  params: { email: string; password: string; verified?: boolean },
): Promise<void> {
  const verified = params.verified ?? true

  await db.insert(users).values({
    email: params.email,
    passwordHash: await hashProvider.hash(params.password),
    emailVerifiedAt: verified ? new Date() : null,
  })
}
