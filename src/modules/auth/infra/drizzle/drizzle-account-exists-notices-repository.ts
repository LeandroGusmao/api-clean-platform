import { lte } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type {
  ClaimAccountExistsNoticeParams,
  IAccountExistsNoticesRepository,
} from '#modules/auth/repositories/account-exists-notices-repository'
import { accountExistsNotices } from './schema/account-exists-notices.js'

/** How many rows a conditional write affected when nothing matched its `WHERE`. */
const NO_ROW_AFFECTED = 0

export class DrizzleAccountExistsNoticesRepository
  implements IAccountExistsNoticesRepository
{
  constructor(private readonly db: Database) {}

  async claim(params: ClaimAccountExistsNoticeParams): Promise<boolean> {
    try {
      const result = await this.db
        .insert(accountExistsNotices)
        .values({ userId: params.userId, sentAt: params.sentAt })
        .onConflictDoUpdate({
          target: accountExistsNotices.userId,
          set: { sentAt: params.sentAt },
          // `setWhere`, not `targetWhere`: this must land on the `DO UPDATE`, so
          // a conflict inside the cooldown matches no row and writes nothing.
          setWhere: lte(accountExistsNotices.sentAt, params.cooldownCutoff),
        })

      // `null` counts as "matched nothing": suppression fails closed, so a
      // driver surfacing `null` sends nothing rather than one notice per call.
      return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message.
      throw toPersistenceError(error)
    }
  }
}
