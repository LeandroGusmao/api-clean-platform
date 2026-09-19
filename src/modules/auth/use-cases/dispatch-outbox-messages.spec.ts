import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const LEASE_MS = 120_000
const NONE = 0
const ONE = 1
const TWO = 2

const message = (to: string): EmailMessage => ({ to, subject: 'subject', text: 'text' })

let clockNow: Date
let repository: InMemoryOutboxMessagesRepository
let sendCalls: string[]
let sentTo: string[]
let failing: Set<string>
let emailSender: IEmailSender
let useCase: DispatchOutboxMessagesUseCase

const clock = { now: () => clockNow }
const unsettled = () =>
  repository.messages.filter(
    (stored) => stored.dispatchedAt === null && stored.failedAt === null,
  )

beforeEach(() => {
  clockNow = NOW
  repository = new InMemoryOutboxMessagesRepository()
  sendCalls = []
  sentTo = []
  failing = new Set()

  emailSender = {
    send: async (m) => {
      sendCalls.push(m.to)
      if (failing.has(m.to)) throw new Error(`smtp refused ${m.to}`)
      sentTo.push(m.to)
    },
  }

  useCase = new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    clock,
    MAX_ATTEMPTS,
    BATCH_SIZE,
    LEASE_MS,
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
    expect(sendCalls).toEqual([])
  })

  it('marks a successfully sent message dispatched', async () => {
    await seed('ok@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: ONE, failed: NONE })
    expect(sentTo).toEqual(['ok@example.com'])
    expect(unsettled()).toHaveLength(NONE)
  })

  it('records a failure without marking the row failed, below the cap', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: ONE })
    const [stored] = repository.messages
    expect(stored?.attempts).toBe(ONE)
    expect(stored?.failedAt).toBeNull()
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
      clock,
      MAX_ATTEMPTS,
      SMALL_BATCH_SIZE,
      LEASE_MS,
    )

    const result = await smallBatchUseCase.execute()

    expect(result).toEqual({ dispatched: SMALL_BATCH_SIZE, failed: NONE })
    expect(unsettled()).toHaveLength(ONE)
  })

  it('claims each message for the configured lease', async () => {
    await seed('a@example.com')
    const claim = vi.spyOn(repository, 'claimNext')

    await useCase.execute()

    expect(claim).toHaveBeenCalledWith(NOW, new Date(NOW.getTime() + LEASE_MS))
  })

  // Releasing the claim on a failure would hand the same message straight back
  // to the loop — it is the oldest — and spend every attempt within one run.
  it('keeps the claim on a failed message until it expires', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')
    await useCase.execute()

    expect(await useCase.execute()).toEqual({ dispatched: NONE, failed: NONE })
    expect(sendCalls).toEqual(['bad@example.com'])

    clockNow = new Date(NOW.getTime() + LEASE_MS)

    expect(await useCase.execute()).toEqual({ dispatched: NONE, failed: ONE })
    expect(sendCalls).toEqual(['bad@example.com', 'bad@example.com'])
    expect(repository.messages[0]?.attempts).toBe(TWO)
  })

  // The problem the claim exists to close: the second run starts while the first
  // is in the middle of a send, and must not pick the same message up.
  it('never sends the same message twice when two runs overlap', async () => {
    await seed('a@example.com', 'b@example.com', 'c@example.com')
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    emailSender.send = async (m) => {
      sendCalls.push(m.to)
      if (m.to === 'a@example.com') {
        started.resolve()
        await gate.promise
      }
      sentTo.push(m.to)
    }

    const first = useCase.execute()
    await started.promise
    const second = await useCase.execute()
    gate.resolve()
    const firstResult = await first

    expect(second).toEqual({ dispatched: TWO, failed: NONE })
    expect(firstResult).toEqual({ dispatched: ONE, failed: NONE })
    expect(sendCalls.sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  /**
   * If send succeeds but markDispatched throws (e.g. transient DB error), the
   * error should propagate, not be silently caught and mislabeled as a send
   * failure. This proves the fix: only send is inside try/catch.
   */
  it('propagates markDispatched errors instead of mislabeling them as send failures', async () => {
    await seed('ok@example.com')
    vi.spyOn(repository, 'markDispatched').mockRejectedValue(
      new Error('db connection lost'),
    )

    await expect(useCase.execute()).rejects.toThrow('db connection lost')
  })
})
