import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

/**
 * Refuse anything below this whenever TLS is negotiated, implicitly or through
 * STARTTLS. Harmless on the plaintext development path, where none is.
 */
const MINIMUM_TLS_VERSION = 'TLSv1.2'

/**
 * Pooling is on (`pool: true`) rather than left at nodemailer's default
 * (a fresh connection per send): this adapter serves request paths —
 * `register`, `resend`, `changePassword` — and a transactional mailer on a
 * request path is exactly the case connection pooling exists for. Without it,
 * every send pays a fresh TCP handshake, and for anything but Mailpit's
 * plaintext localhost link, a fresh STARTTLS negotiation and AUTH round trip
 * on top — latency a concurrent request has to wait through for no reason
 * other than a socket that could have been kept open.
 *
 * `maxConnections` and `maxMessages` are left at nodemailer's own defaults (5
 * and 100): this process sends a handful of verification and notification
 * emails per request, never a bulk campaign, so five simultaneous connections
 * to the relay is already generous headroom rather than a bottleneck. Revisit
 * only if production traffic actually saturates it — there is no evidence to
 * pre-tune against yet.
 */
const POOL_ENABLED = true

export interface SmtpEmailSenderConfig {
  host: string
  port: number
  /** Implicit TLS from connect (SMTPS, port 465). */
  secure: boolean
  /**
   * Force STARTTLS, so the connection **fails closed** when the server cannot
   * upgrade instead of silently sending in the clear. Required in production:
   * without it a man in the middle only has to strip the STARTTLS advertisement
   * to read every verification code. `false` only for Mailpit, which offers no
   * STARTTLS at all. A no-op when `secure` is already true.
   */
  requireTls: boolean
  from: string
  /** Absent for Mailpit, which accepts no auth. */
  user?: string | undefined
  password?: string | undefined
}

/**
 * Pure, and exported for exactly that reason: these are the security-relevant
 * choices of the whole adapter, and this shape is what makes them assertable
 * without a live SMTP server.
 */
export function smtpTransportOptions(config: SmtpEmailSenderConfig): SMTPPool.Options {
  return {
    pool: POOL_ENABLED,
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    tls: { minVersion: MINIMUM_TLS_VERSION },
    auth:
      config.user === undefined
        ? undefined
        : { user: config.user, pass: config.password },
  }
}

/**
 * The SMTP adapter. One class serves development (Mailpit on 1025, no auth) and
 * production (a real provider): only the configuration differs, which is what
 * makes swapping providers an environment change rather than a code change.
 *
 * The transport is built once and reused — with `pool: true` above, this is
 * what actually gets nodemailer to pool connections across repeated sends,
 * rather than merely sharing one configuration object that opens a fresh
 * connection every time regardless.
 */
export class SmtpEmailSender implements IEmailSender {
  readonly #transport: Transporter
  readonly #from: string

  constructor(config: SmtpEmailSenderConfig) {
    this.#from = config.from
    this.#transport = nodemailer.createTransport(smtpTransportOptions(config))
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  }

  /**
   * Drains the pool at shutdown. A connection with a send already in flight is
   * closed only after that send finishes (nodemailer's own guarantee for
   * `SMTPPool#close`); idle ones close immediately. `buildApp` wires this into
   * Fastify's `onClose`, the same hook that ends the database pool — `app.close()`
   * stays the single teardown path, so nothing has to end this by hand.
   */
  close(): void {
    this.#transport.close()
  }
}
