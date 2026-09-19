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
 * Sends pending outbox rows for real, one at a time, outside any transaction: a
 * failure on one row must not block or roll back the others (same isolation
 * `runJobs` gives two different `CronJob`s).
 *
 * Each row is claimed before it is sent (decision 40), so two runs that overlap
 * work on different rows instead of sending the same one twice. The claim lasts
 * `leaseMs`: a run that dies mid-send leaves a claim that simply expires.
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
    private readonly leaseMs: number,
  ) {}

  async execute(): Promise<DispatchResult> {
    let dispatched = 0
    let failed = 0

    for (let handled = 0; handled < this.batchSize; handled++) {
      const now = this.clock.now()
      const message = await this.outboxMessages.claimNext(
        now,
        new Date(now.getTime() + this.leaseMs),
      )
      if (message === null) break

      let sent = false
      let sendError: unknown

      try {
        await this.emailSender.send(message.toEmailMessage())
        sent = true
      } catch (error) {
        sendError = error
      }

      if (sent) {
        await this.outboxMessages.markDispatched(message.id, now)
        dispatched++
      } else {
        // The claim stays: the message is offered again only once it expires,
        // which is also the wait between attempts. Releasing it would hand the
        // same message straight back to this loop.
        await this.outboxMessages.recordFailure(
          message.id,
          now,
          sendError instanceof Error ? sendError.message : String(sendError),
          this.maxAttempts,
        )
        failed++
      }
    }

    return { dispatched, failed }
  }
}
