/**
 * The closed set of things the trail records. A TypeScript union over a `text`
 * column, not a Postgres enum: an enum would need a migration per new event, and
 * the type is where the check lives.
 */
export const AuditEventType = {
  PasswordChanged: 'PASSWORD_CHANGED',
  PasswordResetCompleted: 'PASSWORD_RESET_COMPLETED',
  GoogleAccountLinked: 'GOOGLE_ACCOUNT_LINKED',
  RefreshTokenReuseDetected: 'REFRESH_TOKEN_REUSE_DETECTED',
  AccountDeleted: 'ACCOUNT_DELETED',
} as const

export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType]

/** Where the event came from. Both nullable: an address can fail to parse. */
export interface AuditEventDevice {
  ip: string | null
  label: string | null
}

export interface CreateAuditEventProps {
  id: string
  type: AuditEventType
  /** No foreign key behind it: the event outlives the account it describes. */
  userId: string
  device: AuditEventDevice
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/**
 * One fact about an account, recorded in the same transaction as the change it
 * describes. State lives in `#` private fields, non-enumerable at runtime, so a
 * stray `log.info({ event })` cannot dump the address or the device.
 *
 * Only `create`: nothing reads a row back (the port has no read), so there is no
 * `fromTrusted` to keep in step with it.
 */
export class AuditEvent {
  readonly #id: string
  readonly #type: AuditEventType
  readonly #userId: string
  readonly #ip: string | null
  readonly #deviceLabel: string | null
  readonly #occurredAt: Date

  private constructor(props: CreateAuditEventProps) {
    this.#id = props.id
    this.#type = props.type
    this.#userId = props.userId
    this.#ip = props.device.ip
    this.#deviceLabel = props.device.label
    // `Object.freeze` is shallow: copying the date in and out is what makes the
    // immutability this class claims hold.
    this.#occurredAt = new Date(props.now.getTime())
    Object.freeze(this)
  }

  static create(props: CreateAuditEventProps): AuditEvent {
    return new AuditEvent(props)
  }

  get id(): string {
    return this.#id
  }

  get type(): AuditEventType {
    return this.#type
  }

  get userId(): string {
    return this.#userId
  }

  get ip(): string | null {
    return this.#ip
  }

  get deviceLabel(): string | null {
    return this.#deviceLabel
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime())
  }
}
