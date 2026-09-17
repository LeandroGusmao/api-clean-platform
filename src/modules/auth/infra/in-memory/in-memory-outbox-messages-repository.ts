import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'

const ONE_INCREMENT = 1

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * no row lock: only the dispatch job ever writes to a given row, one at a time.
 */
export class InMemoryOutboxMessagesRepository implements IOutboxMessagesRepository {
  readonly messages: OutboxMessage[] = []

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message)
  }

  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    return [...this.messages]
      .filter((message) => message.dispatchedAt === null && message.failedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
  }

  async markDispatched(id: string, at: Date): Promise<void> {
    this.#replace(id, (message) =>
      OutboxMessage.fromTrusted({ ...toTrusted(message), dispatchedAt: at }),
    )
  }

  async recordFailure(
    id: string,
    at: Date,
    error: string,
    maxAttempts: number,
  ): Promise<void> {
    this.#replace(id, (message) => {
      const attempts = message.attempts + ONE_INCREMENT
      return OutboxMessage.fromTrusted({
        ...toTrusted(message),
        attempts,
        lastError: error,
        failedAt: attempts >= maxAttempts ? at : null,
      })
    })
  }

  async deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number> {
    const survivors = this.messages.filter((message) => {
      const settledAt = message.dispatchedAt ?? message.failedAt
      return settledAt === null || settledAt > cutoff
    })
    const deleted = this.messages.length - survivors.length
    this.messages.length = 0
    this.messages.push(...survivors)
    return deleted
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replace(id: string, rebuild: (message: OutboxMessage) => OutboxMessage): void {
    const index = this.messages.findIndex((message) => message.id === id)
    if (index === -1) return
    const current = this.messages[index]
    if (current === undefined) return
    this.messages[index] = rebuild(current)
  }
}

function toTrusted(message: OutboxMessage) {
  return {
    id: message.id,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attempts: message.attempts,
    lastError: message.lastError,
    dispatchedAt: message.dispatchedAt,
    failedAt: message.failedAt,
    createdAt: message.createdAt,
  }
}
