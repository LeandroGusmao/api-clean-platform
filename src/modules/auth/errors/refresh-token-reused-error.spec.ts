import { describe, expect, it } from 'vitest'
import { RefreshTokenReusedError } from './refresh-token-reused-error.js'

describe('RefreshTokenReusedError', () => {
  // The only thing that makes the error handler log this one at `warn`
  // instead of answering silently, like every other `AppError`.
  it('is marked as a security event', () => {
    expect(new RefreshTokenReusedError().securityEvent).toBe(true)
  })
})
