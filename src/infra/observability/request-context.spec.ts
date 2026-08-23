import { describe, expect, it } from 'vitest'
import { getTraceId, runWithRequestContext } from '#infra/observability/request-context'

const FIRST_TRACE_ID = 'trace-first'
const SECOND_TRACE_ID = 'trace-second'
const SHORT_DELAY_MS = 5
const LONG_DELAY_MS = 20

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('request context', () => {
  it('reports no traceId outside any context', () => {
    expect(getTraceId()).toBeUndefined()
  })

  it('keeps the traceId readable after an await', async () => {
    const seen = await runWithRequestContext(FIRST_TRACE_ID, async () => {
      await delay(SHORT_DELAY_MS)
      return getTraceId()
    })

    expect(seen).toBe(FIRST_TRACE_ID)
  })

  it('isolates concurrent flows from each other', async () => {
    // The slower flow starts first and finishes last: if the store leaked
    // between flows, this is where it would show.
    const readAfter = (traceId: string, ms: number) =>
      runWithRequestContext(traceId, async () => {
        await delay(ms)
        return getTraceId()
      })

    const [first, second] = await Promise.all([
      readAfter(FIRST_TRACE_ID, LONG_DELAY_MS),
      readAfter(SECOND_TRACE_ID, SHORT_DELAY_MS),
    ])

    expect(first).toBe(FIRST_TRACE_ID)
    expect(second).toBe(SECOND_TRACE_ID)
  })
})
