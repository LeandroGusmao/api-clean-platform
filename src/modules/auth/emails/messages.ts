import type { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage } from '#shared/ports/email-sender'

const SECONDS_PER_MINUTE = 60

const VERIFICATION_SUBJECT = 'Confirm your email address'
const ALREADY_EXISTS_SUBJECT = 'Someone tried to register with your address'
const PASSWORD_CHANGED_SUBJECT = 'Your password was changed'
const PASSWORD_RESET_SUBJECT = 'Reset your password'
const PASSWORD_RESET_COMPLETED_SUBJECT = 'Your password was reset'
const GOOGLE_ACCOUNT_LINKED_SUBJECT = 'A Google sign-in was connected to your account'
const ACCOUNT_DELETED_SUBJECT = 'Your account was deleted'
const REUSE_DETECTED_SUBJECT = 'A session on your account was signed out'
const UNRECOGNIZED_ADDRESS = 'an unrecognized address'

/**
 * Pure functions rather than bodies inlined in the use cases: this is the one
 * file a non-engineer may want to reword, and it holds every message the system
 * can send.
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
 * The real defence behind the password change endpoint: an attacker holding a
 * stolen access token can change the password, and the owner finding out is what
 * makes that recoverable.
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

/**
 * Sent for `POST /auth/password/forgot` when the address has an account. It
 * carries the reset token; the response itself is a bare 202, so this mail is
 * the channel that diverges, and it reaches only whoever owns the address.
 */
export function passwordResetEmail(
  to: Email,
  token: string,
  ttlSeconds: number,
): EmailMessage {
  const minutes = Math.round(ttlSeconds / SECONDS_PER_MINUTE)

  return {
    to: to.value,
    subject: PASSWORD_RESET_SUBJECT,
    text:
      `Use this token to reset your password: ${token}\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n\n` +
      'If you did not ask to reset your password, ignore this message — ' +
      'nothing has changed.',
  }
}

/**
 * Sent after a successful reset. Every session was revoked; if the owner did
 * not do this, running the recovery flow again locks out whoever did.
 */
export function passwordResetCompletedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: PASSWORD_RESET_COMPLETED_SUBJECT,
    text:
      'Your password was just reset through the account recovery flow, and ' +
      'every session was signed out.\n\n' +
      'If this was not you, reset your password again immediately to sign out ' +
      'whoever did.',
  }
}

/**
 * Sent when Google sign-in is linked to an account that already had a password.
 * The link means someone can now sign in without the password, so the owner
 * finding out is what makes an unwanted link recoverable — the same role
 * `passwordChangedEmail` plays for the password change.
 */
export function googleAccountLinkedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: GOOGLE_ACCOUNT_LINKED_SUBJECT,
    text:
      'Sign in with Google was just connected to your account.\n\n' +
      'If this was not you, reset your password immediately — whoever ' +
      'connected it can then sign in without your password.',
  }
}

export interface ReuseDetectedSession {
  deviceLabel: string
  sessionStartedAt: Date
  /** Who PRESENTED the spent token — possibly the owner's own client. */
  ip: string | null
}

/**
 * Sent when a spent refresh token is presented again and the family it belonged
 * to is revoked. The address is the one that presented the token, which can be
 * an attacker or the owner's own client retrying outside the grace window, so
 * the text says "suspicious" and covers both readings.
 */
export function reuseDetectedEmail(
  to: Email,
  session: ReuseDetectedSession,
): EmailMessage {
  const address = session.ip ?? UNRECOGNIZED_ADDRESS

  return {
    to: to.value,
    subject: REUSE_DETECTED_SUBJECT,
    text:
      'A sign-in credential from one of your sessions was used a second time, ' +
      'which is suspicious. We signed that session out: it was on ' +
      `${session.deviceLabel} and started at ${session.sessionStartedAt.toISOString()}.\n\n` +
      `The attempt came from ${address}.\n\n` +
      'If you do not recognise this, reset your password immediately. If it ' +
      'was you, for instance an app that misbehaved, sign in again and no ' +
      'further action is needed.',
  }
}

/**
 * The last message this address receives from the app. Sent for the same
 * reason `passwordChangedEmail` is: if a stolen session asked for the
 * deletion, this is the owner's only chance to find out.
 */
export function accountDeletedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: ACCOUNT_DELETED_SUBJECT,
    text:
      'Your account and every session tied to it were just deleted.\n\n' +
      'This cannot be undone — nothing is kept, and signing up again with ' +
      'this address starts a brand new account.\n\n' +
      'If this was not you, someone had access to your account.',
  }
}
