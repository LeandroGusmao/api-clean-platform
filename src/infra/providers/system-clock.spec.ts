import { describe, expect, it } from 'vitest'
import { SystemClock } from '#infra/providers/system-clock'

// Generous: the assertion is "this is the wall clock", not "this is fast".
const TOLERANCE_MS = 5_000

describe('SystemClock', () => {
  it('returns the current instant as a Date', () => {
    const before = Date.now()
    const now = new SystemClock().now()

    expect(now).toBeInstanceOf(Date)
    expect(Math.abs(now.getTime() - before)).toBeLessThan(TOLERANCE_MS)
  })
})
