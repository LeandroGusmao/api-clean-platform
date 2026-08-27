# Register User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar `POST /auth/register` — o primeiro corte vertical do projeto, de HTTP até o Postgres, atravessando entidade, value objects, use case, repositório e container.

**Architecture:** Módulo `auth` ganha camada pura (`entities/`, `value-objects/`, `use-cases/`, contratos em `repositories/` e `providers/`) e adapters em `infra/` (Drizzle, in-memory, argon2, HTTP). O grafo é montado por container manual tipado em `main/container.ts`, e `buildApp` entrega ao plugin do módulo **só a fatia dele**. Tempo e identidade entram por contrato (`IClock`, `IIdGenerator`), nunca por `new Date()` na camada pura.

**Tech Stack:** TypeScript 7 (ESM nodenext), Fastify 5, Zod 4, `fastify-type-provider-zod` 7, Drizzle ORM `1.0.0-rc.4`, `@node-rs/argon2` 2.1.0, PostgreSQL 18, Vitest 4, Biome 2.5.9.

**Spec:** [`docs/superpowers/specs/2026-08-26-register-user-design.md`](../specs/2026-08-26-register-user-design.md)

## Global Constraints

Estas valem para **todas** as tasks. Cada task herda esta seção.

**Ambiente — leia antes de rodar qualquer comando.** O `engines` do projeto exige
`node >=24.19.0 <25` e o default da máquina é `v24.16.0`. Todo comando `pnpm`
falha sem isto:

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
```

**Postgres de teste.** A suíte de integração usa o serviço `postgres-test` do
`docker-compose.yml`, na porta 5433. Suba com `docker compose up -d postgres-test`
se não estiver rodando. O volume é tmpfs: reiniciar o container zera o banco, e as
migrations rodam de novo pelo `globalSetup` do Vitest.

**Idioma.** Todo código — identificadores, strings, mensagens de log, mensagens de
erro — e **todos os comentários** em **inglês**. Só arquivos `.md` podem ser em
português.

**Sem magic strings/numbers.** Nada de literal inline (`'application/json'`, `409`,
`'23505'`). Extrair para constante nomeada em `UPPER_SNAKE_CASE`, declarada perto
de onde é usada. Isso vale inclusive para os arquivos de teste.

> **Única exceção, e ela está nos testes abaixo:** a tabela de um `it.each`. Ali a
> coluna de rótulo já nomeia o valor (`['no digit', 'abcdefgh!']`), e extrair cada
> linha para constante deixaria o caso de teste menos legível, não mais. Fora de
> uma tabela `it.each`, a regra vale inteira.

**Regras numeradas do projeto que esta fatia toca:**
- **R1** — repositório usa só a API core do Drizzle (`select()`/`insert()`/`where()`). **Nunca** `db.query.*`.
- **R2** — coluna sempre nomeada explicitamente: `uuid('id')`, nunca inferência de casing.
- **R4** — migrations são forward-only. Nunca editar nem renomear migration já aplicada.
- **R6** — só `src/infra/config/env.ts` lê `process.env`.
- **R7** — a camada pura não produz valor não determinístico. Nada de `new Date()`, `Date.now()`, `Math.random()` ou `crypto.randomUUID()` em `entities/`, `value-objects/`, `use-cases/`.

**Regra de fronteira** (quem pode importar quem):

| Elemento | Padrão | Pode importar |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,providers,use-cases,dtos,errors}/**` · `src/shared/**` | só `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · o `module-infra` do próprio módulo |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| `test` | `**/*.spec.ts` · `tests/**` | tudo |

**Imports — uma regra só, aplique sem exceção.** Se o alvo está na **mesma pasta
ou numa subpasta dela**, use caminho relativo **com sufixo `.js`**
(`./email.js`, `./schema/users.js`) — o sufixo é exigência do ESM nodenext.
Em qualquer outro caso — inclusive para outra pasta do mesmo módulo — use os
subpath imports do Node **sem** extensão: `#modules/*`, `#infra/*`, `#shared/*`,
`#main/*`.

Ou seja: de `value-objects/email.ts` para `errors/`, é
`#modules/auth/errors/invalid-email-error`, e **não** `../errors/...`. Subir de
pasta com `..` fica fora do padrão; o código de cada task abaixo já está escrito
assim, é só copiar.

**`verbatimModuleSyntax` está ligado:** todo import que é só de tipo precisa de
`import type`.

**`exactOptionalPropertyTypes` está ligado:** propriedade opcional é omitida, nunca
setada como `undefined`.

**`noUncheckedIndexedAccess` está ligado:** `array[0]` tem tipo `T | undefined`.
Guarde com `if (x === undefined) throw new Error(MESSAGE)`.

**Testes.** Vitest sem globals — importe `describe`, `it`, `expect` e os hooks de
`'vitest'` explicitamente. Unitário fica **colocado** ao lado do arquivo
(`src/**/*.spec.ts`); integração fica em `tests/integration/**/*.spec.ts`.
Limpeza de tabela é em `beforeEach`, não `afterEach` — assim um teste que falha
deixa o estado para inspeção.

**Formatação.** Biome: 2 espaços, aspas simples, **sem ponto e vírgula**, trailing
comma em tudo, largura 90. Rode `pnpm lint` (não `lint:fix`) para conferir; use
`lint:fix` só para formatar.

**Comentários explicam o porquê, não o quê.** Este repositório usa comentário para
registrar a decisão e a armadilha — não para narrar a linha seguinte.

**Commits.** Um por task, no fim. Mensagem em inglês, no imperativo.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/shared/providers/clock.ts` | contrato `IClock` — tempo entra por aqui |
| `src/shared/providers/id-generator.ts` | contrato `IIdGenerator` — identidade entra por aqui |
| `src/infra/providers/system-clock.ts` | adapter: `new Date()` |
| `src/infra/providers/uuid-id-generator.ts` | adapter: `randomUUID()` |
| `src/modules/auth/errors/invalid-email-error.ts` | 400 · `INVALID_EMAIL` |
| `src/modules/auth/errors/invalid-password-error.ts` | 400 · `INVALID_PASSWORD` |
| `src/modules/auth/errors/email-already-in-use-error.ts` | 409 · `EMAIL_ALREADY_IN_USE` |
| `src/modules/auth/value-objects/email.ts` | valida e **normaliza** e-mail; exporta `MAX_EMAIL_LENGTH` |
| `src/modules/auth/value-objects/password.ts` | política de senha; exporta os limites e o padrão |
| `src/modules/auth/entities/user.ts` | estado do usuário em campos `#`; só `create()` |
| `src/modules/auth/repositories/users-repository.ts` | contrato `IUsersRepository` — só `save()` |
| `src/modules/auth/providers/hash-provider.ts` | contrato `IHashProvider` — só `hash()` |
| `src/modules/auth/use-cases/register-user.ts` | orquestra: valida, hasheia, cria, persiste |
| `src/modules/auth/infra/drizzle/schema/users.ts` | **modificado**: `email_verified_at` + constante do índice |
| `src/modules/auth/infra/drizzle/user-mapper.ts` | entidade → row (uma direção só) |
| `src/modules/auth/infra/drizzle/drizzle-users-repository.ts` | insert + tradução do `23505` da constraint certa |
| `src/modules/auth/infra/in-memory/in-memory-users-repository.ts` | espelha a unicidade do índice, para teste unitário |
| `src/modules/auth/infra/providers/argon2-hash-provider.ts` | adapter argon2id |
| `src/modules/auth/infra/http/endpoints/register.ts` | schema Zod + handler + rota |
| `src/modules/auth/infra/http/routes.ts` | agregador fino do módulo |
| `src/modules/auth/container.ts` | factory do container do módulo |
| `src/main/container.ts` | composition root: junta os módulos |
| `src/main/app.ts` | **modificado**: monta o container, registra `authRoutes` |
| `src/infra/observability/redact-paths.ts` | **modificado**: `passwordHash` |

---

## Task 1: Providers transversais e o furo do `passwordHash` no redact

O `REDACT_PATHS` redige `password` e `*.password`, mas o redact do pino casa nome
de chave **exato** — `passwordHash` passa em claro. Esta task fecha isso e cria os
dois contratos que sustentam a R7 no resto do plano.

