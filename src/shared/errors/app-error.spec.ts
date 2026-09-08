import { describe, expect, it } from 'vitest'
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '#shared/errors/app-error'

const USER_NOT_FOUND_CODE = 'USER_NOT_FOUND'
const USER_NOT_FOUND_MESSAGE = 'User not found'

/** Stands in for a real module error; the taxonomy has no concrete errors of its own. */
class UserNotFoundError extends NotFoundError {
  readonly code = USER_NOT_FOUND_CODE

  constructor() {
    super(USER_NOT_FOUND_MESSAGE)
  }
}

describe('error taxonomy', () => {
  it('keeps the prototype chain intact across two levels of subclassing', () => {
    const error = new UserNotFoundError()

    // This is what `instanceof` in the error handler depends on. Subclassing
    // `Error` silently breaks it when the compile target is ES5, so it is
    // pinned here rather than assumed.
    expect(error).toBeInstanceOf(UserNotFoundError)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
  })

  it('does not match a sibling category', () => {
    const error = new UserNotFoundError()

    // Categories are siblings, never a chain. If one ever extended another,
    // the handler's mapping table would start depending on row order.
    expect(error).not.toBeInstanceOf(UnauthorizedError)
    expect(error).not.toBeInstanceOf(ConflictError)
  })

  it('carries the contract code and the human-readable message', () => {
    const error = new UserNotFoundError()

    expect(error.code).toBe(USER_NOT_FOUND_CODE)
    expect(error.message).toBe(USER_NOT_FOUND_MESSAGE)
  })

  it('defaults to not being a security event', () => {
    // Most failures are routine client traffic, not a signal to investigate —
    // a subclass opts in explicitly, like `RefreshTokenReusedError` does.
    const error = new UserNotFoundError()

    expect(error.securityEvent).toBe(false)
  })
})
