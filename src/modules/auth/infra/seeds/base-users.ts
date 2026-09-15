import type { SeedScenario } from '#infra/database/seeds/seed-module'
import {
  type AuthSeedPreparation,
  createGoogleUser,
  createPasswordUser,
  SEED_EMAIL_DOMAIN,
} from './factories.js'

const BASE_USERS_SCENARIO = 'base-users'

export const SEED_DEV_EMAIL = `dev@${SEED_EMAIL_DOMAIN}`
export const SEED_GOOGLE_EMAIL = `google@${SEED_EMAIL_DOMAIN}`
/** Stands in for Google's `sub`. Real subjects are numeric, so this never collides with one. */
export const SEED_GOOGLE_SUBJECT = 'seed-google-subject'

export const baseUsers: SeedScenario<AuthSeedPreparation> = {
  name: BASE_USERS_SCENARIO,
  description: `${SEED_DEV_EMAIL} with the seed password, and ${SEED_GOOGLE_EMAIL} with Google only`,
  byDefault: true,
  async run({ tx, now, preparation, log }) {
    await createPasswordUser(tx, {
      email: SEED_DEV_EMAIL,
      passwordHash: preparation.passwordHash,
      now,
    })
    log(`account ${SEED_DEV_EMAIL}`)

    await createGoogleUser(tx, {
      email: SEED_GOOGLE_EMAIL,
      providerUserId: SEED_GOOGLE_SUBJECT,
      now,
    })
    log(`Google-only account ${SEED_GOOGLE_EMAIL}`)
  },
}
