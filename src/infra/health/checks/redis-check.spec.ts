import { describe, expect, it, vi } from 'vitest'
import { checkRedis, type HealthRedis } from './redis-check.js'

function redisWithPing(ping: () => Promise<unknown>): HealthRedis {
  return { ping: vi.fn(ping) } as unknown as HealthRedis
}

describe('checkRedis', () => {
  it('reports up when the server answers the PING', async () => {
    const result = await checkRedis(redisWithPing(async () => 'PONG'))

    expect(result).toEqual({ name: 'redis', up: true })
  })

  it('reports down, carrying the error, when the PING fails', async () => {
    const failure = new Error('Command timed out')

    const result = await checkRedis(
      redisWithPing(async () => {
        throw failure
      }),
    )

    expect(result).toEqual({ name: 'redis', up: false, error: failure })
  })
})
