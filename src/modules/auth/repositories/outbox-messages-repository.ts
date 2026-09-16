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
   * Increments `attempts`, records `lastError`, and sets `failedAt` once
   * `attempts` reaches `maxAttempts` — never before. No corresponding
   * `Promise<boolean>`: unlike `registerFailedAttempt`, only the dispatch job
   * ever writes to one row, one at a time, so there is no race to serialize
   * against.
   */
  recordFailure(id: string, at: Date, error: string, maxAttempts: number): Promise<void>

  /**
   * Poda: deletes rows that are dispatched OR failed, whichever happened at or
   * before `cutoff`. Never touches a still-pending row. Mirrors
   * `deleteExpiredBefore` on the sibling repositories.
   */
  deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number>
}