**Files:**
- Create: `src/shared/providers/clock.ts`
- Create: `src/shared/providers/id-generator.ts`
- Create: `src/infra/providers/system-clock.ts`
- Create: `src/infra/providers/system-clock.spec.ts`
- Create: `src/infra/providers/uuid-id-generator.ts`
- Create: `src/infra/providers/uuid-id-generator.spec.ts`
- Modify: `src/infra/observability/redact-paths.ts`
- Modify: `src/infra/http/server.spec.ts` (adiciona um `it` ao describe existente)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `interface IClock { now(): Date }` em `#shared/providers/clock`
  - `interface IIdGenerator { generate(): string }` em `#shared/providers/id-generator`
  - `class SystemClock implements IClock` em `#infra/providers/system-clock`
  - `class UuidIdGenerator implements IIdGenerator` em `#infra/providers/uuid-id-generator`

- [ ] **Step 1: Escreva o teste que falha, no describe de redaction que já existe**

Em `src/infra/http/server.spec.ts`, dentro do `describe('buildServer logger redaction', ...)`, depois do último `it`:

```ts
  it('redacts a password hash at the top level and one level deep', async () => {
    const logged = await logAndCapture({
      passwordHash: SECRET_VALUE,
      user: { passwordHash: SECRET_VALUE },
    })

    // `password` does not cover `passwordHash`: pino matches whole key names,
    // not prefixes. Without its own entry the hash reaches the log in clear.
    expect(logged.passwordHash).toBe(REDACTED_CENSOR)
    expect(logged).toMatchObject({ user: { passwordHash: REDACTED_CENSOR } })
  })
```

- [ ] **Step 2: Rode e confirme que falha**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm test:unit
```

Esperado: FAIL — `expected 'super-secret' to be '[REDACTED]'`.

- [ ] **Step 3: Corrija o `REDACT_PATHS`**

`src/infra/observability/redact-paths.ts` — o array inteiro fica assim:

```ts
export const REDACT_PATHS = [
  'password',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const
```

- [ ] **Step 4: Rode e confirme que passa**

```bash
pnpm test:unit
```

Esperado: PASS.

- [ ] **Step 5: Crie os dois contratos**

`src/shared/providers/clock.ts`:

```ts
/**
 * The only source of "now" the pure layer may use (R7). A use case that calls
 * `new Date()` cannot be tested at a boundary — and the refresh rotation of
 * decision 11 is all boundaries: expiry, and a 30 second grace window.
 */
export interface IClock {
  now(): Date
}
```

`src/shared/providers/id-generator.ts`:

```ts
/**
 * The only source of entity identity the pure layer may use (R7).
 *
 * Deliberately separate from the token generator that decision 21 sketched:
 * an entity id and a cryptographic secret have different security profiles and
 * different reasons to change. Moving ids from UUIDv4 to v7 has nothing to do
 * with the entropy of a refresh token, and bundling the two would hand a use
 * case that only wants an id a port that also mints secrets.
 */
export interface IIdGenerator {
  /** An opaque entity identifier. The format is the adapter's business. */
  generate(): string
}
```

- [ ] **Step 6: Escreva os testes dos dois adapters**

`src/infra/providers/system-clock.spec.ts`:

```ts
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
```

`src/infra/providers/uuid-id-generator.spec.ts`:

```ts
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
```

- [ ] **Step 7: Rode e confirme que falham**

```bash
pnpm test:unit
```

Esperado: FAIL — os módulos `system-clock` e `uuid-id-generator` não existem.

- [ ] **Step 8: Implemente os dois adapters**

`src/infra/providers/system-clock.ts`:

```ts
import type { IClock } from '#shared/providers/clock'

export class SystemClock implements IClock {
  now(): Date {
    return new Date()
  }
}
```

`src/infra/providers/uuid-id-generator.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { IIdGenerator } from '#shared/providers/id-generator'

/**
 * UUIDv4. Node 24 has no v7: `randomUUID({ version: 7 })` **silently ignores**
 * the option and returns a v4 — verified on both 24.16.0 and 24.19.0. Postgres
 * 18.4 does have a native `uuidv7()`, but that sits on the side R7 keeps the
 * pure layer away from.
 *
 * Moving to v7 later means editing this file and emitting a migration that
 * changes the column default — which is exactly what the contract bought.
 */
export class UuidIdGenerator implements IIdGenerator {
  generate(): string {
    return randomUUID()
  }
}
```

- [ ] **Step 9: Rode tudo**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS.

- [ ] **Step 10: Commit**

```bash
git add src/shared/providers src/infra/providers src/infra/observability/redact-paths.ts src/infra/http/server.spec.ts
git commit -m "feat: add clock and id generator ports, and redact password hashes"
```

---

## Task 2: Value objects `Email` e `Password`

Camada pura, sem dependência de nada além da taxonomia de erros. As constantes
exportadas daqui viram a **única** definição dos números — o schema Zod do
endpoint (Task 7) importa estas mesmas.

**Files:**
- Create: `src/modules/auth/errors/invalid-email-error.ts`
- Create: `src/modules/auth/errors/invalid-password-error.ts`
- Create: `src/modules/auth/value-objects/email.ts`
- Create: `src/modules/auth/value-objects/email.spec.ts`
- Create: `src/modules/auth/value-objects/password.ts`
- Create: `src/modules/auth/value-objects/password.spec.ts`

**Interfaces:**
- Consumes: `ValidationError` de `#shared/errors/app-error`.
- Produces:
  - `class InvalidEmailError extends ValidationError` — `constructor(reason: string)`
  - `class InvalidPasswordError extends ValidationError` — `constructor(reason: string)`
  - `class Email` — `static create(raw: string): Email`, `static fromTrusted(value: string): Email`, `readonly value: string`, `equals(other: Email): boolean`
  - `class Password` — `static create(raw: string): Password`, `get value(): string`
  - `const MAX_EMAIL_LENGTH = 254`
  - `const MIN_PASSWORD_LENGTH = 8`, `const MAX_PASSWORD_LENGTH = 128`, `const PASSWORD_POLICY_PATTERN`

- [ ] **Step 1: Crie os dois erros**

`src/modules/auth/errors/invalid-email-error.ts`:

```ts
import { ValidationError } from '#shared/errors/app-error'

const INVALID_EMAIL_CODE = 'INVALID_EMAIL'
const INVALID_EMAIL_MESSAGE_PREFIX = 'Invalid email: '

/**
 * Raised by the `Email` value object. Unreachable over HTTP — the endpoint's
 * Zod schema refuses the same values first — so this exists for the other
 * entrypoints of decision 10: worker, cron, seed.
 */
export class InvalidEmailError extends ValidationError {
  readonly code = INVALID_EMAIL_CODE

  constructor(reason: string) {
    super(`${INVALID_EMAIL_MESSAGE_PREFIX}${reason}`)
  }
}
```

`src/modules/auth/errors/invalid-password-error.ts`:

```ts
import { ValidationError } from '#shared/errors/app-error'

const INVALID_PASSWORD_CODE = 'INVALID_PASSWORD'
const INVALID_PASSWORD_MESSAGE_PREFIX = 'Invalid password: '

/**
 * Raised by the `Password` value object. Like `InvalidEmailError`, unreachable
 * over HTTP and kept for the non-HTTP entrypoints of decision 10.
 *
 * The reason never quotes the value: this message reaches logs.
 */
export class InvalidPasswordError extends ValidationError {
  readonly code = INVALID_PASSWORD_CODE

  constructor(reason: string) {
    super(`${INVALID_PASSWORD_MESSAGE_PREFIX}${reason}`)
  }
}
```

- [ ] **Step 2: Escreva o teste do `Email`**

`src/modules/auth/value-objects/email.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { Email, MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'

const VALID_EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const LOCAL_PART = 'a'.repeat(MAX_EMAIL_LENGTH)

describe('Email.create', () => {
  it('trims and lowercases, so the value matches the lower(email) index', () => {
    expect(Email.create(MIXED_CASE_EMAIL).value).toBe(VALID_EMAIL)
  })

  it('accepts a plain address', () => {
    expect(Email.create(VALID_EMAIL).value).toBe(VALID_EMAIL)
  })

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['no at sign', 'joao.example.com'],
    ['two at signs', 'joao@ex@ample.com'],
    ['empty local part', '@example.com'],
    ['empty domain', 'joao@'],
    ['inner whitespace', 'jo ao@example.com'],
    ['longer than the cap', `${LOCAL_PART}@example.com`],
  ])('rejects %s', (_label, raw) => {
    expect(() => Email.create(raw)).toThrow(InvalidEmailError)
  })
})

describe('Email.fromTrusted', () => {
  it('skips validation, so a stricter future rule cannot break stored rows', () => {
    const stored = 'legacy@@value'

    expect(Email.fromTrusted(stored).value).toBe(stored)
  })
})

describe('Email.equals', () => {
  it('compares by value, not by identity', () => {
    expect(Email.create(VALID_EMAIL).equals(Email.create(MIXED_CASE_EMAIL))).toBe(true)
  })
})
```

- [ ] **Step 3: Rode e confirme que falha**

```bash
pnpm test:unit
```

Esperado: FAIL — o módulo `email` não existe.

- [ ] **Step 4: Implemente o `Email`**

`src/modules/auth/value-objects/email.ts`:

```ts
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'

/** RFC 5321 upper bound. The column is `text`, so this is the real guard. */
export const MAX_EMAIL_LENGTH = 254

const AT_SIGN = '@'
const WHITESPACE_PATTERN = /\s/

const EMPTY_REASON = 'must not be empty'
const TOO_LONG_REASON = `must be at most ${MAX_EMAIL_LENGTH} characters`
const WHITESPACE_REASON = 'must not contain whitespace'
const MALFORMED_REASON = 'must be a valid email address'

/**
 * Immutable, self-validating, compared by value.
 *
 * `create` normalizes with `trim().toLowerCase()`, which is what makes the
 * stored value always match the functional unique index on `lower(email)` —
 * every lookup must query `lower(email) = $1` to hit that index.
 *
 * Validation is deliberately pragmatic. Full RFC 5322 regexes are notoriously
 * wrong, and real deliverability is proven by email verification, not syntax.
 */
export class Email {
  private constructor(readonly value: string) {
    // `readonly` is compile-time only. The freeze keeps an Email handed out by
    // `user.email` from being corrupted at runtime.
    Object.freeze(this)
  }

  /** Builds from untrusted input: registration, login, a seed file. */
  static create(raw: string): Email {
    const normalized = raw.trim().toLowerCase()

    if (normalized.length === 0) throw new InvalidEmailError(EMPTY_REASON)
    if (normalized.length > MAX_EMAIL_LENGTH) {
      throw new InvalidEmailError(TOO_LONG_REASON)
    }
    // `trim` only strips the edges; an unquoted space anywhere inside is never
    // a valid address.
    if (WHITESPACE_PATTERN.test(normalized)) {
      throw new InvalidEmailError(WHITESPACE_REASON)
    }

    const at = normalized.indexOf(AT_SIGN)
    // Exactly one '@', with a non-empty local part and a non-empty domain.
    if (
      at <= 0 ||
      at !== normalized.lastIndexOf(AT_SIGN) ||
      at === normalized.length - 1
    ) {
      throw new InvalidEmailError(MALFORMED_REASON)
    }

    return new Email(normalized)
  }

  /**
   * Rehydrates a value that was already persisted, and therefore already
   * validated. Skips validation on purpose: re-validating on read would let a
   * future stricter rule break the loading of rows that were valid when
   * written.
   */
  static fromTrusted(value: string): Email {
    return new Email(value)
  }

  equals(other: Email): boolean {
    return this.value === other.value
  }
}
```

- [ ] **Step 5: Rode e confirme que passa**

```bash
pnpm test:unit
```

Esperado: PASS.

- [ ] **Step 6: Escreva o teste do `Password`**

`src/modules/auth/value-objects/password.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  Password,
} from '#modules/auth/value-objects/password'

const VALID_PASSWORD = 'sup3r-s3cr3t!'
const PADDED_PASSWORD = '  sup3r-s3cr3t!  '
const TOO_SHORT = 'aB1!'
const TOO_LONG = 'aB1!'.repeat(MAX_PASSWORD_LENGTH)
const EMPTY_SERIALIZATION = '{}'

describe('Password.create', () => {
  it('accepts a password that satisfies every rule', () => {
    expect(Password.create(VALID_PASSWORD).value).toBe(VALID_PASSWORD)
  })

  it('does not trim: an edge space is a valid password character', () => {
    expect(Password.create(PADDED_PASSWORD).value).toBe(PADDED_PASSWORD)
  })

  it('accepts a newline, which the `s` flag on the policy pattern allows', () => {
    // Without the flag `.` never crosses `\n`, and the anchored lookaheads
    // would reject a password that satisfies the whole policy.
    const withNewline = 'abc\n123!'

    expect(Password.create(withNewline).value).toBe(withNewline)
  })

  it.each([
    ['shorter than the minimum', TOO_SHORT],
    ['longer than the maximum', TOO_LONG],
    ['no letter', '12345678!'],
    ['no digit', 'abcdefgh!'],
    ['no special character', 'abcdefgh1'],
  ])('rejects a password with %s', (_label, raw) => {
    expect(() => Password.create(raw)).toThrow(InvalidPasswordError)
  })

  it('accepts exactly the minimum length', () => {
    const atMinimum = `aB1!${'x'.repeat(MIN_PASSWORD_LENGTH - 4)}`

    expect(Password.create(atMinimum).value).toBe(atMinimum)
  })
})

describe('Password serialization', () => {
  it('never leaks the plaintext through JSON', () => {
    // The `#` field is non-enumerable, so this holds even if someone logs the
    // whole object.
    expect(JSON.stringify(Password.create(VALID_PASSWORD))).toBe(EMPTY_SERIALIZATION)
  })
})
```

- [ ] **Step 7: Rode e confirme que falha**

```bash
pnpm test:unit
```

Esperado: FAIL — o módulo `password` não existe.

- [ ] **Step 8: Implemente o `Password`**

`src/modules/auth/value-objects/password.ts`:

```ts
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'

