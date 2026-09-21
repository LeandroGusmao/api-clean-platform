import { describe, expect, it } from 'vitest'
import { classify } from './layers.mjs'

describe('classify', () => {
  it('classifies the pure layer of a module', () => {
    expect(classify('src/modules/auth/use-cases/login-user.ts')).toBe('pure')
    expect(classify('src/modules/auth/value-objects/email.ts')).toBe('pure')
    expect(classify('src/modules/auth/config.ts')).toBe('pure')
    expect(classify('src/shared/ports/clock.ts')).toBe('pure')
  })

  it('classifies infrastructure', () => {
    expect(classify('src/modules/auth/infra/drizzle/drizzle-users-repository.ts')).toBe(
      'module-infra',
    )
    expect(classify('src/infra/http/server.ts')).toBe('global-infra')
  })

  it('classifies composition', () => {
    expect(classify('src/main/app.ts')).toBe('composition')
    expect(classify('src/modules/auth/container.ts')).toBe('composition')
  })

  // ARCHITECTURE.md §2: `fixtures/` and `in-memory/` enter `test` by folder
  // name. Classifying them as production would make the gate approve the very
  // import it exists to block.
  it('classifies test doubles by folder name, not by path', () => {
    expect(classify('src/modules/auth/use-cases/login-user.spec.ts')).toBe('test')
    expect(classify('tests/integration/register.spec.ts')).toBe('test')
    expect(
      classify('src/modules/auth/infra/in-memory/in-memory-users-repository.ts'),
    ).toBe('test')
    expect(classify('src/infra/config/fixtures/test-env.ts')).toBe('test')
  })

  it('reports a production file that no element covers', () => {
    expect(classify('src/modules/auth/helpers/format.ts')).toBe('unknown')
  })
})
