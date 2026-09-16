import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import {
  DISPATCH_OUTBOX_MESSAGES_JOB,
  DispatchOutboxMessagesUseCase,
} from '#modules/auth/use-cases/dispatch-outbox-messages'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const MAX_ATTEMPTS = 3
const BATCH_SIZE = 10
const SMALL_BATCH_SIZE = 2
const NONE = 0
const ONE = 1
const TWO = 2
const THREE = 3

const message = (to: string): EmailMessage => ({ to, subject: 'subject', text: 'text' })

let repository: InMemoryOutboxMessagesRepository
let sentTo: string[]
let failing: Set<string>
let emailSender: IEmailSender
let useCase: DispatchOutboxMessagesUseCase

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
  sentTo = []
  failing = new Set()

  emailSender = {
    send: async (m) => {
      if (failing.has(m.to)) throw new Error(`smtp refused ${m.to}`)
      sentTo.push(m.to)
    },
  }

  useCase = new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    { now: () => NOW },
    MAX_ATTEMPTS,
    BATCH_SIZE,
  )
})

const seed = async (...recipients: string[]) => {
  for (const to of recipients) {
    await repository.save(
      OutboxMessage.create({ id: to, message: message(to), now: NOW }),
    )
  }
}

describe('DispatchOutboxMessagesUseCase', () => {
  it('names its job', () => {
    expect(DISPATCH_OUTBOX_MESSAGES_JOB).toBe('dispatch-outbox-messages')
  })

  it('reports zero/zero on an empty batch, without calling the sender', async () => {
    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: NONE })
  })

  it('marks a successfully sent message dispatched', async () => {
    await seed('ok@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: ONE, failed: NONE })
    expect(sentTo).toEqual(['ok@example.com'])
    expect(await repository.findPendingBatch(BATCH_SIZE)).toHaveLength(NONE)
  })

  it('records a failure without marking the row failed, below the cap', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: ONE })
    const [pending] = await repository.findPendingBatch(BATCH_SIZE)
    expect(pending?.attempts).toBe(ONE)
    expect(pending?.failedAt).toBeNull()
  })

  /**
   * The falsification that matters most here: one bad row in the middle of a
   * batch must not stop the rows around it from being sent. A `toContain`
   * assertion instead of this one would stay green even if a thrown `send`
   * aborted the whole loop.
   */
  it('isolates a failure: the rest of the batch still gets processed', async () => {
    failing.add('bad@example.com')
    await seed('first@example.com', 'bad@example.com', 'last@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: TWO, failed: ONE })
    expect(sentTo.sort()).toEqual(['first@example.com', 'last@example.com'])
  })

  it('respects the batch size', async () => {
    await seed('a@example.com', 'b@example.com', 'c@example.com')
    const smallBatchUseCase = new DispatchOutboxMessagesUseCase(
      repository,
      emailSender,
      { now: () => NOW },
      MAX_ATTEMPTS,
      SMALL_BATCH_SIZE,
    )

    const result = await smallBatchUseCase.execute()

    expect(result).toEqual({ dispatched: SMALL_BATCH_SIZE, failed: NONE })
    expect(await repository.findPendingBatch(THREE)).toHaveLength(ONE)
  })

  /**
   * If send succeeds but markDispatched throws (e.g. transient DB error), the
   * error should propagate, not be silently caught and mislabeled as a send
   * failure. This proves the fix: only send is inside try/catch.
   */
  it('propagates markDispatched errors instead of mislabeling them as send failures', async () => {
    await seed('ok@example.com')

    const failingRepository = Object.create(repository)
    failingRepository.markDispatched = async () => {
      throw new Error('db connection lost')
    }

    const useCaseWithFailingRepository = new DispatchOutboxMessagesUseCase(
      failingRepository,
      emailSender,
      { now: () => NOW },
      MAX_ATTEMPTS,
      BATCH_SIZE,
    )

    await expect(useCaseWithFailingRepository.execute()).rejects.toThrow(
      'db connection lost',
    )
  })
})