/** Policy: the business decides the floor. */
export const MIN_PASSWORD_LENGTH = 8
/** Ceiling so an attacker cannot make argon2 chew on a huge input. */
export const MAX_PASSWORD_LENGTH = 128

/**
 * Letter + digit + non-alphanumeric, in any order.
 *
 * One pattern rather than three `.regex()` calls: three of them emit
 * `INVALID_FORMAT` for all three rules and duplicate entries in the error
 * `details` when more than one fails, leaving the client unable to tell them
 * apart. Verified before this was written.
 *
 * The `s` flag is load-bearing: without it `.` never crosses a newline, and an
 * anchored lookahead would reject `"abc\n123!"` — a password that satisfies the
 * whole policy. A newline is a legitimate password character, like a space.
 *
 * Note: the generated OpenAPI publishes this as `pattern` WITHOUT the flag,
 * because JSON Schema has no notion of regex flags. The published pattern is
 * therefore slightly stricter than the server.
 */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/s

const TOO_SHORT_REASON = `must be at least ${MIN_PASSWORD_LENGTH} characters`
const TOO_LONG_REASON = `must be at most ${MAX_PASSWORD_LENGTH} characters`
const POLICY_REASON =
  'must contain at least one letter, one digit and one special character'

/**
 * Owns the password POLICY, holding the plaintext only in transit until the
 * application layer hashes it.
 *
 * The plaintext lives in a `#` field, which is non-enumerable:
 * `JSON.stringify(password)` is `{}`, so it cannot leak through logging or
 * serialization. The instance is frozen.
 *
 * Hashing is NOT this object's job — that is a technical capability, and it
 * lives behind `IHashProvider`. This owns the policy, and only the policy.
 */
export class Password {
  readonly #value: string

  private constructor(value: string) {
    this.#value = value
    Object.freeze(this)
  }

  static create(raw: string): Password {
    if (raw.length < MIN_PASSWORD_LENGTH) {
      throw new InvalidPasswordError(TOO_SHORT_REASON)
    }
    if (raw.length > MAX_PASSWORD_LENGTH) {
      throw new InvalidPasswordError(TOO_LONG_REASON)
    }
    if (!PASSWORD_POLICY_PATTERN.test(raw)) {
      throw new InvalidPasswordError(POLICY_REASON)
    }

    return new Password(raw)
  }

  get value(): string {
    return this.#value
  }
}
```

- [ ] **Step 9: Rode tudo**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/errors src/modules/auth/value-objects
git commit -m "feat: add Email and Password value objects"
```

---

## Task 3: Entidade `User`

