/**
 * Transactional email, as the pure layer sees it.
 *
 * Lives in `shared/` and not in `modules/auth/ports/` for the same reason
 * `IClock` and `ITokenDigest` do: sending mail is a cross-cutting technical
 * capability, not a concept of authentication. The next module that needs to
 * notify someone must not have to import a port out of `auth` — that is the
 * antipattern R5 forbids.
 *
 * Plain text only. HTML doubles the template surface and brings an escaping
 * decision of its own, and an email whose payload is a six-digit code gains
 * nothing from it.
 */
export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface IEmailSender {
  send(message: EmailMessage): Promise<void>
}
