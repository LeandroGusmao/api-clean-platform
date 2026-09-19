import type { OutboxMessage } from '#modules/auth/entities/outbox-message'

export interface IOutboxMessagesRepository {
  /** Plain insert, called INSIDE the `uow` of the producing use case. */
  save(message: OutboxMessage): Promise<void>

  /**
   * Picks the oldest message that is pending and not currently claimed, sets its
   * claim to expire at `leaseUntil`, and returns it — or null when there is
   * none. A claim whose `claimed_until <= now` no longer counts. One statement,
   * so two concurrent callers never receive the same message (decision 40).
   * FIFO: the order a notice was promised is the order it goes out.
   */
  claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null>

  /** `UPDATE ... SET dispatched_at = ? WHERE id = ?`. */
  markDispatched(id: string, at: Date): Promise<void>

  /**
   * A single conditional `UPDATE`: `attempts = attempts + 1`, `failed_at`
   * set via a SQL `CASE` once the cap is reached — computed entirely in SQL
   * so the method is correct regardless of concurrent callers.
   */
  recordFailure(id: string, at: Date, error: string, maxAttempts: number): Promise<void>

  /**
   * Prune: deletes rows that are dispatched OR failed, whichever happened at or
   * before `cutoff`. Never touches a still-pending row. Mirrors
   * `deleteExpiredBefore` on the sibling repositories.
   */
  deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number>
}