**Files:**
- Create: `src/modules/auth/entities/user.ts`
- Create: `src/modules/auth/entities/user.spec.ts`

**Interfaces:**
- Consumes: `Email` de `#modules/auth/value-objects/email`.
- Produces:
  - `interface CreateUserProps { id: string; email: Email; passwordHash: string; now: Date }`
  - `class User` com `static create(props: CreateUserProps): User` e os getters
    `id: string`, `email: Email`, `passwordHash: string`, `emailVerifiedAt: Date | null`,
    `createdAt: Date`, `updatedAt: Date`.

> **Não existe `restore()` nesta fatia.** Nada lê usuário ainda — `findByEmail`
> chega com o login. Um método de reidratação sem consumidor seria código que N
> apps derivados copiam sem nunca testar.

- [ ] **Step 1: Escreva o teste**

`src/modules/auth/entities/user.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-26T12:00:00.000Z')
const EMPTY_SERIALIZATION = '{}'

function createUser() {
  return User.create({
    id: ID,
    email: Email.create(EMAIL),
    passwordHash: PASSWORD_HASH,
    now: NOW,
  })
}

describe('User.create', () => {
  it('uses the id it was given instead of generating one', () => {
    // R7: identity enters by contract. If the entity ever called
    // `randomUUID()` itself, this assertion is what fails.
    expect(createUser().id).toBe(ID)
  })

  it('uses the instant it was given for both timestamps', () => {
    const user = createUser()

    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })

  it('is born unverified', () => {
    expect(createUser().emailVerifiedAt).toBeNull()
  })

  it('keeps the email as a value object, not a string', () => {
    expect(createUser().email.value).toBe(EMAIL)
  })

  it('carries the hash it was given', () => {
    expect(createUser().passwordHash).toBe(PASSWORD_HASH)
  })
})

describe('User serialization', () => {
  it('never leaks the password hash through JSON', () => {
    // `#` fields are non-enumerable, so `reply.send(user)` or a stray
    // `log.info({ user })` cannot serialize the hash. This is the structural
    // half of the protection; REDACT_PATHS is the other half.
    expect(JSON.stringify(createUser())).toBe(EMPTY_SERIALIZATION)
  })
})
```

- [ ] **Step 2: Rode e confirme que falha**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm test:unit
```

Esperado: FAIL — o módulo `user` não existe.

- [ ] **Step 3: Implemente a entidade**

`src/modules/auth/entities/user.ts`:

```ts
import type { Email } from '#modules/auth/value-objects/email'

export interface CreateUserProps {
  id: string
  email: Email
  passwordHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

interface UserProps {
  id: string
  email: Email
  passwordHash: string
  emailVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * An application user's credentials.
 *
 * State lives in `#` private fields, which are genuinely private and
 * non-enumerable at runtime: `JSON.stringify(user)` yields `{}`, so the
 * password hash cannot escape through an accidental `reply.send(user)` or a
 * stray `log.info({ user })`.
 *
 * The entity does not know the shape of a database row — converting is
 * `infra/drizzle/user-mapper.ts`'s job (decision 20).
 */
export class User {
  readonly #id: string
  readonly #email: Email
  readonly #passwordHash: string
  readonly #emailVerifiedAt: Date | null
  readonly #createdAt: Date
  readonly #updatedAt: Date

  private constructor(props: UserProps) {
    this.#id = props.id
    this.#email = props.email
    this.#passwordHash = props.passwordHash
    this.#emailVerifiedAt = props.emailVerifiedAt
    this.#createdAt = props.createdAt
    this.#updatedAt = props.updatedAt
    Object.freeze(this)
  }

  /**
   * Born **unverified**. Nothing consumes that state until the email
   * verification slice; the column is a reserved seat, so that neither this
   * entity nor the mapper changes when it arrives.
   *
   * The domain owns the id and the timestamps, so the row is complete before
   * the insert. The schema defaults (`defaultRandom` / `defaultNow`) are only
   * defense-in-depth for direct writes: seeds, psql, data migrations.
   */
  static create(props: CreateUserProps): User {
    return new User({
      id: props.id,
      email: props.email,
      passwordHash: props.passwordHash,
      emailVerifiedAt: null,
      createdAt: props.now,
      updatedAt: props.now,
    })
  }

  get id(): string {
    return this.#id
  }

  get email(): Email {
    return this.#email
  }

  get passwordHash(): string {
    return this.#passwordHash
  }

  get emailVerifiedAt(): Date | null {
    return this.#emailVerifiedAt
  }

  get createdAt(): Date {
    return this.#createdAt
  }

  get updatedAt(): Date {
    return this.#updatedAt
  }
}
```

- [ ] **Step 4: Rode e confirme que passa**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/entities
git commit -m "feat: add the User entity with non-enumerable state"
```

---

## Task 4: Contratos, repositório in-memory e o use case

O coração da fatia. Aqui a camada pura fica completa e testável sem banco.

**Files:**
- Create: `src/modules/auth/errors/email-already-in-use-error.ts`
- Create: `src/modules/auth/repositories/users-repository.ts`
- Create: `src/modules/auth/providers/hash-provider.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-users-repository.ts`
- Create: `src/modules/auth/use-cases/register-user.ts`
- Create: `src/modules/auth/use-cases/register-user.spec.ts`

**Interfaces:**
- Consumes: `User`, `CreateUserProps`, `Email`, `Password`, `IClock`, `IIdGenerator`, `ConflictError`.
- Produces:
  - `class EmailAlreadyInUseError extends ConflictError` — `constructor()`, `code = 'EMAIL_ALREADY_IN_USE'`
  - `interface IUsersRepository { save(user: User): Promise<void> }`
  - `interface IHashProvider { hash(plain: string): Promise<string> }`
  - `class InMemoryUsersRepository implements IUsersRepository` — expõe `readonly users: User[]`
  - `interface RegisterUserCommand { email: string; password: string }`
  - `interface RegisterUserResult { id: string }`
  - `class RegisterUserUseCase` — `constructor(usersRepository: IUsersRepository, hashProvider: IHashProvider, clock: IClock, idGenerator: IIdGenerator)` e `execute(command: RegisterUserCommand): Promise<RegisterUserResult>`

> **Onde moram o command e o result.** No próprio arquivo do use case, não em
> `dtos/`. Eles são 1:1 com ele e mudam sempre junto — mesmo raciocínio da
> decisão 03 para rota e handler.

- [ ] **Step 1: Crie o erro e os dois contratos**

`src/modules/auth/errors/email-already-in-use-error.ts`:

```ts
import { ConflictError } from '#shared/errors/app-error'

const EMAIL_ALREADY_IN_USE_CODE = 'EMAIL_ALREADY_IN_USE'
const EMAIL_ALREADY_IN_USE_MESSAGE = 'Email already in use'

/**
 * The email is taken. Raised by the repository, which learns it from the
 * database's unique index rather than from a prior lookup — checking first
 * races.
 *
 * Accepted cost: answering 409 tells a caller the account exists. Without an
 * email provider there is no honest alternative, and the real mitigation is
 * rate limiting, which is still an open decision.
 */
export class EmailAlreadyInUseError extends ConflictError {
  readonly code = EMAIL_ALREADY_IN_USE_CODE

  constructor() {
    super(EMAIL_ALREADY_IN_USE_MESSAGE)
  }
}
```

`src/modules/auth/repositories/users-repository.ts`:

```ts
import type { User } from '#modules/auth/entities/user'

export interface IUsersRepository {
  /**
   * Persists a new user.
   *
   * Throws `EmailAlreadyInUseError` when the email is taken. The authority is
   * the database's unique index, not a prior query: checking and then inserting
   * races, and two simultaneous requests would both pass the check.
   *
   * Only `save` for now. `findByEmail` arrives with login, which is the first
   * thing that reads a user.
   */
  save(user: User): Promise<void>
}
```

`src/modules/auth/providers/hash-provider.ts`:

```ts
export interface IHashProvider {
  /** The result encodes its own parameters and salt. */
  hash(plain: string): Promise<string>
}
```

- [ ] **Step 2: Escreva o repositório in-memory**

`src/modules/auth/infra/in-memory/in-memory-users-repository.ts`:

