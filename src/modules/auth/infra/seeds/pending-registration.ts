import type { SeedScenario } from '#infra/database/seeds/seed-module'
import {
  type AuthSeedPreparation,
  createPendingRegistration,
  SEED_EMAIL_DOMAIN,
} from './factories.js'

const PENDING_REGISTRATION_SCENARIO = 'pending-registration'

const SECONDS_PER_DAY = 86_400
const SEED_PENDING_REGISTRATION_TTL_DAYS = 7
/** Days, not the module's minutes: a code seeded in the morning must still confirm in the afternoon. */
const SEED_PENDING_REGISTRATION_TTL_SECONDS =
  SEED_PENDING_REGISTRATION_TTL_DAYS * SECONDS_PER_DAY

export const SEED_PENDING_EMAIL = `pending@${SEED_EMAIL_DOMAIN}`
/** Six digits, the shape `POST /auth/email/verify` accepts. */
export const SEED_VERIFICATION_CODE = '123456'

export const pendingRegistration: SeedScenario<AuthSeedPreparation> = {
  name: PENDING_REGISTRATION_SCENARIO,
  description: `${SEED_PENDING_EMAIL} awaiting confirmation with code ${SEED_VERIFICATION_CODE}`,
  async run({ tx, now, log }) {
    await createPendingRegistration(tx, {
      email: SEED_PENDING_EMAIL,
      code: SEED_VERIFICATION_CODE,
      ttlSeconds: SEED_PENDING_REGISTRATION_TTL_SECONDS,
      now,
    })
    log(`pending registration ${SEED_PENDING_EMAIL}`)
  },
}
