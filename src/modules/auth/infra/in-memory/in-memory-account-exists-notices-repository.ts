import type {
  ClaimAccountExistsNoticeParams,
  IAccountExistsNoticesRepository,
} from '#modules/auth/repositories/account-exists-notices-repository'

/**
 * In-memory adapter, for the unit tests of the use cases. Models NO row lock: a
 * unit test runs one call at a time. Atomicity under concurrency is proved
 * against real Postgres in
 * `tests/integration/drizzle-account-exists-notices-repository.spec.ts`.
 */
export class InMemoryAccountExistsNoticesRepository
  implements IAccountExistsNoticesRepository
{
  /** When each account (by user id) was last sent the notice. */
  readonly sentAt = new Map<string, Date>()

  async claim(params: ClaimAccountExistsNoticeParams): Promise<boolean> {
    const previous = this.sentAt.get(params.userId)
    // Mirrors the adapter's `WHERE sent_at <= cooldownCutoff`.
    if (previous !== undefined && previous.getTime() > params.cooldownCutoff.getTime()) {
      return false
    }

    this.sentAt.set(params.userId, params.sentAt)
    return true
  }
}