```ts
import type { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It MUST behave like `DrizzleUsersRepository` on uniqueness, or the unit tests
 * lie. Since `Email.create` already lowercases, comparing values is enough —
 * there is no need to reimplement `lower()`.
 */
export class InMemoryUsersRepository implements IUsersRepository {
  readonly users: User[] = []

  async save(user: User): Promise<void> {
    const taken = this.users.some((existing) => existing.email.equals(user.email))
    if (taken) throw new EmailAlreadyInUseError()

    this.users.push(user)
  }
}
```

- [ ] **Step 3: Escreva o teste do use case**

`src/modules/auth/use-cases/register-user.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import { RegisterUserUseCase } from '#modules/auth/use-cases/register-user'
import type { IClock } from '#shared/providers/clock'
import type { IIdGenerator } from '#shared/providers/id-generator'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const NOW = new Date('2026-08-26T12:00:00.000Z')
const HASH_PREFIX = 'hashed:'

const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const PASSWORD = 'sup3r-s3cr3t!'
const INVALID_EMAIL = 'not-an-email'
const WEAK_PASSWORD = 'abcdefghij'

const USER_MISSING_MESSAGE = 'the repository stored no user'

// One-method ports do not deserve their own file: an object literal here keeps
// the double next to the assertions it serves, and out of `dist/`.
const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => ID }
const hashProvider: IHashProvider = {
  hash: (plain) => Promise.resolve(`${HASH_PREFIX}${plain}`),
}

let usersRepository: InMemoryUsersRepository
let useCase: RegisterUserUseCase

beforeEach(() => {
  usersRepository = new InMemoryUsersRepository()
  useCase = new RegisterUserUseCase(usersRepository, hashProvider, clock, idGenerator)
})

function storedUser() {
  const [user] = usersRepository.users
  if (user === undefined) throw new Error(USER_MISSING_MESSAGE)
  return user
}

describe('RegisterUserUseCase', () => {
  it('persists the user and returns its id', async () => {
    const result = await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(result).toEqual({ id: ID })
    expect(usersRepository.users).toHaveLength(1)
  })

  it('normalizes the email before storing it', async () => {
    await useCase.execute({ email: MIXED_CASE_EMAIL, password: PASSWORD })

    // Normalization is what makes the stored value match the functional unique
    // index on `lower(email)`.
    expect(storedUser().email.value).toBe(EMAIL)
  })

  it('stores the hash, never the plaintext', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })
    const user = storedUser()

    // R7: nothing in the pure layer produces these on its own.
    expect(user.id).toBe(ID)
    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })

  it('propagates the conflict when the email is taken', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    await expect(
      useCase.execute({ email: MIXED_CASE_EMAIL, password: PASSWORD }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)
  })

  it('rejects an invalid email before hashing anything', async () => {
    await expect(
      useCase.execute({ email: INVALID_EMAIL, password: PASSWORD }),
    ).rejects.toThrow()

    expect(usersRepository.users).toHaveLength(0)
  })

  it('rejects a password that breaks the policy', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WEAK_PASSWORD }),
    ).rejects.toThrow()

    expect(usersRepository.users).toHaveLength(0)
  })
})
```

- [ ] **Step 4: Rode e confirme que falha**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm test:unit
```

Esperado: FAIL — o módulo `register-user` não existe.

- [ ] **Step 5: Implemente o use case**

`src/modules/auth/use-cases/register-user.ts`:

```ts
import { User } from '#modules/auth/entities/user'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { Email } from '#modules/auth/value-objects/email'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/providers/clock'
import type { IIdGenerator } from '#shared/providers/id-generator'

/** Raw, untrusted input. The value objects validate it. */
export interface RegisterUserCommand {
  email: string
  password: string
}

export interface RegisterUserResult {
  id: string
}

/**
 * Creates an account. Pure orchestration: the policy lives in `Email` and
 * `Password`, uniqueness in the database index behind `IUsersRepository`, and
 * hashing behind `IHashProvider`.
 *
 * Issues no session tokens — login is a separate use case. Sends no
 * verification code either: that belongs to a dedicated endpoint, which has to
 * exist anyway for "resend". Keeping it out is what lets this use case survive
 * the email verification slice untouched.
 *
 * The order matters. Both value objects run before the hash, so a bad payload
 * never pays argon2's cost. The hash then runs before the insert, because the
 * row needs it.
 */
export class RegisterUserUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    const passwordHash = await this.hashProvider.hash(password.value)

    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now: this.clock.now(),
    })

    await this.usersRepository.save(user)

    return { id: user.id }
  }
}
```

- [ ] **Step 6: Rode tudo**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/errors src/modules/auth/repositories src/modules/auth/providers src/modules/auth/infra/in-memory src/modules/auth/use-cases
git commit -m "feat: add the register user use case and its ports"
```

---

## Task 5: Schema, constante do índice e a segunda migration

Duas mudanças no schema, e a ordem entre elas é o que prova uma delas. Extrair o
nome do índice para constante **não pode** gerar migration — se gerar, alguma coisa
está errada e é melhor descobrir antes de somar a coluna nova.

**Files:**
- Modify: `src/modules/auth/infra/drizzle/schema/users.ts`
- Create: `drizzle/<timestamp>_add_email_verified_at_to_users/` (gerado)
- Modify: `tests/integration/users-schema.spec.ts` (remove o teste `SCAFFOLDING`)
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: `const USERS_EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'` e a
  coluna `emailVerifiedAt` (nullable, `timestamptz`) em `#modules/auth/infra/drizzle/schema/users`.

- [ ] **Step 1: Extraia a constante do índice, sem tocar nas colunas**

Em `src/modules/auth/infra/drizzle/schema/users.ts`, acima do `export const users`:

```ts
/**
 * Exported because the repository reads it: it translates a `23505` carrying
 * THIS constraint into `EmailAlreadyInUseError`, and lets every other unique
 * violation bubble — the table's primary key raises `23505` too.
 *
 * The CLAUDE.md exception that lets schema files spell names inline justifies
 * itself by the name appearing exactly once. It no longer does.
 */
export const USERS_EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'
```

E troque o literal na declaração do índice:

```ts
  (table) => [
    uniqueIndex(USERS_EMAIL_LOWER_UNIQUE_INDEX).on(sql`lower(${table.email})`),
  ],
```

