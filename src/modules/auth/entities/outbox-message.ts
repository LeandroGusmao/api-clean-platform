import type { EmailMessage } from '#shared/ports/email-sender'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — same reasoning as `PendingRegistration`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const NO_ATTEMPTS_SPENT = 0

export interface CreateOutboxMessageProps {
  id: string
  message: EmailMessage
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedOutboxMessageProps {
  id: string
  to: string
  subject: string
  text: string
  attempts: number
  lastError: string | null
  dispatchedAt: Date | null
  failedAt: Date | null
  createdAt: Date
}

/**
 * One notice promised inside a transaction, to be sent for real later by
 * `DispatchOutboxMessagesUseCase`. Carries no secret — the three e-mails it
 * exists for (`passwordChangedEmail`, `passwordResetCompletedEmail`,
 * `googleAccountLinkedEmail`) are notices, not codes or tokens — but state still
 * lives in `#` private fields, non-enumerable at runtime, so a stray
 * `log.info({ message })` cannot leak a message body into the log stream.
 *
 * State is a nullable timestamp, not a status enum: `dispatchedAt`/`failedAt`
 * are the same idiom as `PendingRegistration.consumedAt` and
 * `RefreshToken.revokedAt`.
 */
export class OutboxMessage {
  readonly #id: string
  readonly #to: string
  readonly #subject: string
  readonly #text: string
  readonly #attempts: number
  readonly #lastError: string | null
  readonly #dispatchedAt: Date | null
  readonly #failedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedOutboxMessageProps) {
    this.#id = props.id
    this.#to = props.to
    this.#subject = props.subject
    this.#text = props.text
    this.#attempts = props.attempts
    this.#lastError = props.lastError
    this.#dispatchedAt = cloneNullableDate(props.dispatchedAt)
    this.#failedAt = cloneNullableDate(props.failedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /** Born with no attempts spent, neither dispatched nor failed. */
  static create(props: CreateOutboxMessageProps): OutboxMessage {
    return new OutboxMessage({
      id: props.id,
      to: props.message.to,
      subject: props.message.subject,
      text: props.message.text,
      attempts: NO_ATTEMPTS_SPENT,
      lastError: null,
      dispatchedAt: null,
      failedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedOutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props)
  }

  /** Reconstitutes the `IEmailSender.send` payload. The entity does not know the port. */
  toEmailMessage(): EmailMessage {
    return { to: this.#to, subject: this.#subject, text: this.#text }
  }

  get id(): string {
    return this.#id
  }

  get to(): string {
    return this.#to
  }

  get subject(): string {
    return this.#subject
  }

  get text(): string {
    return this.#text
  }

  get attempts(): number {
    return this.#attempts
  }

  get lastError(): string | null {
    return this.#lastError
  }

  get dispatchedAt(): Date | null {
    return cloneNullableDate(this.#dispatchedAt)
  }

  get failedAt(): Date | null {
    return cloneNullableDate(this.#failedAt)
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}
