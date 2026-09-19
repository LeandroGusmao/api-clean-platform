import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'

const ONE_INCREMENT = 1

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * the claim (`claimNext`), not row locks: the tests are sequential, and a run
 * that overlaps another is simulated by interleaving `await`s.
 */
export class InMemoryOutboxMessagesRepository implements IOutboxMessagesRepository {
  readonly messages: OutboxMessage[] = []
  /** Beside the messages, because the entity does not carry its claim. */
  readonly #claimedUntil = new Map<string, Date>()

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message)
  }

  async claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null> {
    const [next] = this.messages
      .filter((message) => this.#isClaimable(message, now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    if (next === undefined) return null

    this.#claimedUntil.set(next.id, leaseUntil)
    return next
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

  #isClaimable(message: OutboxMessage, now: Date): boolean {
    if (message.dispatchedAt !== null || message.failedAt !== null) return false
    const claimedUntil = this.#claimedUntil.get(message.id)
    return claimedUntil === undefined || claimedUntil <= now
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