- [ ] **Step 2: Confirme que a extração não gera migration**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm db:generate
```

Esperado: `No schema changes, nothing to migrate`.

Se aparecer qualquer migration, **pare**: o valor mudou, e a diferença precisa ser
entendida antes de seguir. Apague a pasta gerada antes de investigar.

- [ ] **Step 3: Adicione a coluna `email_verified_at`**

No objeto de colunas de `users`, **depois** de `passwordHash` e antes de `createdAt`:

```ts
    /**
     * Null until the account is verified. A reserved seat: nothing reads it
     * until the email verification slice, and it is here now so that neither
     * the `User` entity nor `user-mapper.ts` changes when that lands.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
```

Nullable de propósito: sem `.notNull()` e sem default.

- [ ] **Step 4: Gere a migration, com nome**

```bash
pnpm db:generate --name add_email_verified_at_to_users
```

Esperado: uma pasta nova `drizzle/<timestamp>_add_email_verified_at_to_users/` com
`migration.sql` e `snapshot.json`.

- [ ] **Step 5: Inspecione o SQL gerado**

```bash
cat drizzle/*_add_email_verified_at_to_users/migration.sql
```

Esperado, exatamente uma instrução:

```sql
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
```

Se aparecer qualquer `DROP`, `CREATE TABLE` ou mexida no índice, **pare** — a
migration está errada e a R4 é forward-only: uma vez aplicada, não se corrige
editando.

- [ ] **Step 6: Aplique no banco de desenvolvimento**

```bash
pnpm db:migrate
```

- [ ] **Step 7: Remova o teste marcado `SCAFFOLDING`**

Em `tests/integration/users-schema.spec.ts`, apague o `it` cujo comentário começa
com `// SCAFFOLDING` — o de título `'stores a row and reads it back'` — junto com
esse comentário. Os outros dois `it` do arquivo ficam.

O substituto é o `drizzle-users-repository.spec.ts` da Task 6, que cobre o mesmo
round trip através de código real.

- [ ] **Step 8: Emende o `CLAUDE.md`**

Na seção `# No Magic Strings/Numbers`, no fim do bullet da exceção de schema,
acrescente:

```markdown
  A exceção cai quando o nome passa a ser **lido de outro arquivo** — como o nome
  de um índice de que o repositório precisa para distinguir qual constraint foi
  violada. Aí ele não aparece mais uma vez só, vira constante exportada, declarada
  e usada dentro do próprio arquivo de schema.
```

- [ ] **Step 9: Rode a suíte de integração**

```bash
docker compose up -d postgres-test
pnpm test:integration && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS. O `globalSetup` aplica a migration nova no banco de teste
automaticamente.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/infra/drizzle/schema/users.ts drizzle tests/integration/users-schema.spec.ts CLAUDE.md
git commit -m "feat: add email_verified_at and export the email index name"
```

---

## Task 6: Adapters de infra — mapper, repositório Drizzle e argon2

**Files:**
- Create: `src/modules/auth/infra/drizzle/user-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-users-repository.ts`
- Create: `src/modules/auth/infra/providers/argon2-hash-provider.ts`
- Create: `src/modules/auth/infra/providers/argon2-hash-provider.spec.ts`
- Create: `tests/integration/drizzle-users-repository.spec.ts`
- Modify: `package.json` (adiciona `@node-rs/argon2`)

**Interfaces:**
- Consumes: `User`, `Email`, `IUsersRepository`, `IHashProvider`, `EmailAlreadyInUseError`, `USERS_EMAIL_LOWER_UNIQUE_INDEX`, `Database` de `#infra/database/client`.
- Produces:
  - `const toPersistenceUser: (user: User) => typeof users.$inferInsert`
  - `class DrizzleUsersRepository implements IUsersRepository` — `constructor(db: Database)`
  - `class Argon2HashProvider implements IHashProvider`

- [ ] **Step 1: Instale o argon2, com pin exato**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm add --save-exact @node-rs/argon2@2.1.0
```

Confirme que o `package.json` ficou com `"@node-rs/argon2": "2.1.0"` — sem `^`.

- [ ] **Step 2: Escreva o teste do adapter argon2**

`src/modules/auth/infra/providers/argon2-hash-provider.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Argon2HashProvider } from '#modules/auth/infra/providers/argon2-hash-provider'

const PASSWORD = 'sup3r-s3cr3t!'
const ARGON2ID_PREFIX = '$argon2id$'

// Real argon2 work, roughly 100ms per call. Three calls is the whole cost.
describe('Argon2HashProvider', () => {
  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await new Argon2HashProvider().hash(PASSWORD)

    // The prefix is what pins the algorithm: the library's default is argon2id,
    // and the exact version pin is what freezes that default.
    expect(hash.startsWith(ARGON2ID_PREFIX)).toBe(true)
    expect(hash).not.toContain(PASSWORD)
  })

  it('salts, so the same password never hashes to the same string twice', async () => {
    const provider = new Argon2HashProvider()

    expect(await provider.hash(PASSWORD)).not.toBe(await provider.hash(PASSWORD))
  })
})
```

- [ ] **Step 3: Rode e confirme que falha**

```bash
pnpm test:unit
```

Esperado: FAIL — o módulo `argon2-hash-provider` não existe.

- [ ] **Step 4: Implemente o adapter argon2**

`src/modules/auth/infra/providers/argon2-hash-provider.ts`:

```ts
import { hash } from '@node-rs/argon2'
import type { IHashProvider } from '#modules/auth/providers/hash-provider'

/**
 * argon2id, through @node-rs/argon2's prebuilt Rust bindings — no node-gyp and
 * no C++ toolchain in Docker or CI, which is why it wins over the `argon2`
 * package.
 *
 * The library's default algorithm IS argon2id, and pinning the exact version
 * freezes that default: it cannot change without a bump we control.
 *
 * Cost parameters (memory, time, parallelism) stay at the library's defaults.
 * Tuning them belongs to hardening, once there is a target machine.
 */
export class Argon2HashProvider implements IHashProvider {
  hash(plain: string): Promise<string> {
    return hash(plain)
  }
}
```

- [ ] **Step 5: Rode e confirme que passa**

```bash
pnpm test:unit
```

Esperado: PASS.

- [ ] **Step 6: Escreva o mapper**

`src/modules/auth/infra/drizzle/user-mapper.ts`:

```ts
import type { User } from '#modules/auth/entities/user'
import type { users } from './schema/users.js'

type NewUserRow = typeof users.$inferInsert

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 *
 * One direction only, on purpose: nothing reads a user yet, so `toDomainUser`
 * would have no consumer. It arrives with login, exercised by `findByEmail`.
 */
export const toPersistenceUser = (user: User): NewUserRow => ({
  id: user.id,
  // Unwrapping the value object is infra's job, not the domain's.
  email: user.email.value,
  passwordHash: user.passwordHash,
  emailVerifiedAt: user.emailVerifiedAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})
```

- [ ] **Step 7: Escreva o teste de integração do repositório**

`tests/integration/drizzle-users-repository.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { DrizzleUsersRepository } from '#modules/auth/infra/drizzle/drizzle-users-repository'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const OTHER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const OTHER_EMAIL = 'maria@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-26T12:00:00.000Z')

const ROW_MISSING_MESSAGE = 'no row was stored'

let db: Database
let pool: Pool
let repository: DrizzleUsersRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = new DrizzleUsersRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(users)
})

function makeUser(id: string, email: string) {
  return User.create({
    id,
    email: Email.create(email),
    passwordHash: PASSWORD_HASH,
    now: NOW,
  })
}

