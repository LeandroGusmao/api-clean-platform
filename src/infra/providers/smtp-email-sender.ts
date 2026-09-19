import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

/**
 * Refuse anything below this whenever TLS is negotiated, implicitly or through
 * STARTTLS. Harmless on the plaintext development path, where none is.
 */
const MINIMUM_TLS_VERSION = 'TLSv1.2'

/**
 * Pooled: this adapter sends from request paths, and without it every send pays
 * a fresh TCP handshake plus STARTTLS and AUTH. `maxConnections` and
 * `maxMessages` stay at nodemailer's defaults — this process sends a handful of
 * messages per request, never a campaign.
 */
const POOL_ENABLED = true

/**
 * Bounds on a single send, so a stalled connection cannot hold a dispatch run
 * past the claim it holds (decision 40). nodemailer's own defaults are 2
 * minutes to connect, 30 seconds for the greeting and 10 minutes of socket
 * inactivity. These cut a stalled connection; a server that answers every
 * command slowly is not cut, because the socket timeout restarts with each reply.
 */
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000
export const SMTP_GREETING_TIMEOUT_MS = 10_000
export const SMTP_SOCKET_TIMEOUT_MS = 30_000

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
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
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
 * The transport is built once and reused, which with `pool: true` is what
 * actually keeps connections open across sends.
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
   * Drains the pool at shutdown; an in-flight send finishes first. Wired into
   * Fastify's `onClose`, so `app.close()` stays the single teardown path.
   */
  close(): void {
    this.#transport.close()
  }
}
