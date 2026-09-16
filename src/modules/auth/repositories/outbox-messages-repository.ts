import type { OutboxMessage } from '#modules/auth/entities/outbox-message'

export interface IOutboxMessagesRepository {
  /** Plain insert, called INSIDE the `uow` of the producing use case. */
  save(message: OutboxMessage): Promise<void>

  /**
   * `WHERE dispatched_at IS NULL AND failed_at IS NULL ORDER BY created_at
   * LIMIT ?`. FIFO: the order a notice was promised is the order it goes out.
   */
  findPendingBatch(limit: number): Promise<OutboxMessage[]>

  /** `UPDATE ... SET dispatched_at = ? WHERE id = ?`. */
  markDispatched(id: string, at: Date): Promise<void>

  /**
   * A single conditional `UPDATE`: `attempts = attempts + 1`, `failed_at`
   * set via a SQL `CASE` once the cap is reached — computed entirely in SQL
   * so the method is correct regardless of concurrent callers.
   */
  recordFailure(id: string, at: Date, error: string, maxAttempts: number): Promise<void>

  /**
   * Poda: deletes rows that are dispatched OR failed, whichever happened at or
   * before `cutoff`. Never touches a still-pending row. Mirrors
   * `deleteExpiredBefore` on the sibling repositories.
   */
  deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number>
}