describe('DrizzleUsersRepository.save', () => {
  it('writes a row that matches the entity field by field', async () => {
    await repository.save(makeUser(ID, EMAIL))

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    expect(row.id).toBe(ID)
    expect(row.email).toBe(EMAIL)
    expect(row.passwordHash).toBe(PASSWORD_HASH)
    expect(row.emailVerifiedAt).toBeNull()
    expect(row.createdAt).toEqual(NOW)
    expect(row.updatedAt).toEqual(NOW)
  })

  it('rejects an email that differs only by case', async () => {
    await repository.save(makeUser(ID, EMAIL))

    // The functional unique index on `lower(email)` is the authority.
    await expect(
      repository.save(makeUser(OTHER_ID, EMAIL_DIFFERING_ONLY_BY_CASE)),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)
  })

  it('lets a violation of another constraint bubble', async () => {
    await repository.save(makeUser(ID, EMAIL))

    // Same id, different email: this violates `users_pkey`, which raises 23505
    // just like the email index does. A repository that matched only the code
    // would report a primary key collision as "email already in use" — a 409
    // over what is really a 500.
    await expect(
      repository.save(makeUser(ID, OTHER_EMAIL)),
    ).rejects.not.toBeInstanceOf(EmailAlreadyInUseError)
  })
})
```

- [ ] **Step 8: Rode e confirme que falha**

```bash
docker compose up -d postgres-test
pnpm test:integration
```

Esperado: FAIL — o módulo `drizzle-users-repository` não existe.

- [ ] **Step 9: Implemente o repositório**

`src/modules/auth/infra/drizzle/drizzle-users-repository.ts`:

```ts
import type { Database } from '#infra/database/client'
import type { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { USERS_EMAIL_LOWER_UNIQUE_INDEX, users } from './schema/users.js'
import { toPersistenceUser } from './user-mapper.js'

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505'

/** The slice of the `pg` error that matters here. */
interface UniqueViolationCandidate {
  code?: unknown
  constraint?: unknown
}

/**
 * Walks the `cause` chain. Drizzle wraps the driver error in a
 * `DrizzleQueryError` whose `.message` is the query text plus every bound
 * parameter, not the query text alone — which is why it must go through
 * `error-serializer.ts` before it ever reaches a log; the `pg` error that
 * carries `.code` and `.constraint` lives in `.cause`.
 *
 * Matches the constraint NAME, not just the code. The table already has a
 * second unique constraint — its primary key — so an id collision raises 23505
 * as well, and matching the code alone would report it as "email already in
 * use".
 */
function isEmailAlreadyInUse(error: unknown): boolean {
  let current: unknown = error

  while (typeof current === 'object' && current !== null) {
    const candidate = current as UniqueViolationCandidate

    if (
      candidate.code === PG_UNIQUE_VIOLATION &&
      candidate.constraint === USERS_EMAIL_LOWER_UNIQUE_INDEX
    ) {
      return true
    }

    current = 'cause' in current ? current.cause : undefined
  }

  return false
}

export class DrizzleUsersRepository implements IUsersRepository {
  constructor(private readonly db: Database) {}

  async save(user: User): Promise<void> {
    try {
      // Insert and handle the violation, never check-then-insert: a prior
      // lookup races, and two simultaneous requests would both pass it.
      await this.db.insert(users).values(toPersistenceUser(user))
    } catch (error) {
      if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()
      throw error
    }
  }
}
```

- [ ] **Step 10: Rode tudo**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml src/modules/auth/infra tests/integration/drizzle-users-repository.spec.ts
git commit -m "feat: persist users through Drizzle with argon2id hashing"
```

---

## Task 7: HTTP, containers e a ligação no `buildApp`

A fatia vira alcançável. Aqui a decisão 23 estreia: o plugin do módulo recebe **só
a fatia dele** do container.

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/register.ts`
- Create: `src/modules/auth/infra/http/routes.ts`
- Create: `src/modules/auth/container.ts`
- Create: `src/main/container.ts`
- Modify: `src/main/app.ts`
- Create: `tests/integration/register.spec.ts`

**Interfaces:**
- Consumes: tudo das tasks anteriores, mais `buildServer`/`buildApp` e `errorResponseSchema` de `#infra/http/error-response`.
- Produces:
  - `function makeAuthContainer(db: Database)` e `type AuthContainer = ReturnType<typeof makeAuthContainer>`
  - `function makeContainer(db: Database)` e `type Container = ReturnType<typeof makeContainer>`
  - `const authRoutes: FastifyPluginAsync<{ container: AuthContainer }>`

- [ ] **Step 1: Escreva o teste de integração do endpoint**

`tests/integration/register.spec.ts`:

```ts
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the endpoint: these values ARE the wire
// contract. Importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const CREATED_STATUS_CODE = 201
const BAD_REQUEST_STATUS_CODE = 400
const CONFLICT_STATUS_CODE = 409

const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WEAK_PASSWORD = 'abcdefghij'

const EMAIL_ALREADY_IN_USE_CODE = 'EMAIL_ALREADY_IN_USE'
const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const PASSWORD_FIELD = 'password'
const ID_KEY = 'id'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ROW_MISSING_MESSAGE = 'no user row was stored'

let app: FastifyInstance
let db: Database
let pool: Pool
const logLines: string[] = []

beforeAll(async () => {
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk))
      callback()
    },
  })

  // The same function `main/http.ts` calls: whatever is composed there is
  // exercised here, with no second list to keep in sync by hand.
  app = await buildApp(env, { logStream })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  logLines.length = 0
  await db.delete(users)
})

function register(email: string, password: string) {
  return app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email, password },
  })
}

describe('POST /auth/register', () => {
  it('creates the account and answers 201 with its id', async () => {
    const response = await register(EMAIL, PASSWORD)

    expect(response.statusCode).toBe(CREATED_STATUS_CODE)
    expect(response.json()).toEqual({ id: expect.stringMatching(UUID_PATTERN) })
    // The response carries the id and nothing else: a wider body would be a
    // place for a field to leak into later.
    expect(Object.keys(response.json())).toEqual([ID_KEY])
  })

  it('answers 409 when the email is taken, ignoring case', async () => {
    await register(EMAIL, PASSWORD)

    const response = await register(EMAIL_DIFFERING_ONLY_BY_CASE, PASSWORD)

    expect(response.statusCode).toBe(CONFLICT_STATUS_CODE)
    expect(response.json()).toMatchObject({
      error: { code: EMAIL_ALREADY_IN_USE_CODE },
    })
  })

  it('answers 400 with a per-field detail when the password breaks the policy', async () => {
    const response = await register(EMAIL, WEAK_PASSWORD)

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
    expect(response.json()).toMatchObject({
      error: {
        code: VALIDATION_ERROR_CODE,
        details: [{ field: PASSWORD_FIELD }],
      },
    })
  })

  it('keeps the password and its hash out of the body and the log', async () => {
    const response = await register(EMAIL, PASSWORD)

    const [row] = await db.select().from(users)
    if (row === undefined) throw new Error(ROW_MISSING_MESSAGE)

    const log = logLines.join('')

    expect(response.body).not.toContain(PASSWORD)
    expect(log).not.toContain(PASSWORD)
    expect(response.body).not.toContain(row.passwordHash)
    expect(log).not.toContain(row.passwordHash)
  })
})
```

- [ ] **Step 2: Rode e confirme que falha**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
docker compose up -d postgres-test
pnpm test:integration
```

Esperado: FAIL — a rota não existe, então a resposta é 404.

- [ ] **Step 3: Escreva o container do módulo**

`src/modules/auth/container.ts`:

```ts
import type { Database } from '#infra/database/client'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import { DrizzleUsersRepository } from './infra/drizzle/drizzle-users-repository.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { RegisterUserUseCase } from './use-cases/register-user.js'

/**
 * The module's slice of the dependency graph. This file is `composition`: it is
 * the one place inside the module allowed to know concrete implementations —
 * that is the whole point of a composition root (decision 08).
 *
 * Stateless objects (repository, providers) are singletons here. Instantiating
 * a class costs nanoseconds against milliseconds of network and database, so
 * the cost is noise; the reason to avoid `new` in a handler was never
 * performance, it was coupling.
 */
export function makeAuthContainer(db: Database) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider = new Argon2HashProvider()
  const clock = new SystemClock()
  const idGenerator = new UuidIdGenerator()

  return {
    registerUser: new RegisterUserUseCase(
      usersRepository,
      hashProvider,
      clock,
      idGenerator,
    ),
  }
}

export type AuthContainer = ReturnType<typeof makeAuthContainer>
```

- [ ] **Step 4: Escreva o composition root**

`src/main/container.ts`:

```ts
import type { Database } from '#infra/database/client'
import { makeAuthContainer } from '#modules/auth/container'

/**
 * The whole dependency graph, built without Fastify. That independence is what
 * decision 10 requires: a worker and a cron share this graph and never see an
 * HTTP framework.
 *
 * No `env` parameter yet — no module declares configuration of its own so far.
 * It gains one when login brings `JWT_SECRET` (decision 14).
 */
export function makeContainer(db: Database) {
  return { auth: makeAuthContainer(db) }
}

export type Container = ReturnType<typeof makeContainer>
```

- [ ] **Step 5: Escreva o endpoint**

`src/modules/auth/infra/http/endpoints/register.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/error-response'
import type { AuthContainer } from '#modules/auth/container'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const REGISTER_PATH = '/register'
const AUTH_TAG = 'Auth'
const REGISTER_SUMMARY = 'Register a new account'
const REGISTER_DESCRIPTION =
  'Creates an account from an email and a password. Issues no session tokens: ' +
  'authenticate through the login endpoint afterwards.'

const CREATED_STATUS = 201
const BAD_REQUEST_STATUS = 400
const CONFLICT_STATUS = 409

/**
 * The limits come from the value objects, so the policy has exactly one
 * definition. Validating here as well as in the domain is deliberate: this is
 * what gives the client a 400 with a per-field `details` array, and what
 * publishes the policy in the OpenAPI document. The value objects are what
 * keep the use case safe for the non-HTTP entrypoints of decision 10.
 */
const bodySchema = z.object({
  email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .regex(PASSWORD_POLICY_PATTERN),
})

const createdSchema = z.object({ id: z.uuid() })

export const registerRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REGISTER_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: REGISTER_SUMMARY,
        description: REGISTER_DESCRIPTION,
        body: bodySchema,
        response: {
          [CREATED_STATUS]: createdSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [CONFLICT_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = await container.registerUser.execute(request.body)

      return reply.status(CREATED_STATUS).send({ id })
    },
  )
}
```

- [ ] **Step 6: Escreva o agregador de rotas**

`src/modules/auth/infra/http/routes.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { AuthContainer } from '#modules/auth/container'
import { registerRoute } from './endpoints/register.js'

/**
 * The module's HTTP surface. Thin by design: a new endpoint is a new file plus
 * one line here.
 *
 * It receives only the module's own slice of the container (decision 23), so
 * reaching another module's use case is a compile error rather than something
 * a lint rule has to catch.
 */
