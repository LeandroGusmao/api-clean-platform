import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import { BestEffortEmailSender, type ErrorLogger } from './best-effort-email-sender.js'

const RECIPIENT = 'owner@example.com'
const SUBJECT = 'Your password was changed'
/** Stands in for a body that names a secret — the assertion below proves it never reaches the log. */
const BODY_WITH_CODE = 'Your verification code is 123456.'

const MESSAGE: EmailMessage = {
  to: RECIPIENT,
  subject: SUBJECT,
  text: BODY_WITH_CODE,
}

const DELIVERY_FAILURE_MESSAGE = 'delivery failed — connection refused'

interface LoggedError {
  details: Record<string, unknown>
  message: string
}

let logged: LoggedError[]
let sent: EmailMessage[]

const logger: ErrorLogger = {
  error: (details, message) => {
    logged.push({ details, message })
  },
}

function rejectingSender(): IEmailSender {
  return {
    send: async () => {
      throw new Error(DELIVERY_FAILURE_MESSAGE)
    },
  }
}

function succeedingSender(): IEmailSender {
  return {
    send: async (message) => {
      sent.push(message)
    },
  }
}

beforeEach(() => {
  logged = []
  sent = []
})

describe('BestEffortEmailSender', () => {
  it('resolves even when the wrapped sender rejects', async () => {
    const bestEffort = new BestEffortEmailSender(rejectingSender(), logger)

    await expect(bestEffort.send(MESSAGE)).resolves.toBeUndefined()
  })

  it('logs the failure, so a silent outage is still visible', async () => {
    const bestEffort = new BestEffortEmailSender(rejectingSender(), logger)

    await bestEffort.send(MESSAGE)

    expect(logged).toHaveLength(1)
  })

  it('does not log the message body, which may name the recipient', async () => {
    const bestEffort = new BestEffortEmailSender(rejectingSender(), logger)

    await bestEffort.send(MESSAGE)

    // Serializes the whole call log, not just one field: this catches the body
    // leaking through `error`, `message`, or any future field alike.
    expect(JSON.stringify(logged)).not.toContain(MESSAGE.text)
  })

  it('passes a successful send straight through', async () => {
    const bestEffort = new BestEffortEmailSender(succeedingSender(), logger)

    await bestEffort.send(MESSAGE)

    expect(sent).toEqual([MESSAGE])
    expect(logged).toHaveLength(0)
  })
})
