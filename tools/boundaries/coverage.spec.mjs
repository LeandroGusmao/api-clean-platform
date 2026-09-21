import { describe, expect, it } from 'vitest'
import { assertEveryFileClassified, assertEveryFileCruised } from './coverage.mjs'

describe('assertEveryFileCruised', () => {
  it('passes when the graph covers every file on disk', () => {
    const files = ['src/a.ts', 'src/b.ts']
    expect(() => assertEveryFileCruised(files, files)).not.toThrow()
  })

  // A file TypeScript 6 cannot parse drops out of the graph without zeroing
  // the count, so `totalCruised > 0` would not catch it.
  it('names the files that fell out of the graph', () => {
    expect(() => assertEveryFileCruised(['src/a.ts'], ['src/a.ts', 'src/b.ts'])).toThrow(
      /src\/b\.ts/,
    )
  })
})

describe('assertEveryFileClassified', () => {
  it('passes when every production file lands in an element', () => {
    expect(() =>
      assertEveryFileClassified(['src/modules/auth/use-cases/login-user.ts']),
    ).not.toThrow()
  })

  it('names a production file that no element of §2 covers', () => {
    expect(() =>
      assertEveryFileClassified(['src/modules/auth/helpers/format.ts']),
    ).toThrow(/helpers\/format\.ts/)
  })
})
