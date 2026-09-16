import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'

/** The job id the scheduler and the run log key on. */
export const DISPATCH_OUTBOX_MESSAGES_JOB = 'dispatch-outbox-messages'

export interface DispatchResult {
  dispatched: number
  failed: number
}

/**
 * Sends every pending outbox row for real, one at a time, outside any
 * transaction: a failure on one row must not block or roll back the others
 * (same isolation `runJobs` gives two different `CronJob`s).
 *
 * Takes the RAW `IEmailSender`, never a best-effort wrapper — the `catch`
 * below IS the retry policy: deciding whether to try again, not swallowing
 * and forgetting.
 */
export class DispatchOutboxMessagesUseCase {
  constructor(
    private readonly outboxMessages: IOutboxMessagesRepository,
    private readonly emailSender: IEmailSender,
    private readonly clock: IClock,
    private readonly maxAttempts: number,
    private readonly batchSize: number,
  ) {}

  async execute(): Promise<DispatchResult> {
    const pending = await this.outboxMessages.findPendingBatch(this.batchSize)
    let dispatched = 0
    let failed = 0

    for (const message of pending) {
      const now = this.clock.now()
      try {
        await this.emailSender.send(message.toEmailMessage())
        await this.outboxMessages.markDispatched(message.id, now)
        dispatched++
      } catch (error) {
        await this.outboxMessages.recordFailure(
          message.id,
          now,
          error instanceof Error ? error.message : String(error),
          this.maxAttempts,
        )
        failed++
      }
    }

    return { dispatched, failed }
  }
}