export const authRoutes: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  await app.register(registerRoute, { container })
}
```

- [ ] **Step 7: Ligue no `buildApp`**

Em `src/main/app.ts`, adicione aos imports:

```ts
import { authRoutes } from '#modules/auth/infra/http/routes'
import { makeContainer } from './container.js'
```

Adicione a constante logo após o bloco de imports, antes do JSDoc do `buildApp`
(o arquivo hoje não tem nenhuma constante de topo):

```ts
const AUTH_PREFIX = '/auth'
```

E, dentro de `buildApp`, **depois** do `await app.register(healthRoute, { db })` e
antes do `return app`:

```ts
  // The graph is built here, not in `http.ts`: `buildApp` is the composition
  // root the suites exercise, so anything wired here reaches the tests too.
  const container = makeContainer(db)

  await app.register(authRoutes, { prefix: AUTH_PREFIX, container: container.auth })
```

- [ ] **Step 8: Rode e confirme que passa**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Esperado: tudo PASS — unitários e integração.

- [ ] **Step 9: Confira a rota viva e o OpenAPI**

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Noutro terminal:

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"joao@example.com","password":"sup3r-s3cr3t!"}'
```

Esperado: `{"id":"<uuid>"}`. Repetir o mesmo comando deve devolver
`{"error":{"code":"EMAIL_ALREADY_IN_USE",...}}`.

Abra `http://localhost:3000/docs` e confirme que `POST /auth/register` aparece com
o schema de body e as respostas 201, 400 e 409. Encerre o `pnpm dev` depois.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/container.ts src/modules/auth/infra/http src/main tests/integration/register.spec.ts
git commit -m "feat: expose POST /auth/register through the module container"
```

---

## Task 8: Documentação

**Files:**
- Modify: `ARCHITECTURE.md` (versionado)
- Modify: `docs/DECISIONS.md` (**gitignored** — editar em disco, NÃO commitar)

> **Aviso que já custou tempo antes.** `docs/DECISIONS.md`, `docs/STRUCTURE.md` e
> `docs/TODO.md` estão no `.gitignore` (seção "Local docs for reference"). Edite-os
> em disco para referência local, mas **não os adicione ao commit**, e **não** use
> `git add -f`. O único documento vivo que viaja com o repositório é o
> `ARCHITECTURE.md` da raiz.

- [ ] **Step 1: Atualize a árvore do `ARCHITECTURE.md` §2**

No bloco ```` ```text ```` do §2, substitua o galho `modules/` inteiro — hoje são
as linhas de `├── modules/` até `│                   └── users.ts    # tabela ...`
— por:

```text
├── modules/
│   └── auth/                        # domínio + infra do módulo
│       ├── entities/user.ts         # puro — estado em campos `#`
│       ├── value-objects/           # puro — email.ts, password.ts
│       ├── repositories/            # SÓ contratos — users-repository.ts
│       ├── providers/               # SÓ contratos — hash-provider.ts
│       ├── use-cases/               # puro (+ .spec.ts colocado)
│       ├── errors/                  # um arquivo por erro do módulo
│       ├── container.ts             # factory do container do módulo
│       └── infra/                   # tudo que toca o mundo externo
│           ├── drizzle/
│           │   ├── schema/users.ts  # um arquivo por tabela, nomeado pela tabela
│           │   ├── user-mapper.ts   # entidade -> row (decisão 20)
│           │   └── drizzle-users-repository.ts
│           ├── in-memory/           # repositório de teste (decisão 09)
│           ├── providers/           # argon2-hash-provider.ts
│           └── http/
│               ├── endpoints/       # 1 arquivo = schema + handler + rota
│               │   └── register.ts  # POST /auth/register
│               └── routes.ts        # agregador fino do módulo
```

No galho `shared/`, acrescente depois de `errors/`:

```text
│   └── providers/                   # contratos transversais
│       ├── clock.ts                 # IClock — tempo entra por aqui (R7)
│       └── id-generator.ts          # IIdGenerator — identidade entra por aqui (R7)
```

No galho `infra/`, acrescente depois de `http/`:

```text
│   ├── providers/                   # adapters dos contratos transversais
│   │   ├── system-clock.ts
│   │   └── uuid-id-generator.ts
```

No galho `main/`, acrescente antes de `app.ts`:

```text
    ├── container.ts                 # composition root: junta os módulos
```

E em `tests/integration/`, acrescente `drizzle-users-repository.spec.ts` e
`register.spec.ts`.

- [ ] **Step 2: Corrija o parágrafo do §2 que ficou falso**

Logo abaixo do bloco da árvore, o texto atual diz:

> `src/modules/<m>/infra/` é a infra **daquele domínio**; hoje só `auth` existe, e
> só com o schema Drizzle da tabela `users` — sem domínio, use case ou endpoint
> ainda.

Substitua a partir de "hoje só `auth` existe" por:

```markdown
hoje só `auth` existe, e ele é o modelo completo: camada pura em `entities/`,
`value-objects/`, `use-cases/` e nos contratos de `repositories/` e `providers/`,
com os adapters — Drizzle, in-memory, argon2, HTTP — isolados sob `infra/`.
```

- [ ] **Step 3: Atualize o §13 do `ARCHITECTURE.md`**

Substitua a linha única da seção "O que ainda não existe":

```text
módulos de negócio · regra de fronteira no lint · Docker
```

por:

```text
login e verificação de e-mail · módulos de negócio · Unit of Work · `config.ts` de
módulo · entrypoints `worker.ts` e `cron.ts` · rate limiting · regra de fronteira
no lint · Docker
```

- [ ] **Step 4: Acrescente ao §6 do `ARCHITECTURE.md` a regra da constraint**

Depois do bloco sobre migrations, um novo bloco:

```markdown
### Violação de unicidade: case o nome da constraint, não só o código

O repositório traduz `23505` do Postgres para erro de domínio, mas **só quando a
`constraint` é a esperada**. A `users` já tem duas constraints únicas — o índice
de e-mail e a primary key —, e casar apenas o código transformaria uma colisão de
`id` num `409 EMAIL_ALREADY_IN_USE` sobre uma falha que é `500`.

O nome do índice é constante exportada do arquivo de schema, lida pelo
repositório. É a exceção à exceção de magic strings do `CLAUDE.md`: ela vale
enquanto o nome aparece uma vez só.

O erro do `pg` fica no `.cause`, não no topo — o Drizzle embrulha em
`DrizzleQueryError`. A `.message` dela **não** é só o texto da query: é o texto
mais todo parâmetro vinculado, incluindo o hash de senha quando o INSERT falha
— por isso o log passa por um serializer dedicado antes de sair. A checagem de
constraint anda a cadeia a partir da `cause`.
```

- [ ] **Step 5: Emende as decisões 20, 21 e 23 no `docs/DECISIONS.md` (local)**

Na **decisão 20**, acrescente um bloco confirmando-a, com o motivo novo: a entidade
usa campos `#` porque `JSON.stringify(user)` devolver `{}` é garantia de runtime, e
o `REDACT_PATHS` não cobria `passwordHash` (o redact do pino casa nome de chave
exato). Registre que a alternativa do byteflow — `toSnapshot()`/`fromSnapshot()` —
foi avaliada e perdeu porque a brevidade dela vem de deixar a row do Drizzle entrar
na camada pura.

Na **decisão 21**, acrescente um bloco `> **Emendada em 2026-08-26.**` registrando
que o `ITokenGenerator` foi partido: `IIdGenerator { generate() }` nasce agora e
`ITokenGenerator { opaque() }` fica para a fatia de refresh token, porque id de
entidade e segredo criptográfico têm perfis de segurança e motivos de mudar
diferentes. Registre também que o `IHashProvider` nasce só com `hash()`, e que
`compare()` chega com o login.

Na **decisão 23**, acrescente um bloco `> **Emendada em 2026-08-26.**` registrando
que o container é montado no `buildApp` e não no `main/http.ts`, porque o exemplo
original é anterior ao commit `748c41a`. Deixe explícito que a substância da
decisão fica intacta — o grafo continua independente de framework e o plugin
continua recebendo só a fatia dele.

- [ ] **Step 6: Confirme que só o `ARCHITECTURE.md` entra no commit**

```bash
git status --short
```

Esperado: `docs/DECISIONS.md` **não** deve aparecer. Se aparecer, o `.gitignore`
mudou e isso precisa ser resolvido antes de commitar.

- [ ] **Step 7: Rode a suíte inteira uma última vez**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Esperado: tudo PASS. O `pnpm build` importa: ele é o único passo que exercita a
condição `default` do mapa de `imports` — o caminho que produção usa.

- [ ] **Step 8: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: describe the auth module now that it exists"
```
