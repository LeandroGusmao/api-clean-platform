/**
 * Talks to Mailpit's HTTP API — the other half of the `mailpit` service in
 * `docker-compose.yml`, which already commits port 8025 for the API/UI and
 * 1025 for SMTP. `src/infra/config/env.ts` points the application's mailer at
 * the SMTP port by default (`DEFAULT_MAIL_HOST` / `DEFAULT_MAIL_PORT`), and
 * this file is this suite's read side of the same fixture.
 *
 * **Hardcoded on purpose — do not move this to `.env` or `process.env`.** The
 * same four reasons `test-database-url.ts` gives for `TEST_DATABASE_URL` apply
 * here: this is a test fixture, not configuration; only
 * `src/infra/config/env.ts` reads `process.env` (R6); and a fresh clone has no
 * `.env`, so hardcoding is what keeps `pnpm install && pnpm test:integration`
 * working with no setup step.
 */
const MAILPIT_BASE_URL = 'http://127.0.0.1:8025'
const MESSAGES_ENDPOINT = `${MAILPIT_BASE_URL}/api/v1/messages`
const LATEST_MESSAGE_ENDPOINT = `${MAILPIT_BASE_URL}/api/v1/message/latest`
const SEARCH_ENDPOINT = `${MAILPIT_BASE_URL}/api/v1/search`
const SEARCH_QUERY_PARAM = 'query'
const RECIPIENT_SEARCH_PREFIX = 'to:'

const DELETE_METHOD = 'DELETE'

const VERIFICATION_CODE_PATTERN = /\b(\d{6})\b/
const NO_VERIFICATION_CODE_MESSAGE =
  'no six-digit verification code found in the message text — a helper that ' +
  'returned null here would let a test pass while proving nothing'

// The literal prefix mirrors `passwordResetEmail`'s wording
// (`Use this token to reset your password: <token>`): a reword there must be
// mirrored here or this stops matching.
const RESET_TOKEN_PATTERN = /reset your password: ([A-Za-z0-9_-]{32,})/
const NO_RESET_TOKEN_MESSAGE =
  'no reset token found in the message text — a helper that returned null ' +
  'here would let a test pass while proving nothing'

/**
 * How long to keep polling before giving up, and how often to check in the
 * meantime.
 *
 * SMTP delivery is asynchronous in two separate ways: `IEmailSender.send`
 * resolves as soon as the SMTP server has ACCEPTED the message (the nodemailer
 * call the application makes), and Mailpit only indexes it into its own store
 * a moment after that — so the message the application "sent" is not
 * necessarily visible through this HTTP API the instant `app.inject` resolves.
 * A test that read `messageCount()` immediately would be racing Mailpit's own
 * indexing, and a fixed `sleep` long enough to never lose that race would be
 * either flaky (too short, on a loaded machine) or needlessly slow every run
 * (long enough to always be safe). Polling for the condition itself, bounded
 * by a timeout, is fast on the common path and still deterministic on a slow
 * one.
 */
const POLL_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

export interface MailpitMessage {
  subject: string
  text: string
  to: string
}

interface MailpitMessageSummary {
  Subject: string
  To: Array<{ Address: string }>
}

interface MailpitMessagesResponse {
  total: number
  messages: MailpitMessageSummary[]
}

interface MailpitSearchResponse {
  messages_count: number
}

interface MailpitFullMessage {
  Subject: string
  Text: string
  To: Array<{ Address: string }>
}

/** Wipes every message. Meant for `beforeEach`, so each test starts from zero. */
export async function clearMailpit(): Promise<void> {
  await fetch(MESSAGES_ENDPOINT, { method: DELETE_METHOD })
}

/** How many messages Mailpit currently holds. */
export async function messageCount(): Promise<number> {
  const response = await fetch(MESSAGES_ENDPOINT)
  const body = (await response.json()) as MailpitMessagesResponse
  return body.total
}

/** How many messages Mailpit holds for one recipient address. */
export async function messageCountTo(address: string): Promise<number> {
  const url = new URL(SEARCH_ENDPOINT)
  url.searchParams.set(SEARCH_QUERY_PARAM, `${RECIPIENT_SEARCH_PREFIX}"${address}"`)
  const response = await fetch(url)
  const body = (await response.json()) as MailpitSearchResponse
  return body.messages_count
}

/** The most recently received message, in full — including its plaintext body. */
export async function latestMessage(): Promise<MailpitMessage> {
  const response = await fetch(LATEST_MESSAGE_ENDPOINT)
  const body = (await response.json()) as MailpitFullMessage
  return {
    subject: body.Subject,
    text: body.Text,
    to: body.To[0]?.Address ?? '',
  }
}

/**
 * Extracts the six-digit verification code from a message's plaintext body.
 *
 * **Throws when no code is found**, deliberately: a variant that returned
 * `null` on failure would let a test that never actually received a code
 * still read as green, proving nothing about the flow it claims to cover.
 */
export function extractVerificationCode(text: string): string {
  const match = text.match(VERIFICATION_CODE_PATTERN)
  if (match?.[1] === undefined) throw new Error(NO_VERIFICATION_CODE_MESSAGE)
  return match[1]
}

/**
 * Extracts the opaque reset token from a message's plaintext body.
 *
 * **Throws when no token is found**, like `extractVerificationCode`: a variant
 * that returned `null` on failure would let a test that never actually
 * received a token still read as green, proving nothing about the flow.
 */
export function extractResetToken(text: string): string {
  const match = text.match(RESET_TOKEN_PATTERN)
  if (match?.[1] === undefined) throw new Error(NO_RESET_TOKEN_MESSAGE)
  return match[1]
}

/**
 * Polls `messageCount()` until it reaches `expectedCount`, or throws once
 * `POLL_TIMEOUT_MS` has passed. See the comment on `POLL_TIMEOUT_MS` for why
 * this exists instead of a fixed `sleep`.
 */
export async function waitForMessageCount(expectedCount: number): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  for (;;) {
    const count = await messageCount()
    if (count === expectedCount) return

    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for Mailpit to hold ${expectedCount} message(s); ` +
          `it holds ${count} after ${POLL_TIMEOUT_MS}ms`,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * Polls until at least one message addressed to `address` is in Mailpit, or
 * throws once `POLL_TIMEOUT_MS` has passed. For a sentinel sent after the
 * messages under test: once it is visible, the earlier ones are too, and their
 * exact count can be asserted rather than waited for.
 */
export async function waitForMessageTo(address: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while ((await messageCountTo(address)) === 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for a message to ${address} after ${POLL_TIMEOUT_MS}ms`,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
