import type { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage } from '#shared/ports/email-sender'

const SECONDS_PER_MINUTE = 60

const VERIFICATION_SUBJECT = 'Confirm your email address'
const ALREADY_EXISTS_SUBJECT = 'Someone tried to register with your address'
const PASSWORD_CHANGED_SUBJECT = 'Your password was changed'

/**
 * The bodies live here, as pure functions, rather than inline in the use cases:
 * they are the one thing in this slice a non-engineer may want to reword, and a
 * reviewer should be able to read every message the system can send in one file.
 */
export function verificationEmail(
  to: Email,
  code: string,
  ttlSeconds: number,
): EmailMessage {
  const minutes = Math.round(ttlSeconds / SECONDS_PER_MINUTE)

  return {
    to: to.value,
    subject: VERIFICATION_SUBJECT,
    text:
      `Your verification code is ${code}.\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n\n` +
      'If you did not create an account, you can ignore this message.',
  }
}

/**
 * Sent when someone registers with an address that already has a VERIFIED
 * account. It is half of what lets the endpoint answer 202 to everyone: the
 * response cannot distinguish the two cases, so the mail does — and it goes only
 * to whoever owns the address.
 */
export function accountAlreadyExistsEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: ALREADY_EXISTS_SUBJECT,
    text:
      'Someone tried to create an account with this email address, ' +
      'and one already exists.\n\n' +
      'If that was you, sign in instead — or reset your password if you have ' +
      'forgotten it. If it was not, no action is needed: nothing changed.',
  }
}

/**
 * The real defence behind the password change endpoint (§11.1 of the slice 9
 * design): an attacker holding a stolen access token can change the password,
 * and the owner finding out is what makes that recoverable.
 */
export function passwordChangedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: PASSWORD_CHANGED_SUBJECT,
    text:
      'Your password was just changed, and every other session was signed out.\n\n' +
      'If this was not you, reset your password immediately.',
  }
}
