import { describe, expect, it } from 'vitest'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('UuidIdGenerator', () => {
  it('produces a UUID', () => {
    expect(new UuidIdGenerator().generate()).toMatch(UUID_PATTERN)
  })

  it('produces a different value on every call', () => {
    const generator = new UuidIdGenerator()

    expect(generator.generate()).not.toBe(generator.generate())
  })
})
