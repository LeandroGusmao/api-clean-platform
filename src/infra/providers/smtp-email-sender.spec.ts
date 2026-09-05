import { describe, expect, it } from 'vitest'
import { type SmtpEmailSenderConfig, smtpTransportOptions } from './smtp-email-sender.js'

const MINIMUM_TLS_VERSION = 'TLSv1.2'
const SMTP_HOST = 'smtp.example.com'
const SMTP_SUBMISSION_PORT = 587
const SMTP_USER = 'apikey'
const SMTP_PASSWORD = 'secret'

const baseConfig: SmtpEmailSenderConfig = {
  host: SMTP_HOST,
  port: SMTP_SUBMISSION_PORT,
  secure: false,
  requireTls: false,
  from: 'API Clean Platform <no-reply@example.com>',
}

describe('smtpTransportOptions', () => {
  it('pools connections rather than opening a fresh one per send', () => {
    expect(smtpTransportOptions(baseConfig).pool).toBe(true)
  })

  it('forces STARTTLS when required, so the connection fails closed', () => {
    expect(smtpTransportOptions({ ...baseConfig, requireTls: true }).requireTLS).toBe(
      true,
    )
  })

  it('does not require STARTTLS when disabled, which is what lets Mailpit work', () => {
    expect(smtpTransportOptions(baseConfig).requireTLS).toBe(false)
  })

  it('refuses anything below TLS 1.2 whenever TLS is negotiated at all', () => {
    expect(smtpTransportOptions(baseConfig).tls?.minVersion).toBe(MINIMUM_TLS_VERSION)
  })

  it('passes implicit TLS through for SMTPS setups', () => {
    expect(smtpTransportOptions({ ...baseConfig, secure: true }).secure).toBe(true)
  })

  it('omits auth entirely when no user is configured — Mailpit accepts none', () => {
    expect(smtpTransportOptions(baseConfig).auth).toBeUndefined()
  })

  it('sends credentials when a user is configured', () => {
    expect(
      smtpTransportOptions({
        ...baseConfig,
        user: SMTP_USER,
        password: SMTP_PASSWORD,
      }).auth,
    ).toEqual({ user: SMTP_USER, pass: SMTP_PASSWORD })
  })
})
