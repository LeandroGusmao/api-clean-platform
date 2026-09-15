import type { SeedModule } from '#infra/database/seeds/seed-module'
import { Argon2HashProvider } from '#modules/auth/infra/providers/argon2-hash-provider'
import { Password } from '#modules/auth/value-objects/password'
import { baseUsers } from './base-users.js'
import { type AuthSeedPreparation, wipeAuthSeedNamespace } from './factories.js'
import { pendingRegistration } from './pending-registration.js'

/** The module prefix on the command line: `auth:base-users`. */
const AUTH_SEED_MODULE = 'auth'

/**
 * Shared by every seed account that has a password. Development-only and
 * documented in the module README — never logged. Satisfies the `Password`
 * policy, so it also works as the password of a confirm or a reset.
 */
export const SEED_PASSWORD = 'seed-Dev-2026!'

export const authSeedModule: SeedModule<AuthSeedPreparation> = {
  name: AUTH_SEED_MODULE,
  scenarios: [baseUsers, pendingRegistration],
  /**
   * One argon2 for the whole run: every seed account shares the password.
   * Through `Password.create` so a constant that drifts below the policy fails
   * here, not at a confirm.
   */
  async prepare() {
    const password = Password.create(SEED_PASSWORD)
    return { passwordHash: await new Argon2HashProvider().hash(password.value) }
  },
  async wipe(tx) {
    await wipeAuthSeedNamespace(tx)
  },
}
