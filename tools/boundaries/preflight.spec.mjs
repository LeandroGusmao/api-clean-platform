import { describe, expect, it } from 'vitest'
import { assertTranspilerSupported, readTranspilerState } from './preflight.mjs'

const SUPPORTED_RANGE = '>=2.0.0 <7.0.0'

describe('assertTranspilerSupported', () => {
  it('accepts a TypeScript inside the supported range', () => {
    expect(() => assertTranspilerSupported('6.0.3', SUPPORTED_RANGE)).not.toThrow()
  })

  // With TypeScript 7 dependency-cruiser cruises zero modules and exits 0:
  // a green run that checked nothing (ARCHITECTURE.md §4, third trap).
  it('rejects TypeScript 7', () => {
    expect(() => assertTranspilerSupported('7.0.2', SUPPORTED_RANGE)).toThrow(/7\.0\.2/)
  })

  it('rejects a missing TypeScript', () => {
    expect(() => assertTranspilerSupported(null, SUPPORTED_RANGE)).toThrow()
  })
})

describe('readTranspilerState', () => {
  it('reads both sides from the installed dependency-cruiser', () => {
    const state = readTranspilerState()
    expect(state.supportedRange).toMatch(/^>=/)
    expect(state.resolvedVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is consistent: the nested TypeScript satisfies the range', () => {
    const { resolvedVersion, supportedRange } = readTranspilerState()
    expect(() => assertTranspilerSupported(resolvedVersion, supportedRange)).not.toThrow()
  })
})
