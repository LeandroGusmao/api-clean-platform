# Fatia 11 — Fechar o account pre-hijacking: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O cadastro para de escrever em `users`; a conta nasce na confirmação, com a senha fornecida no request de confirm, fechando o account pre-hijacking em ambos os sentidos de cadastro.

**Architecture:** `POST /auth/register` recebe só o e-mail e grava um `pending_registrations` (um código de uso único ligado a um endereço, sem senha). `POST /auth/email/verify` recebe e-mail + código + senha, cria a linha de `users` já verificada com aquela senha e abre a sessão. Vários pendentes por e-mail coexistem — são fungíveis, cada um é só prova de controle da caixa.

**Tech Stack:** TypeScript ESM, Fastify, Zod (`fastify-type-provider-zod`), Drizzle ORM 1.0.0-rc.4 + Postgres, Vitest (projetos `unit` / `integration`), argon2id, Mailpit (SMTP de teste).

**Spec:** [`docs/superpowers/specs/2026-09-06-account-pre-hijacking-design.md`](../specs/2026-09-06-account-pre-hijacking-design.md) — o plano argumenta a partir da spec; leia os dois.

## Global Constraints

Copiadas do `CLAUDE.md`, do `ARCHITECTURE.md` e da spec. Valem para **todas** as tasks.

- **Inglês** em todo código, string, log, comentário. Markdown pode ser português.
- **Sem magic string/number inline.** Extraia para constante nomeada `UPPER_SNAKE_CASE`, perto do uso ou em `constants.ts` se compartilhada. Exceção: nomes de tabela/coluna/índice em `src/modules/*/infra/drizzle/schema/*.ts` — mas um nome de índice **lido de outro arquivo** vira constante exportada no próprio schema.
- **Comentário explica o código, não a task.** Sem "a review achou", "a fatia 9 mudou", "medido, não assumido". Cite a spec (`§N`), não re-argumente.
- **R7 — camada pura não produz valor não determinístico.** `id` vem de `IIdGenerator`, instantes de `IClock`, aleatoriedade de `ITokenGenerator`. Vale inclusive quando o valor nasce dentro de uma entidade.
- **Fronteira:** `entities/`, `value-objects/`, `repositories/`, `ports/`, `use-cases/`, `services/`, `errors/`, `notifications/` e `config.ts` são `pure` — só importam `pure` e `#shared/**`. `infra/**` é `module-infra`. `container.ts` e `src/main/**` são `composition`. `*.spec.ts` e `in-memory/**` são `test`.
- **Unit of Work §8:** nada de I/O externo (e-mail, SMTP), trabalho pesado de CPU (argon2) ou escrita que precisa sobreviver a falha (contador de força bruta) **dentro** do callback do `uow`. Um use case que recebe `uow` **não** recebe repositório direto — tudo que o callback escreve vem do `repos` que ele recebe.
- **Unit of Work §9:** um `Pick` de repositório injetado só expõe o que o use case usa; um **write** no `Pick` (ex. `registerFailedAttempt`) é permitido só quando a §8 o coloca fora da transação.
- **Repositório insere e trata a violação** (`23505` pelo **nome** da constraint), nunca consulta-e-insere.
- **Nunca re-lançar o erro cru do driver.** `toPersistenceError(error)` em todo `catch` de repositório — o erro do Drizzle concatena os parâmetros vinculados (inclui digests e hashes) na mensagem.
- **Imports:** subpath `#…`, extensão `.js` nos relativos.
- **Data em schema de resposta** é `z.date()` (nunca `z.iso.datetime()`).
- **Endpoint declara todo status que ele mesmo produz** — e só esses.
- **TDD:** teste que falha → rodar e ver falhar → implementação mínima → rodar e ver passar → commit. Um passo = uma ação (2–5 min).
- **Falsificação:** `toEqual` no log de chamadas inteiro (mata deleção, reordenação, realocação), nunca `toContain`. A **deleção** de um comportamento antigo ganha teste antes da troca.
- **Portões, cada um sozinho** (nunca em pipe): `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration`. Filtro de unit: `pnpm vitest run --project unit <arquivo>` (o `pnpm test:unit -- <arquivo>` **não filtra**).
- **`docker compose up -d`** sobe Postgres (5432), Postgres de teste (5433, tmpfs) e Mailpit (1025 SMTP, 8025 HTTP). Migrations do teste rodam no `globalSetup` a cada `pnpm test:integration`.
- **Modelo de escalação (CLAUDE.md):** se o mesmo erro sobreviver a 3 tentativas, ou o mesmo arquivo for reescrito 2×, ou o mesmo comando falhar 4× igual — pare, diga qual gatilho disparou e o último estado bom, e ofereça `/model opus` ou o agente `opus-escalation`.

---

## Estrutura de arquivos

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `src/modules/auth/infra/drizzle/schema/pending-registrations.ts` | Declaração da tabela `pending_registrations` |
| `src/modules/auth/entities/pending-registration.ts` | Entidade pura: código + tentativas + janelas, congelada, `#` privados |
| `src/modules/auth/entities/pending-registration.spec.ts` | Unit da entidade |
| `src/modules/auth/repositories/pending-registrations-repository.ts` | Contrato `IPendingRegistrationsRepository` |
| `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts` | Adapter Drizzle |
| `src/modules/auth/infra/drizzle/pending-registration-mapper.ts` | Entidade ↔ row |
| `src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts` | Dublê para unit das use cases |
| `tests/integration/pending-registrations-schema.spec.ts` | Colunas, índices, ausência de defaults e de unique |
| `tests/integration/drizzle-pending-registrations-repository.spec.ts` | Atomicidade de `consume`/`registerFailedAttempt`, ordenação, `reissueCode`, prune |
| `drizzle/<timestamp>_create_pending_registrations/` | Migration (gerada) |

**Modificar:**

| Arquivo | Mudança |
|---|---|
| `src/modules/auth/entities/user.ts` | `User.create` nasce verificado (`emailVerifiedAt: props.now`) |
| `src/modules/auth/entities/user.spec.ts` | Ajusta a asserção de "nasce não verificado" |
| `src/modules/auth/services/email-verification-issuer.ts` | Novo `issue(email)`; `issueFor` removido na Task 8 |
| `src/modules/auth/services/email-verification-issuer.spec.ts` | Testes do `issue`; testes do `issueFor` removidos na Task 8 |
| `src/modules/auth/use-cases/register-user.ts` | Command `{ email }`; usa `issue` + `pendingRegistrations`; sem `uow`/`hashProvider` |
| `src/modules/auth/use-cases/register-user.spec.ts` | Reescrito |
| `src/modules/auth/use-cases/confirm-email.ts` | Command ganha `password`; cria a conta; `pendingRegistrations` |
| `src/modules/auth/use-cases/confirm-email.spec.ts` | Reescrito |
| `src/modules/auth/use-cases/request-email-verification.ts` | `pendingRegistrations` + `issue`; sem `uow` |
| `src/modules/auth/use-cases/request-email-verification.spec.ts` | Reescrito |
| `src/modules/auth/repositories/unit-of-work.ts` | `AuthRepos.emailVerifications` → `pendingRegistrations` |
| `src/modules/auth/infra/drizzle/auth-repositories.ts` | Constrói `DrizzlePendingRegistrationsRepository` |
| `src/modules/auth/container.ts` | Fiação dos 3 use cases + issuer + repo |
| `src/modules/auth/infra/http/endpoints/register.ts` | Body `z.object({ email }).strict()`; sem `503`; descrição |
| `src/modules/auth/infra/http/endpoints/confirm-email.ts` | Body ganha `password`; descrição |
| `src/modules/auth/infra/http/endpoints/resend-verification.ts` | Sem `503`; comentário de rate limit |
| `src/modules/auth/repositories/users-repository.ts` | Remove `markEmailVerified` (Task 8) |
| `src/modules/auth/infra/drizzle/drizzle-users-repository.ts` | Remove `markEmailVerified` (Task 8) |
| `src/modules/auth/infra/in-memory/in-memory-users-repository.ts` | Remove `markEmailVerified` (Task 8) |
| `tests/integration/verify-email.spec.ts` | Reescrito ao longo das Tasks 6–7 |
| `tests/integration/register.spec.ts` | Body `{ email }`, pendente em vez de user, sem `503` |
| `docs/DECISIONS.md` | Decisões novas: exceção a R4, 4.3-sobre-4.1, quebra de contrato |

**Deletar (Task 8):**

`entities/email-verification.ts` + `.spec.ts` · `repositories/email-verifications-repository.ts` · `infra/drizzle/drizzle-email-verifications-repository.ts` · `infra/drizzle/email-verification-mapper.ts` · `infra/drizzle/schema/email-verification-tokens.ts` · `infra/in-memory/in-memory-email-verifications-repository.ts` · `tests/integration/drizzle-email-verifications-repository.spec.ts` · `tests/integration/email-verification-tokens-schema.spec.ts` · a pasta de migration `drizzle/20260904014721_create_email_verification_tokens_table/`.

---

## Task 1: Tabela `pending_registrations` e migration

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/pending-registrations.ts`
- Create: `tests/integration/pending-registrations-schema.spec.ts`
- Create: `drizzle/<timestamp>_create_pending_registrations/` (gerada por `pnpm db:generate`)

**Interfaces:**
- Produces: `pendingRegistrations` (Drizzle `pgTable`) com colunas `id, email, code_hash, attempts, code_issued_at, expires_at, consumed_at, created_at`; índices `pending_registrations_email_lower_idx` e `pending_registrations_active_idx` (parcial, `WHERE consumed_at IS NULL`), ambos sobre `lower(email)`.

- [ ] **Step 1: Escrever o schema**

`src/modules/auth/infra/drizzle/schema/pending-registrations.ts`:

```ts
import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * A single-use six-digit code proving control of an email address, minted
 * before any `users` row exists. The account is created when a code here is
 * redeemed together with a chosen password (§1 of the slice 11 design), so
 * this table carries NO password: whoever completes confirmation picks it.
 *
 * NO column defaults, exactly as in `refresh-tokens.ts`: every timestamp comes
 * from `IClock` and both sides of every instant comparison share a source.
 * `attempts` is explicit for the same reason — the entity owns the value.
 *
 * NO foreign key: there is no user row to point at yet. NO unique index on
 * `email`: several pending registrations for one address coexist by design,
 * and that fungibility is what closes the pre-hijacking in both orderings. NO
 * unique index on `code_hash`: six digits collide by design, and every lookup
 * is by `lower(email)`.
 *
 * `code_issued_at` moves on every reissue (§4.2); `created_at` is immutable and
 * only for pruning order and audit. `consumed_at` marks BOTH "redeemed by a
 * confirm" and "superseded by a reissue"; nothing downstream reads the
 * difference.
 */
export const pendingRegistrations = pgTable(
  'pending_registrations',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    /** sha256 of the six-digit code. Never the code itself. */
    codeHash: text('code_hash').notNull(),
    /** Wrong guesses so far. The use case caps it; that cap is what makes six digits safe. */
    attempts: integer('attempts').notNull(),
    codeIssuedAt: timestamp('code_issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The prune path — `deleteExpiredByEmail` — needs consumed rows too, so it
    // cannot use the partial index below. Expiry is filtered at query time and
    // NOT in a predicate here: a partial index predicate must be IMMUTABLE, and
    // `now()` is not.
    index('pending_registrations_email_lower_idx').on(sql`lower(${table.email})`),
    // The hot lookups — `findUnconsumedByEmail`, the register cooldown, the
    // resend target.
    index('pending_registrations_active_idx')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.consumedAt} is null`),
  ],
)
```

- [ ] **Step 2: Gerar a migration**

```bash
docker compose up -d
pnpm db:generate --name create_pending_registrations
```

Expected: cria `drizzle/<timestamp>_create_pending_registrations/migration.sql` com `CREATE TABLE "pending_registrations"` (8 colunas, nenhuma com `DEFAULT`), `CREATE INDEX "pending_registrations_email_lower_idx" ... (lower("email"))` e `CREATE INDEX "pending_registrations_active_idx" ... (lower("email")) WHERE "consumed_at" is null`. Sem `FOREIGN KEY`, sem `UNIQUE`.

- [ ] **Step 3: Aplicar no banco local**

```bash
pnpm db:migrate
```

Expected: `pending_registrations` criada, sem erro.

- [ ] **Step 4: Escrever o teste de schema (falha)**

`tests/integration/pending-registrations-schema.spec.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological.
const TABLE_NAME = 'pending_registrations'
const EMAIL_LOWER_INDEX = 'pending_registrations_email_lower_idx'
const ACTIVE_INDEX = 'pending_registrations_active_idx'
const ACTIVE_INDEX_PREDICATE = 'WHERE (consumed_at IS NULL)'
const LOWER_EXPRESSION = 'lower(email)'
const NOT_NULL_VIOLATION = '23502'

const HASH_LENGTH = 64
const CODE_HASH = 'a'.repeat(HASH_LENGTH)
const EMAIL = 'joao@example.com'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CODE_ISSUED_AT = new Date('2026-09-07T00:00:00.000Z')
const EXPIRES_AT = new Date('2026-09-07T00:15:00.000Z')
const CREATED_AT = new Date('2026-09-07T00:00:00.000Z')
const ZERO_ATTEMPTS = 0

const ONE_INDEX = 1
const TWO_ROWS = 2

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(pendingRegistrations)
})

const row = (overrides: Partial<typeof pendingRegistrations.$inferInsert> = {}) => ({
  id: ROW_ID,
  email: EMAIL,
  codeHash: CODE_HASH,
  attempts: ZERO_ATTEMPTS,
  codeIssuedAt: CODE_ISSUED_AT,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('pending_registrations table', () => {
  it('stores a row with all eight columns', async () => {
    await db.insert(pendingRegistrations).values(row())

    const [stored] = await db.select().from(pendingRegistrations)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.email).toBe(EMAIL)
    expect(stored?.codeHash).toBe(CODE_HASH)
    expect(stored?.attempts).toBe(ZERO_ATTEMPTS)
    expect(stored?.codeIssuedAt).toEqual(CODE_ISSUED_AT)
    expect(stored?.expiresAt).toEqual(EXPIRES_AT)
    expect(stored?.consumedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without attempts, proving there is no default', async () => {
    const { attempts: _attempts, ...withoutAttempts } = row()

    await expect(
      db.insert(pendingRegistrations).values(withoutAttempts as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('accepts several coexisting rows for the same email', async () => {
    // Fungible pendings for one address is the whole design: the table must not
    // enforce uniqueness on `email`.
    await db.insert(pendingRegistrations).values(row())
    await db.insert(pendingRegistrations).values(row({ id: OTHER_ROW_ID }))

    expect(await db.select().from(pendingRegistrations)).toHaveLength(TWO_ROWS)
  })

  it('carries the plain lower(email) index and the partial active index', async () => {
    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
      indexdef: string
    }>

    const emailLower = rows.filter((r) => r.indexname === EMAIL_LOWER_INDEX)
    const active = rows.filter((r) => r.indexname === ACTIVE_INDEX)

    expect(emailLower).toHaveLength(ONE_INDEX)
    expect(emailLower[0]?.indexdef).toContain(LOWER_EXPRESSION)
    expect(active).toHaveLength(ONE_INDEX)
    expect(active[0]?.indexdef).toContain(LOWER_EXPRESSION)
    expect(active[0]?.indexdef).toContain(ACTIVE_INDEX_PREDICATE)
  })
})
```

- [ ] **Step 5: Rodar e ver falhar**

Run: `pnpm test:integration`
Expected: se a Step 3 foi feita, o `globalSetup` já aplicou a migration e o teste **passa** — nesse caso pule para a Step 6. Se falhar por tabela ausente, confirme que a pasta de migration foi commitada e que `docker compose` está de pé.

- [ ] **Step 6: Rodar os portões**

Run: `pnpm lint` — Expected: PASS
Run: `pnpm typecheck` — Expected: PASS
Run: `pnpm test:integration` — Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/drizzle/schema/pending-registrations.ts \
        tests/integration/pending-registrations-schema.spec.ts \
        drizzle/
git commit -m "feat(auth): add the pending_registrations table"
```

---

## Task 2: Entidade `PendingRegistration`

**Files:**
- Create: `src/modules/auth/entities/pending-registration.ts`
- Create: `src/modules/auth/entities/pending-registration.spec.ts`

**Interfaces:**
- Consumes: `Email` de `#modules/auth/value-objects/email`.
- Produces:
  - `PendingRegistration.create(props: { id: string; email: Email; codeHash: string; now: Date; ttlSeconds: number }): PendingRegistration`
  - `PendingRegistration.fromTrusted(props: { id: string; email: Email; codeHash: string; attempts: number; codeIssuedAt: Date; expiresAt: Date; consumedAt: Date | null; createdAt: Date }): PendingRegistration`
  - `isUsable(maxAttempts: number, now: Date): boolean`
  - `matches(codeHash: string): boolean`
  - getters: `id: string`, `email: Email`, `codeHash: string`, `attempts: number`, `codeIssuedAt: Date`, `expiresAt: Date`, `consumedAt: Date | null`, `createdAt: Date`

- [ ] **Step 1: Escrever os testes (falha)**

`src/modules/auth/entities/pending-registration.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { Email } from '#modules/auth/value-objects/email'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const CODE_HASH = 'digest:123456'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 900
const MILLISECONDS_PER_SECOND = 1000
const MAX_ATTEMPTS = 5
const NO_ATTEMPTS = 0

const email = Email.create(EMAIL)

const fresh = () =>
  PendingRegistration.create({ id: ID, email, codeHash: CODE_HASH, now: NOW, ttlSeconds: TTL_SECONDS })

describe('PendingRegistration.create', () => {
  it('is born unconsumed, with no attempts, and stamps both timestamps from the clock', () => {
    const pending = fresh()

    expect(pending.id).toBe(ID)
    expect(pending.email.value).toBe(EMAIL)
    expect(pending.codeHash).toBe(CODE_HASH)
    expect(pending.attempts).toBe(NO_ATTEMPTS)
    expect(pending.consumedAt).toBeNull()
    expect(pending.codeIssuedAt).toEqual(NOW)
    expect(pending.createdAt).toEqual(NOW)
    expect(pending.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('yields {} under JSON.stringify, so the code digest cannot leak', () => {
    expect(JSON.stringify(fresh())).toBe('{}')
  })

  it('hands out copies of its dates, not the internal instances', () => {
    const pending = fresh()
    pending.expiresAt.setFullYear(1970)

    expect(pending.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })
})

describe('PendingRegistration.isUsable', () => {
  const at = (ageMs: number, attempts: number) =>
    PendingRegistration.fromTrusted({
      id: ID,
      email,
      codeHash: CODE_HASH,
      attempts,
      codeIssuedAt: new Date(NOW.getTime() - ageMs),
      expiresAt: new Date(NOW.getTime() - ageMs + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: new Date(NOW.getTime() - ageMs),
    })

  it('is usable when unconsumed, unexpired and under the cap', () => {
    expect(at(0, NO_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })

  it('is not usable once the expiry instant has arrived (inclusive boundary)', () => {
    expect(at(TTL_SECONDS * MILLISECONDS_PER_SECOND, NO_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW)).toBe(
      false,
    )
  })

  it('is not usable once attempts reach the cap', () => {
    expect(at(0, MAX_ATTEMPTS).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is not usable once consumed', () => {
    const consumed = PendingRegistration.fromTrusted({
      id: ID,
      email,
      codeHash: CODE_HASH,
      attempts: NO_ATTEMPTS,
      codeIssuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: NOW,
      createdAt: NOW,
    })

    expect(consumed.isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })
})

describe('PendingRegistration.matches', () => {
  it('compares the given digest against the stored one', () => {
    expect(fresh().matches(CODE_HASH)).toBe(true)
    expect(fresh().matches('digest:000000')).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/entities/pending-registration.spec.ts`
Expected: FAIL — `Cannot find module '.../pending-registration'`.

- [ ] **Step 3: Escrever a entidade**

`src/modules/auth/entities/pending-registration.ts` — espelha `entities/email-verification.ts`:

```ts
import type { Email } from '#modules/auth/value-objects/email'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — the same reasoning as in `email-verification.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreatePendingRegistrationProps {
  id: string
  email: Email
  /** The digest, never the raw code. See `ITokenDigest`. */
  codeHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedPendingRegistrationProps {
  id: string
  email: Email
  codeHash: string
  attempts: number
  codeIssuedAt: Date
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

/**
 * One outstanding six-digit code minted for an email address before any account
 * exists (§1 of the slice 11 design). It carries NO password: the account's
 * password is chosen at confirmation, which is what makes coexisting pendings
 * fungible and closes the pre-hijacking.
 *
 * State lives in `#` private fields, non-enumerable at runtime:
 * `JSON.stringify(pending)` yields `{}`, so the digest cannot escape through an
 * accidental `reply.send(pending)` or a stray `log.info({ pending })`.
 */
export class PendingRegistration {
  readonly #id: string
  readonly #email: Email
  readonly #codeHash: string
  readonly #attempts: number
  readonly #codeIssuedAt: Date
  readonly #expiresAt: Date
  readonly #consumedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedPendingRegistrationProps) {
    this.#id = props.id
    this.#email = props.email
    this.#codeHash = props.codeHash
    this.#attempts = props.attempts
    this.#codeIssuedAt = cloneDate(props.codeIssuedAt)
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#consumedAt = cloneNullableDate(props.consumedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born unconsumed and with no attempts spent. `expiresAt` is derived from the
   * injected clock, not a column default: Postgres stores `timestamptz` in
   * microseconds while a JS `Date` has milliseconds, and `isUsable` compares
   * instants — both sides must come from the same source.
   */
  static create(props: CreatePendingRegistrationProps): PendingRegistration {
    const NO_ATTEMPTS_SPENT = 0

    return new PendingRegistration({
      id: props.id,
      email: props.email,
      codeHash: props.codeHash,
      attempts: NO_ATTEMPTS_SPENT,
      codeIssuedAt: props.now,
      expiresAt: new Date(props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedPendingRegistrationProps): PendingRegistration {
    return new PendingRegistration(props)
  }

  /**
   * Usable = not consumed, not expired, and under the attempt cap. Inclusive at
   * the expiry boundary, like `EmailVerification.isUsable`: an instant that has
   * arrived is spent.
   */
  isUsable(maxAttempts: number, now: Date): boolean {
    return (
      this.#consumedAt === null &&
      this.#expiresAt.getTime() > now.getTime() &&
      this.#attempts < maxAttempts
    )
  }

  /**
   * Takes the DIGEST, never the raw code — hashing is `ITokenDigest`'s job. A
   * plain comparison, not `timingSafeEqual`: what is compared here are two
   * digests, not two secrets, and each wrong guess burns one of the five.
   */
  matches(codeHash: string): boolean {
    return codeHash === this.#codeHash
  }

  get id(): string {
    return this.#id
  }

  get email(): Email {
    return this.#email
  }

  get codeHash(): string {
    return this.#codeHash
  }

  get attempts(): number {
    return this.#attempts
  }

  get codeIssuedAt(): Date {
    return cloneDate(this.#codeIssuedAt)
  }

  get expiresAt(): Date {
    return cloneDate(this.#expiresAt)
  }

  get consumedAt(): Date | null {
    return cloneNullableDate(this.#consumedAt)
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/entities/pending-registration.spec.ts`
Expected: PASS (todos).

- [ ] **Step 5: Portões**

Run: `pnpm lint` — PASS · `pnpm typecheck` — PASS · `pnpm test:unit` — PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/entities/pending-registration.ts \
        src/modules/auth/entities/pending-registration.spec.ts
git commit -m "feat(auth): add the PendingRegistration entity"
```

---

## Task 3: Contrato, adapter Drizzle, mapper e dublê in-memory do repositório

**Files:**
- Create: `src/modules/auth/repositories/pending-registrations-repository.ts`
- Create: `src/modules/auth/infra/drizzle/pending-registration-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts`
- Create: `tests/integration/drizzle-pending-registrations-repository.spec.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts`
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Modify: `src/modules/auth/container.ts`

**Interfaces:**
- Consumes: `PendingRegistration` (Task 2), `pendingRegistrations` schema (Task 1), `Email`, `Database` de `#infra/database/client`, `toPersistenceError` de `#infra/database/driver-error`.
- Produces: `IPendingRegistrationsRepository` com
  - `save(pending: PendingRegistration): Promise<void>`
  - `findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]>` — ordenado `code_issued_at DESC`, sem filtrar expiry/attempts
  - `reissueCode(id: string, codeHash: string, codeIssuedAt: Date, expiresAt: Date): Promise<void>`
  - `registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean>`
  - `consume(id: string, at: Date): Promise<boolean>`
  - `deleteExpiredByEmail(email: Email, now: Date): Promise<void>`
- Produces: `AuthRepos.pendingRegistrations: IPendingRegistrationsRepository` (adicionado **ao lado** de `emailVerifications`, que continua nesta task).
- Produces: `authRepositories(db)` retorna `{ users, refreshTokens, emailVerifications, pendingRegistrations }`.

- [ ] **Step 1: Escrever o contrato**

`src/modules/auth/repositories/pending-registrations-repository.ts`:

```ts
import type { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { Email } from '#modules/auth/value-objects/email'

export interface IPendingRegistrationsRepository {
  /** Plain insert. Coexisting rows for one email are legal, so there is no violation to translate. */
  save(pending: PendingRegistration): Promise<void>

  /**
   * Every unconsumed row for this email, most recent first (`code_issued_at
   * DESC`). Deliberately does NOT filter expiry or the attempt cap in SQL:
   * whether a code is still usable is the entity's judgement against the
   * injected `IClock`, and the use case filters with `isUsable`.
   *
   * ALWAYS by `lower(email)`. A lookup by `code_hash` would let one address's
   * code redeem another's, since six digits collide by design.
   */
  findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]>

  /**
   * Mints a fresh code onto an existing pending row: `UPDATE ... SET code_hash =
   * ?, attempts = 0, code_issued_at = ?, expires_at = ? WHERE id = ? AND
   * consumed_at IS NULL`. `created_at` is untouched. `expiresAt` is passed
   * ready-made — it is `IClock` + ttl arithmetic, which the use case does.
   */
  reissueCode(id: string, codeHash: string, codeIssuedAt: Date, expiresAt: Date): Promise<void>

  /**
   * Records one wrong guess, but only if the cap has not been spent: `UPDATE ...
   * SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND
   * attempts < ?`. Returns whether THIS call is the one that incremented — the
   * conditional `UPDATE`, serialized by Postgres's row lock, is what keeps the
   * cap race-proof under concurrency.
   *
   * Called OUTSIDE any transaction (§8 line 3): inside one that rolls back, the
   * brute-force counter would be erased exactly when it matters.
   */
  registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean>

  /**
   * Burns the code: `UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at
   * IS NULL`. Returns whether THIS call is the one that burned it — of two
   * concurrent confirms redeeming the same code, one loses the conditional
   * update and the caller turns that into the same generic failure as every
   * other.
   */
  consume(id: string, at: Date): Promise<boolean>

  /**
   * Opportunistic prune: `DELETE ... WHERE lower(email) = ? AND (expires_at <= ?
   * OR consumed_at IS NOT NULL)`. Never touches a live, unconsumed row — the one
   * a concurrent confirm may be about to consume does not match the `WHERE`.
   */
  deleteExpiredByEmail(email: Email, now: Date): Promise<void>
}
```

- [ ] **Step 2: Escrever o mapper**

`src/modules/auth/infra/drizzle/pending-registration-mapper.ts` — espelha `user-mapper.ts`:

```ts
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { Email } from '#modules/auth/value-objects/email'
import type { pendingRegistrations } from './schema/pending-registrations.js'

type NewPendingRegistrationRow = typeof pendingRegistrations.$inferInsert
type PendingRegistrationRow = typeof pendingRegistrations.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 */
export const toPersistencePendingRegistration = (
  pending: PendingRegistration,
): NewPendingRegistrationRow => ({
  id: pending.id,
  // Unwrapping the value object is infra's job, not the domain's.
  email: pending.email.value,
  codeHash: pending.codeHash,
  attempts: pending.attempts,
  codeIssuedAt: pending.codeIssuedAt,
  expiresAt: pending.expiresAt,
  consumedAt: pending.consumedAt,
  createdAt: pending.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `PendingRegistration.fromTrusted`. */
export const toDomainPendingRegistration = (
  row: PendingRegistrationRow,
): PendingRegistration =>
  PendingRegistration.fromTrusted({
    id: row.id,
    email: Email.fromTrusted(row.email),
    codeHash: row.codeHash,
    attempts: row.attempts,
    codeIssuedAt: row.codeIssuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  })
```

- [ ] **Step 3: Escrever o adapter Drizzle**

`src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts` — espelha `drizzle-email-verifications-repository.ts`:

```ts
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { Email } from '#modules/auth/value-objects/email'
import {
  toDomainPendingRegistration,
  toPersistencePendingRegistration,
} from './pending-registration-mapper.js'
import { pendingRegistrations } from './schema/pending-registrations.js'

/** How many rows a conditional `UPDATE` affected when nothing matched its `WHERE`. */
const NO_ROW_AFFECTED = 0

const ONE_INCREMENT = 1

export class DrizzlePendingRegistrationsRepository
  implements IPendingRegistrationsRepository
{
  constructor(private readonly db: Database) {}

  async save(pending: PendingRegistration): Promise<void> {
    try {
      await this.db
        .insert(pendingRegistrations)
        .values(toPersistencePendingRegistration(pending))
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the digest.
      throw toPersistenceError(error)
    }
  }

  async findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]> {
    // `lower(email)` on the left aligns the expression with the functional
    // index, the same way `DrizzleUsersRepository.findByEmail` does. Ordered
    // `code_issued_at DESC` so the caller's `[0]` is the freshest live code.
    const rows = await this.db
      .select()
      .from(pendingRegistrations)
      .where(
        and(
          sql`lower(${pendingRegistrations.email}) = ${email.value}`,
          isNull(pendingRegistrations.consumedAt),
        ),
      )
      .orderBy(desc(pendingRegistrations.codeIssuedAt))

    return rows.map(toDomainPendingRegistration)
  }

  async reissueCode(
    id: string,
    codeHash: string,
    codeIssuedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    try {
      await this.db
        .update(pendingRegistrations)
        .set({ codeHash, attempts: NO_ROW_AFFECTED, codeIssuedAt, expiresAt })
        .where(
          and(eq(pendingRegistrations.id, id), isNull(pendingRegistrations.consumedAt)),
        )
    } catch (error) {
      // Same reason as `save`: this statement binds the new digest.
      throw toPersistenceError(error)
    }
  }

  async registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean> {
    // The conditional `UPDATE`, not a read-then-write: N concurrent guesses
    // would all read the same `attempts`, all pass a comparison against it, and
    // all write. Folding the read into the `WHERE` and letting Postgres's row
    // lock serialize the writes is what holds the cap.
    const result = await this.db
      .update(pendingRegistrations)
      .set({
        attempts: sql`${pendingRegistrations.attempts} + ${ONE_INCREMENT}`,
      })
      .where(
        and(
          eq(pendingRegistrations.id, id),
          isNull(pendingRegistrations.consumedAt),
          sql`${pendingRegistrations.attempts} < ${maxAttempts}`,
        ),
      )

    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(pendingRegistrations)
      .set({ consumedAt: at })
      .where(
        and(eq(pendingRegistrations.id, id), isNull(pendingRegistrations.consumedAt)),
      )

    // Its TS type is `number | null` (the pg client's signature); `null` is
    // treated as "matched nothing" so single use fails CLOSED, not open.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }

  async deleteExpiredByEmail(email: Email, now: Date): Promise<void> {
    await this.db
      .delete(pendingRegistrations)
      .where(
        and(
          sql`lower(${pendingRegistrations.email}) = ${email.value}`,
          or(
            lte(pendingRegistrations.expiresAt, now),
            sql`${pendingRegistrations.consumedAt} is not null`,
          ),
        ),
      )
  }
}
```

- [ ] **Step 4: Escrever o dublê in-memory**

`src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts` — espelha `in-memory-email-verifications-repository.ts`:

```ts
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { Email } from '#modules/auth/value-objects/email'

const ONE_INCREMENT = 1

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It models NO row lock and NO conditional-update race: a unit test runs one
 * call at a time. Atomicity of `consume` and `registerFailedAttempt` is proved
 * against real Postgres, in
 * `tests/integration/drizzle-pending-registrations-repository.spec.ts`.
 */
export class InMemoryPendingRegistrationsRepository
  implements IPendingRegistrationsRepository
{
  readonly pendingRegistrations: PendingRegistration[] = []

  async save(pending: PendingRegistration): Promise<void> {
    this.pendingRegistrations.push(pending)
  }

  async findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]> {
    return this.pendingRegistrations
      .filter((each) => each.email.equals(email) && each.consumedAt === null)
      .sort((a, b) => b.codeIssuedAt.getTime() - a.codeIssuedAt.getTime())
  }

  async reissueCode(
    id: string,
    codeHash: string,
    codeIssuedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const NO_ATTEMPTS = 0
    this.#replaceMatching(
      (each) => each.id === id && each.consumedAt === null,
      { codeHash, attempts: NO_ATTEMPTS, codeIssuedAt, expiresAt },
    )
  }

  async registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean> {
    const current = this.pendingRegistrations.find(
      (each) => each.id === id && each.consumedAt === null && each.attempts < maxAttempts,
    )
    if (current === undefined) return false

    this.#replaceMatching((each) => each.id === id, {
      attempts: current.attempts + ONE_INCREMENT,
    })
    return true
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const current = this.pendingRegistrations.find(
      (each) => each.id === id && each.consumedAt === null,
    )
    if (current === undefined) return false

    this.#replaceMatching((each) => each.id === id, { consumedAt: at })
    return true
  }

  async deleteExpiredByEmail(email: Email, now: Date): Promise<void> {
    for (let index = this.pendingRegistrations.length - ONE_INCREMENT; index >= 0; index -= 1) {
      const each = this.pendingRegistrations[index]
      if (each === undefined) continue

      const sameEmail = each.email.equals(email)
      const expired = each.expiresAt.getTime() <= now.getTime()
      const consumed = each.consumedAt !== null

      if (sameEmail && (expired || consumed)) this.pendingRegistrations.splice(index, ONE_INCREMENT)
    }
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replaceMatching(
    matches: (pending: PendingRegistration) => boolean,
    changes: {
      codeHash?: string
      attempts?: number
      codeIssuedAt?: Date
      expiresAt?: Date
      consumedAt?: Date
    },
  ): void {
    this.pendingRegistrations.forEach((pending, index) => {
      if (!matches(pending)) return

      this.pendingRegistrations[index] = PendingRegistration.fromTrusted({
        id: pending.id,
        email: pending.email,
        codeHash: changes.codeHash ?? pending.codeHash,
        attempts: changes.attempts ?? pending.attempts,
        codeIssuedAt: changes.codeIssuedAt ?? pending.codeIssuedAt,
        expiresAt: changes.expiresAt ?? pending.expiresAt,
        consumedAt: changes.consumedAt ?? pending.consumedAt,
        createdAt: pending.createdAt,
      })
    })
  }
}
```

- [ ] **Step 5: Ligar em `AuthRepos`, `authRepositories` e `container`**

`src/modules/auth/repositories/unit-of-work.ts` — adicionar (mantendo `emailVerifications` nesta task):

```ts
import type { IPendingRegistrationsRepository } from './pending-registrations-repository.js'
// ...
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
  emailVerifications: IEmailVerificationsRepository
  pendingRegistrations: IPendingRegistrationsRepository
}
```

`src/modules/auth/infra/drizzle/auth-repositories.ts`:

```ts
import { DrizzlePendingRegistrationsRepository } from './drizzle-pending-registrations-repository.js'
// ...
export function authRepositories(db: Database): AuthRepos {
  return {
    users: new DrizzleUsersRepository(db),
    refreshTokens: new DrizzleRefreshTokensRepository(db),
    emailVerifications: new DrizzleEmailVerificationsRepository(db),
    pendingRegistrations: new DrizzlePendingRegistrationsRepository(db),
  }
}
```

`src/modules/auth/container.ts` — na desestruturação de `authRepositories(db)`, adicionar `pendingRegistrations: pendingRegistrationsRepository` (ainda não usado por nenhum use case; só precisa existir para o adapter ser construído uma vez).

- [ ] **Step 6: Escrever o teste de integração do adapter (falha)**

`tests/integration/drizzle-pending-registrations-repository.spec.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import { DrizzlePendingRegistrationsRepository } from '#modules/auth/infra/drizzle/drizzle-pending-registrations-repository'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { Email } from '#modules/auth/value-objects/email'

const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = 'JOAO@Example.com'
const OTHER_EMAIL = 'maria@example.com'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 900
const MILLISECONDS_PER_SECOND = 1000
const MAX_ATTEMPTS = 5

const DIGEST_A = 'digest:aaa'
const DIGEST_B = 'digest:bbb'
const REISSUED_DIGEST = 'digest:ccc'

const ID_OLDER = '11111111-1111-4111-8111-111111111111'
const ID_NEWER = '22222222-2222-4222-8222-222222222222'

const CONCURRENT_GUESSES = 10
const ONE = 1
const ZERO = 0

let db: Database
let pool: Pool
let repo: DrizzlePendingRegistrationsRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzlePendingRegistrationsRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(pendingRegistrations)
})

function pendingAt(id: string, ageMs: number, codeHash = DIGEST_A): PendingRegistration {
  const issuedAt = new Date(NOW.getTime() - ageMs)
  return PendingRegistration.fromTrusted({
    id,
    email: Email.create(EMAIL),
    codeHash,
    attempts: ZERO,
    codeIssuedAt: issuedAt,
    expiresAt: new Date(issuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    consumedAt: null,
    createdAt: issuedAt,
  })
}

describe('DrizzlePendingRegistrationsRepository', () => {
  it('returns unconsumed rows for the email, most recent code first, case-insensitively', async () => {
    await repo.save(pendingAt(ID_OLDER, 120_000, DIGEST_A))
    await repo.save(pendingAt(ID_NEWER, 0, DIGEST_B))

    const found = await repo.findUnconsumedByEmail(Email.create(MIXED_CASE_EMAIL))

    expect(found.map((p) => p.id)).toEqual([ID_NEWER, ID_OLDER])
  })

  it('excludes rows of other emails and consumed rows', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))
    await db.insert(pendingRegistrations).values({
      id: ID_OLDER,
      email: OTHER_EMAIL,
      codeHash: DIGEST_A,
      attempts: ZERO,
      codeIssuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      createdAt: NOW,
    })

    const found = await repo.findUnconsumedByEmail(Email.create(EMAIL))

    expect(found.map((p) => p.id)).toEqual([ID_NEWER])
  })

  it('caps attempts atomically under concurrent wrong guesses', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_GUESSES }, () =>
        repo.registerFailedAttempt(ID_NEWER, MAX_ATTEMPTS),
      ),
    )

    expect(results.filter(Boolean)).toHaveLength(MAX_ATTEMPTS)
    const [row] = await db
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, ID_NEWER))
    expect(row?.attempts).toBe(MAX_ATTEMPTS)
  })

  it('lets exactly one of two concurrent consumes win', async () => {
    await repo.save(pendingAt(ID_NEWER, 0))

    const [first, second] = await Promise.all([
      repo.consume(ID_NEWER, NOW),
      repo.consume(ID_NEWER, NOW),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(ONE)
  })

  it('reissueCode resets attempts and moves code_issued_at and expires_at', async () => {
    await db.insert(pendingRegistrations).values({
      id: ID_NEWER,
      email: EMAIL,
      codeHash: DIGEST_A,
      attempts: 3,
      codeIssuedAt: new Date(NOW.getTime() - 100_000),
      expiresAt: new Date(NOW.getTime() - 100_000 + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      createdAt: new Date(NOW.getTime() - 100_000),
    })
    const newExpiry = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)

    await repo.reissueCode(ID_NEWER, REISSUED_DIGEST, NOW, newExpiry)

    const [row] = await db
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, ID_NEWER))
    expect(row?.codeHash).toBe(REISSUED_DIGEST)
    expect(row?.attempts).toBe(ZERO)
    expect(row?.codeIssuedAt).toEqual(NOW)
    expect(row?.expiresAt).toEqual(newExpiry)
  })

  it('deleteExpiredByEmail removes expired and consumed rows, keeps live ones', async () => {
    await repo.save(pendingAt(ID_NEWER, 0)) // live
    await repo.save(pendingAt(ID_OLDER, TTL_SECONDS * MILLISECONDS_PER_SECOND, DIGEST_B)) // expired

    await repo.deleteExpiredByEmail(Email.create(EMAIL), NOW)

    const remaining = await db.select().from(pendingRegistrations)
    expect(remaining.map((r) => r.id)).toEqual([ID_NEWER])
  })
})
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test:integration`
Expected: os novos casos passam (o `globalSetup` já tem a tabela da Task 1).

- [ ] **Step 8: Portões**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration` — todos PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/repositories/pending-registrations-repository.ts \
        src/modules/auth/infra/drizzle/pending-registration-mapper.ts \
        src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts \
        src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts \
        src/modules/auth/repositories/unit-of-work.ts \
        src/modules/auth/infra/drizzle/auth-repositories.ts \
        src/modules/auth/container.ts \
        tests/integration/drizzle-pending-registrations-repository.spec.ts
git commit -m "feat(auth): add the pending registrations repository"
```

---

## Task 4: `EmailVerificationIssuer.issue(email)`

**Files:**
- Modify: `src/modules/auth/services/email-verification-issuer.ts`
- Modify: `src/modules/auth/services/email-verification-issuer.spec.ts`

**Interfaces:**
- Consumes: `Email`, `ITokenGenerator`, `ITokenDigest`, `IEmailSender`, `verificationEmail` de `#modules/auth/notifications/verification-email`.
- Produces: `issue(email: Email): { codeHash: string; deliver: DeliverVerification }` — cunha um código de 6 dígitos, devolve o digest e o envio diferido; não persiste, não envia. `DeliverVerification` continua exportado.
- `issueFor(...)` permanece intacto nesta task (removido na Task 8).

- [ ] **Step 1: Escrever os testes do `issue` (falha)**

Adicionar a `src/modules/auth/services/email-verification-issuer.spec.ts` um bloco:

```ts
describe('EmailVerificationIssuer.issue', () => {
  it('returns the digest of a fresh code and defers the send', async () => {
    const { issuer, callLog, saved } = makeIssuer()

    const { codeHash, deliver } = issuer.issue(Email.create(EMAIL))

    // Nothing persisted, nothing sent, until the caller acts.
    expect(saved).toHaveLength(0)
    expect(callLog).toEqual([])
    expect(codeHash).toBe(fakeDigest.hash(CODE))

    await deliver()
    expect(callLog).toEqual([SEND])
  })

  it('emails the plaintext code, never its digest', async () => {
    const { issuer, sent } = makeIssuer()

    const { codeHash, deliver } = issuer.issue(Email.create(EMAIL))
    await deliver()

    expect(extractCode(sent[0]?.text ?? '')).toBe(CODE)
    expect(sent[0]?.text).not.toContain(codeHash)
    expect(sent[0]?.to).toBe(EMAIL)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts`
Expected: FAIL — `issuer.issue is not a function`.

- [ ] **Step 3: Adicionar `issue` ao serviço**

Em `src/modules/auth/services/email-verification-issuer.ts`, adicionar o método (sem tocar em `issueFor`):

```ts
import type { Email } from '#modules/auth/value-objects/email'
// ...
  /**
   * Mints a fresh six-digit code, returns its digest for the caller to persist,
   * and the deferred send. Nothing here persists or sends — §8 stays structural,
   * and one `await deliver()` per branch keeps the 202 responses
   * indistinguishable in the caller's control flow.
   */
  issue(email: Email): { codeHash: string; deliver: DeliverVerification } {
    const code = this.tokenGenerator.numericCode(VERIFICATION_CODE_DIGITS)

    return {
      codeHash: this.tokenDigest.hash(code),
      deliver: () =>
        this.emailSender.send(verificationEmail(email, code, this.ttlSeconds)),
    }
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts`
Expected: PASS (os testes do `issue` e os do `issueFor` que já existiam).

- [ ] **Step 5: Portões**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/services/email-verification-issuer.ts \
        src/modules/auth/services/email-verification-issuer.spec.ts
git commit -m "feat(auth): add EmailVerificationIssuer.issue"
```

---

## Task 5: Cutover do `register` para registro pendente

**Files:**
- Modify: `src/modules/auth/use-cases/register-user.ts`
- Modify: `src/modules/auth/use-cases/register-user.spec.ts` (reescrito)
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/endpoints/register.ts`
- Modify: `tests/integration/register.spec.ts`
- Modify: `tests/integration/verify-email.spec.ts` (reduzido ao escopo de register nesta task; o fluxo completo volta na Task 6)

**Interfaces:**
- Consumes: `EmailVerificationIssuer.issue` (Task 4), `IPendingRegistrationsRepository` (Task 3), `Email`, `IClock`, `IIdGenerator`, `IEmailSender`, `IUsersRepository.findByEmail`, `accountAlreadyExistsEmail`.
- Produces:
  - `RegisterUserCommand = { email: string }` (o campo `password` sai)
  - `RegisterUserUseCase.execute(command: RegisterUserCommand): Promise<void>`
  - Construtor: `(usersRepository: Pick<IUsersRepository, 'findByEmail'>, pendingRegistrations: Pick<IPendingRegistrationsRepository, 'findUnconsumedByEmail' | 'save' | 'deleteExpiredByEmail'>, issuer: EmailVerificationIssuer, emailSender: IEmailSender, clock: IClock, idGenerator: IIdGenerator, resendCooldownMs: number, maxAttempts: number, ttlSeconds: number)`
- Produces: `POST /auth/register` body `z.object({ email }).strict()`, respostas `202 | 400 | 429` (sem `503`).

- [ ] **Step 1: Reescrever a spec unitária (falha)**

Substituir `src/modules/auth/use-cases/register-user.spec.ts` inteiro. Doubles: `clock`, `idGenerator`, `emailSender` (registra `send`), `InMemoryUsersRepository`, `InMemoryPendingRegistrationsRepository`, o **issuer real** (`new EmailVerificationIssuer` com `numericCode: () => CODE` e digest `digest:<value>`), e um `callLog` que registra `pendingRegistrations.deleteExpiredByEmail`, `pendingRegistrations.save` e `email.send` para provar a ordem "persist antes, send depois".

Casos:

```ts
describe('RegisterUserUseCase', () => {
  it('writes a pending registration and only then sends the code', async () => {
    await useCase.execute({ email: EMAIL })

    // toEqual on the whole log: kills a deleted deliver(), a send before the
    // write, and a missing prune.
    expect(callLog).toEqual([PRUNE, PENDING_SAVE, EMAIL_SEND])
    expect(pendingRepo.pendingRegistrations).toHaveLength(1)
    expect(pendingRepo.pendingRegistrations[0]?.email.value).toBe(EMAIL)
    expect(pendingRepo.pendingRegistrations[0]?.codeHash).toBe(`${DIGEST_PREFIX}${CODE}`)
  })

  it('resolves with nothing', async () => {
    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()
  })

  it('emails the six-digit code to the address', async () => {
    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
    expect(sent[0]?.text).toContain(CODE)
  })

  it('normalizes the email before storing it', async () => {
    await useCase.execute({ email: MIXED_CASE_EMAIL })
    expect(pendingRepo.pendingRegistrations[0]?.email.value).toBe(EMAIL)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    await useCase.execute({ email: EMAIL })
    const pending = pendingRepo.pendingRegistrations[0]
    expect(pending?.id).toBe(ID)
    expect(pending?.createdAt).toEqual(NOW)
    expect(pending?.codeIssuedAt).toEqual(NOW)
  })

  it('never opens a transaction and never hashes anything', async () => {
    // The suite provides no uow and no hashProvider — construction alone proves
    // the signature dropped them. This asserts behaviour: a plain resolve.
    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()
  })

  it('emails "you already have an account" when the address is a VERIFIED user', async () => {
    storeVerifiedUser()

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe(ALREADY_EXISTS_SUBJECT)
    expect(sent[0]?.text).not.toContain(CODE)
    expect(pendingRepo.pendingRegistrations).toHaveLength(0)
    expect(callLog).toEqual([EMAIL_SEND])
  })

  it('sends nothing when a usable pending got a code inside the cooldown', async () => {
    storeUsablePending({ ageMs: INSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(0)
    expect(pendingRepo.pendingRegistrations).toHaveLength(1)
    expect(callLog).toEqual([])
  })

  it('issues a fresh pending once the previous code leaves the cooldown', async () => {
    storeUsablePending({ ageMs: OUTSIDE_COOLDOWN_AGE_MS })

    await useCase.execute({ email: EMAIL })

    expect(sent).toHaveLength(1)
    expect(pendingRepo.pendingRegistrations).toHaveLength(2)
    expect(callLog).toEqual([PRUNE, PENDING_SAVE, EMAIL_SEND])
  })

  it('a pending that has exhausted its attempts does not hold the cooldown', async () => {
    storeUsablePending({ ageMs: INSIDE_COOLDOWN_AGE_MS, attempts: MAX_ATTEMPTS })

    await useCase.execute({ email: EMAIL })

    // The stale pending is not `isUsable`, so the cooldown branch is skipped.
    expect(sent).toHaveLength(1)
  })

  it('answers the same way whether the address is free or already pending', async () => {
    const free = await useCase.execute({ email: EMAIL })
    const pendingAlready = await useCase.execute({ email: EMAIL })
    expect(free).toBe(pendingAlready)
    expect(pendingAlready).toBeUndefined()
  })

  it('rejects an invalid email', async () => {
    await expect(useCase.execute({ email: INVALID_EMAIL })).rejects.toBeInstanceOf(
      InvalidEmailError,
    )
    expect(pendingRepo.pendingRegistrations).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})
```

Constantes: `PRUNE = 'pendingRegistrations.deleteExpiredByEmail'`, `PENDING_SAVE = 'pendingRegistrations.save'`, `EMAIL_SEND = 'email.send'`, `INSIDE_COOLDOWN_AGE_MS = 1`, `OUTSIDE_COOLDOWN_AGE_MS = RESEND_COOLDOWN_MS`, `MAX_ATTEMPTS = 5`, `TTL_SECONDS = 900`. `storeUsablePending` insere um `PendingRegistration.create`/`fromTrusted` no `pendingRepo` com `codeIssuedAt = new Date(NOW - ageMs)`. `storeVerifiedUser` insere um `User.fromTrusted({ ..., emailVerifiedAt: NOW })`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/register-user.spec.ts`
Expected: FAIL — compilação (`password` no command, construtor antigo).

- [ ] **Step 3: Reescrever o use case**

`src/modules/auth/use-cases/register-user.ts`:

```ts
import { accountAlreadyExistsEmail } from '#modules/auth/notifications/verification-email'
import { PendingRegistration } from '#modules/auth/entities/pending-registration'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  DeliverVerification,
  EmailVerificationIssuer,
} from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. The value object validates it. */
export interface RegisterUserCommand {
  email: string
}

/**
 * A no-op rather than an absent value, so every branch ends in the same
 * `await deliver()` and none can start to differ (§5.4 of the slice 11 design).
 */
const NO_DELIVERY: DeliverVerification = async () => {}

/**
 * Starts sign-up for an email address: writes a pending registration carrying a
 * six-digit code, and emails the code. The account is created later, at
 * confirmation, with the password supplied then — so this use case never hashes
 * a password and never opens a transaction.
 *
 * Answers the same way whether the address is free, already has a pending
 * registration, or belongs to a verified account: what differs is the email the
 * address receives, and only its owner can read it.
 */
export class RegisterUserUseCase {
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'save' | 'deleteExpiredByEmail'
    >,
    private readonly issuer: EmailVerificationIssuer,
    private readonly emailSender: IEmailSender,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
    private readonly maxAttempts: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RegisterUserCommand): Promise<void> {
    const email = Email.create(command.email)
    const now = this.clock.now()

    const deliver = await this.#planDelivery(email, now)
    await deliver()
  }

  async #planDelivery(email: Email, now: Date): Promise<DeliverVerification> {
    const existingUser = await this.usersRepository.findByEmail(email)
    if (existingUser !== null) {
      // The account only ever nasce verificada, so this is the "you already
      // have an account" branch. The STORED address, not the request's: the
      // lookup matched through Postgres `lower()`.
      return () => this.emailSender.send(accountAlreadyExistsEmail(existingUser.email))
    }

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const mostRecentUsable = pendings.find((each) => each.isUsable(this.maxAttempts, now))
    if (
      mostRecentUsable !== undefined &&
      now.getTime() - mostRecentUsable.codeIssuedAt.getTime() < this.resendCooldownMs
    ) {
      // Registering again inside the cooldown IS resending, and it must not put
      // a second email in the address's inbox.
      return NO_DELIVERY
    }

    await this.pendingRegistrations.deleteExpiredByEmail(email, now)

    const { codeHash, deliver } = this.issuer.issue(email)
    await this.pendingRegistrations.save(
      PendingRegistration.create({
        id: this.idGenerator.generate(),
        email,
        codeHash,
        now,
        ttlSeconds: this.ttlSeconds,
      }),
    )

    return deliver
  }
}
```

- [ ] **Step 4: Atualizar o container**

`src/modules/auth/container.ts` — `registerUser`:

```ts
registerUser: new RegisterUserUseCase(
  usersRepository,
  pendingRegistrationsRepository,
  emailVerificationIssuer,
  emailSender,
  clock,
  idGenerator,
  config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
  config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
  config.EMAIL_VERIFICATION_TTL_SECONDS,
),
```

- [ ] **Step 5: Atualizar o endpoint**

`src/modules/auth/infra/http/endpoints/register.ts`:
- `bodySchema` vira `z.object({ email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()).meta({ examples: [EXAMPLE_EMAIL] }) }).strict()`.
- Remover os imports de `MAX_PASSWORD_LENGTH`, `MIN_PASSWORD_LENGTH`, `PASSWORD_POLICY_PATTERN`, `EXAMPLE_PASSWORD`.
- Remover `[SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema` do `response` e o import de `SERVICE_UNAVAILABLE_STATUS` se não usado.
- `REGISTER_DESCRIPTION`: `'Starts sign-up for an email address and emails a six-digit verification code. The password is chosen at confirmation, not here. Always answers 202, whether or not the address already had an account: a status that distinguished the two would let anyone enumerate accounts.'`
- Comentário do `[ACCEPTED_STATUS]`: trocar a menção ao `409` por `// 503 is GONE too: this route no longer opens a transaction, so no TransactionConflictError can reach the wire.`

- [ ] **Step 6: Atualizar `tests/integration/register.spec.ts`**

- Body do POST vira `{ email }`.
- Assere que uma linha em `pending_registrations` é criada (`db.select().from(pendingRegistrations)` tem 1) e **nenhuma** em `users`.
- Novo caso: `{ email, password: 'x' }` → `400` (o `.strict()` rejeita a chave extra).
- Novo caso: recadastro imediato (dentro do cooldown) → `202`, ainda **uma** linha em `pending_registrations`.
- Remover qualquer asserção de `201`, `id`, `409`, `503`.

- [ ] **Step 7: Reduzir `tests/integration/verify-email.spec.ts` ao escopo de register**

Nesta task, deixe apenas os casos que dependem só do `register`:
- "answers 202 on register, with exactly one message reaching the mailbox".

Comente/remova os `it` de confirm, resend e login-flow (voltam nas Tasks 6 e 7). Ajuste o `beforeEach` para limpar `pendingRegistrations` em vez de `emailVerificationTokens`:

```ts
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
// ...
beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(pendingRegistrations)
  await db.delete(users)
  await clearMailpit()
})
```

- [ ] **Step 8: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/register-user.spec.ts` — PASS
Run: `pnpm test:integration` — PASS (register.spec.ts + verify-email.spec.ts reduzido)

- [ ] **Step 9: Portões**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration` — todos PASS.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/use-cases/register-user.ts \
        src/modules/auth/use-cases/register-user.spec.ts \
        src/modules/auth/container.ts \
        src/modules/auth/infra/http/endpoints/register.ts \
        tests/integration/register.spec.ts \
        tests/integration/verify-email.spec.ts
git commit -m "feat(auth): register writes a pending registration, not a user"
```

---

## Task 6: Cutover do `confirm` — a conta nasce aqui, com a senha do request

**Files:**
- Modify: `src/modules/auth/entities/user.ts`
- Modify: `src/modules/auth/entities/user.spec.ts`
- Modify: `src/modules/auth/use-cases/confirm-email.ts`
- Modify: `src/modules/auth/use-cases/confirm-email.spec.ts` (reescrito)
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/endpoints/confirm-email.ts`
- Modify: `tests/integration/verify-email.spec.ts` (fluxo completo + hijack)

**Interfaces:**
- Consumes: `PendingRegistration`, `IPendingRegistrationsRepository`, `IHashProvider`, `IAuthUnitOfWork` (com `pendingRegistrations` no `repos`), `RefreshTokenIssuer`, `ITokenSigner`, `ITokenDigest`, `IClock`, `IIdGenerator`, `User.create`.
- Produces:
  - `User.create(props: { id: string; email: Email; passwordHash: string; now: Date }): User` — `emailVerifiedAt` passa a ser `props.now`.
  - `ConfirmEmailCommand = { email: string; code: string; password: string }`
  - `ConfirmEmailUseCase.execute(command): Promise<ConfirmEmailResult>` (`ConfirmEmailResult` inalterado)
  - Construtor: `(pendingRegistrations: Pick<IPendingRegistrationsRepository, 'findUnconsumedByEmail' | 'registerFailedAttempt'>, uow: IAuthUnitOfWork, refreshTokenIssuer: RefreshTokenIssuer, tokenSigner: ITokenSigner, tokenDigest: ITokenDigest, hashProvider: IHashProvider, clock: IClock, idGenerator: IIdGenerator, maxAttempts: number)`
- Produces: `POST /auth/email/verify` body ganha `password` (política do `Password` VO).

- [ ] **Step 1: `User.create` nasce verificado (teste primeiro)**

Em `src/modules/auth/entities/user.spec.ts`, localizar a asserção "born unverified" e trocá-la:

```ts
it('is born verified: the only path that creates a user has already proven the email', () => {
  const user = User.create({ id: ID, email, passwordHash: HASH, now: NOW })
  expect(user.emailVerifiedAt).toEqual(NOW)
})
```

Run: `pnpm vitest run --project unit src/modules/auth/entities/user.spec.ts` — Expected: FAIL (ainda `null`).

- [ ] **Step 2: Implementar**

`src/modules/auth/entities/user.ts` — em `create`:

```ts
static create(props: CreateUserProps): User {
  return new User({
    id: props.id,
    email: props.email,
    passwordHash: props.passwordHash,
    // Born verified: the only path that reaches `create` is confirmation, and
    // it has already proven control of the address (§5.5 of the slice 11
    // design). Social login, when it lands, is the other proven path.
    emailVerifiedAt: props.now,
    createdAt: props.now,
    updatedAt: props.now,
  })
}
```

Run: `pnpm vitest run --project unit src/modules/auth/entities/user.spec.ts` — Expected: PASS.

- [ ] **Step 3: Reescrever `confirm-email.spec.ts` (falha)**

Substituir a spec. Doubles: `InMemoryPendingRegistrationsRepository`, `InMemoryUsersRepository`, `InMemoryRefreshTokensRepository`, `hashProvider` (registra os plaintexts hasheados, retorna `hashed:<plain>`), `RefreshTokenIssuer` real com generators fixos, `tokenSigner` spy, `digest` (`digest:<value>`), `idGenerator` (`GENERATED_ID`), `uowSpy` que anexa `COMMIT` ao resolver, `callLog` registrando `pendingRegistrations.consume`, `users.save`, `refreshTokens.save`, `pendingRegistrations.registerFailedAttempt`, `COMMIT`.

Command helper: `const confirm = (o = {}) => useCase.execute({ email: EMAIL, code: CODE, password: PASSWORD, ...o })`.

Casos:

```ts
describe('ConfirmEmailUseCase', () => {
  it('creates the verified user with THIS request password, opens a session, consumes the pending — one transaction', async () => {
    storeUsablePending({ id: PENDING_ID, codeHash: `${DIGEST_PREFIX}${CODE}` })

    const result = await confirm()

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken).toBe(OPAQUE_TOKEN)
    const stored = storedUser()
    expect(stored.email.value).toBe(EMAIL)
    expect(stored.passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
    expect(stored.emailVerifiedAt).toEqual(NOW)
    // toEqual on the whole log: consume, then user save, then token save, all
    // before COMMIT — deleting or reordering any of them fails this.
    expect(callLog).toEqual([CONSUME_CALL, USERS_SAVE_CALL, SAVE_TOKEN_CALL, COMMIT])
    expect(signSpy).toHaveBeenCalledWith({ sub: GENERATED_ID })
  })

  it('redeems whichever usable pending the code matches, not the most recent', async () => {
    // Attacker pending is newer; the victim types the code of the OLDER one.
    storeUsablePending({ id: OLD_PENDING_ID, ageMs: 120_000, codeHash: `${DIGEST_PREFIX}${CODE}` })
    storeUsablePending({ id: NEW_PENDING_ID, ageMs: 0, codeHash: `${DIGEST_PREFIX}${OTHER_CODE}` })

    await confirm({ code: CODE, password: PASSWORD })

    // The account has the password from THIS confirm request, and the OLD
    // pending is the one consumed.
    expect(storedUser().passwordHash).toBe(`${HASH_PREFIX}${PASSWORD}`)
    expect(pendingRepo.pendingRegistrations.find((p) => p.id === OLD_PENDING_ID)?.consumedAt).toEqual(NOW)
    expect(pendingRepo.pendingRegistrations.find((p) => p.id === NEW_PENDING_ID)?.consumedAt).toBeNull()
  })

  it('hashes the password even when no code matches, so match and no-match cost the same', async () => {
    storeUsablePending({ id: PENDING_ID, codeHash: `${DIGEST_PREFIX}${CODE}` })

    await expect(confirm({ code: WRONG_CODE })).rejects.toBeInstanceOf(EmailVerificationFailedError)

    expect(hashedPlaintexts).toEqual([PASSWORD])
  })

  it('on no match with a usable pending, burns one attempt on the most recent and throws', async () => {
    storeUsablePending({ id: OLD_PENDING_ID, ageMs: 120_000 })
    storeUsablePending({ id: NEW_PENDING_ID, ageMs: 0 })

    await expect(confirm({ code: WRONG_CODE })).rejects.toBeInstanceOf(EmailVerificationFailedError)

    expect(registerFailedAttemptSpy).toHaveBeenCalledWith(NEW_PENDING_ID, MAX_ATTEMPTS)
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('on no usable pending at all, throws without burning an attempt', async () => {
    await expect(confirm()).rejects.toBeInstanceOf(EmailVerificationFailedError)
    expect(registerFailedAttemptSpy).not.toHaveBeenCalled()
  })

  it('rejects a password that breaks the policy before touching the code', async () => {
    storeUsablePending({ id: PENDING_ID, codeHash: `${DIGEST_PREFIX}${CODE}` })

    await expect(confirm({ password: WEAK_PASSWORD })).rejects.toBeInstanceOf(InvalidPasswordError)

    expect(hashedPlaintexts).toHaveLength(0)
    expect(registerFailedAttemptSpy).not.toHaveBeenCalled()
  })

  it('throws inside the transaction when it loses the consume race', async () => {
    storeUsablePending({ id: PENDING_ID, codeHash: `${DIGEST_PREFIX}${CODE}` })
    consumeOutcome = LOST_RACE

    await expect(confirm()).rejects.toBeInstanceOf(EmailVerificationFailedError)
    expect(callLog).toEqual([CONSUME_CALL]) // no COMMIT
    expect(usersRepository.users).toHaveLength(0)
  })

  it('turns a users.save unique violation into the generic failure and rolls back', async () => {
    storeUsablePending({ id: PENDING_ID, codeHash: `${DIGEST_PREFIX}${CODE}` })
    usersRepository.users.push(
      User.fromTrusted({
        id: 'someone-else', email: Email.fromTrusted(EMAIL), passwordHash: 'x',
        emailVerifiedAt: NOW, createdAt: CREATED_AT, updatedAt: CREATED_AT,
      }),
    )

    await expect(confirm()).rejects.toBeInstanceOf(EmailVerificationFailedError)
    expect(callLog).toEqual([CONSUME_CALL]) // rejected before SAVE_TOKEN_CALL / COMMIT
  })
})
```

Constantes/helpers: `PASSWORD = 'sup3r-s3cr3t!'`, `WEAK_PASSWORD = 'abcdefghij'`, `WRONG_CODE = '654321'`, `OTHER_CODE = '111111'`, `HASH_PREFIX = 'hashed:'`, `USERS_SAVE_CALL = 'users.save'`. `storeUsablePending` insere no `pendingRepo` via `PendingRegistration.fromTrusted`. O `trackedRepos()` do `uow` expõe `pendingRegistrations.consume` (com o `LOST_RACE`), `users.save` (delega ao `InMemoryUsersRepository`, loga depois), `refreshTokens.save`.

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/confirm-email.spec.ts`
Expected: FAIL — compilação (command sem `password`, construtor antigo).

- [ ] **Step 5: Reescrever o use case**

`src/modules/auth/use-cases/confirm-email.ts`:

```ts
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { EmailVerificationFailedError } from '#modules/auth/errors/email-verification-failed-error'
import { User } from '#modules/auth/entities/user'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface ConfirmEmailCommand {
  email: string
  code: string
  password: string
}

export interface ConfirmEmailResult {
  accessToken: string
  refreshToken: string
}

/**
 * Redeems a six-digit code for an address together with a chosen password,
 * creates the verified account with THAT password, and opens a session.
 *
 * **One error for every failure mode**, same message: unknown email, no usable
 * pending, expired, attempts exhausted, wrong code, and losing the race to
 * consume or to insert the user. Branches that reported differently would make
 * this an account-and-code oracle.
 *
 * The password is hashed BEFORE the code is checked, always: if argon2 only ran
 * on a match, the response time would tell an attacker "that code was valid" —
 * the same reason `login-user.ts` compares a decoy hash.
 */
export class ConfirmEmailUseCase {
  constructor(
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'registerFailedAttempt'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly maxAttempts: number,
  ) {}

  async execute(command: ConfirmEmailCommand): Promise<ConfirmEmailResult> {
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    // Before the transaction (§8) and unconditional (flat timing).
    const passwordHash = await this.hashProvider.hash(password.value)

    // Read ONCE — stamps the user, its verified-at, and the refresh token.
    const now = this.clock.now()

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const usable = pendings.filter((each) => each.isUsable(this.maxAttempts, now))
    const codeHash = this.tokenDigest.hash(command.code)
    const match = usable.find((each) => each.matches(codeHash))

    if (match === undefined) {
      const [mostRecentUsable] = usable
      if (mostRecentUsable !== undefined) {
        // Autocommit, outside the transaction (§8 line 3): must survive the throw.
        await this.pendingRegistrations.registerFailedAttempt(
          mostRecentUsable.id,
          this.maxAttempts,
        )
      }
      throw new EmailVerificationFailedError()
    }

    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ users, pendingRegistrations, refreshTokens }) => {
      if (!(await pendingRegistrations.consume(match.id, now))) {
        throw new EmailVerificationFailedError()
      }

      try {
        await users.save(user)
      } catch (error) {
        // A concurrent confirm of a DIFFERENT pending for the same email won
        // the unique index. Generic error, no oracle; the rollback un-consumes
        // this pending.
        if (error instanceof EmailAlreadyInUseError) {
          throw new EmailVerificationFailedError()
        }
        throw error
      }

      await refreshTokens.save(issued.entity)
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
```

- [ ] **Step 6: Atualizar o container**

`src/modules/auth/container.ts` — `confirmEmail`:

```ts
confirmEmail: new ConfirmEmailUseCase(
  pendingRegistrationsRepository,
  uow,
  refreshTokenIssuer,
  tokenSigner,
  tokenDigest,
  hashProvider,
  clock,
  idGenerator,
  config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
),
```

- [ ] **Step 7: Atualizar o endpoint**

`src/modules/auth/infra/http/endpoints/confirm-email.ts`:
- Importar `MAX_PASSWORD_LENGTH`, `MIN_PASSWORD_LENGTH`, `PASSWORD_POLICY_PATTERN`, `EXAMPLE_PASSWORD` de `#modules/auth/value-objects/password` e `#modules/auth/infra/http/constants` (como o `register` fazia).
- `bodySchema` ganha `password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).regex(PASSWORD_POLICY_PATTERN).meta({ examples: [EXAMPLE_PASSWORD] })`.
- `CONFIRM_EMAIL_DESCRIPTION`: `'Redeems the six-digit code emailed at registration together with a chosen password, creates the verified account, and opens a session — the same pair login issues.'`
- `response` mantém `200 | 400 | 422 | 429 | 503` (o `confirm` continua abrindo `uow`).
- Handler: passar `request.body` inteiro (já inclui `password`) para `container.confirmEmail.execute`.

- [ ] **Step 8: Reescrever `tests/integration/verify-email.spec.ts` — fluxo completo + hijack**

Restaurar/rescrever, agora contra o novo fluxo. `register(email)` sem senha; `confirm(email, code, password, transport)`. Casos:

- ponta a ponta: `register(EMAIL)` → Mailpit tem 1 msg → `confirm(EMAIL, code, PASSWORD)` → `200`, `accessToken` casa JWT, `refreshToken` string; linha em `users` com `email_verified_at` não-nulo; `login(EMAIL, PASSWORD)` → `200`.
- **hijack, atacante primeiro:** `register(EMAIL)` (atacante) → 1 msg; `register(EMAIL)` (vítima) → 2 msgs; a vítima confirma com o código da **última** mensagem e `VICTIM_PASSWORD` → `200`; `login(EMAIL, VICTIM_PASSWORD)` → `200`; `login(EMAIL, ATTACKER_PASSWORD)` → `401` (não existe essa senha — só a que a vítima definiu). Assere também que uma tentativa do atacante `confirm(EMAIL, wrongCode, ATTACKER_PASSWORD)` → `422` e não cria sessão.
- **hijack, vítima primeiro:** `register(EMAIL)` (vítima) → 1 msg; guarda o código dessa msg; `register(EMAIL)` (atacante) → 2 msgs; vítima confirma com **o código guardado** + `VICTIM_PASSWORD` → `200`; `login(EMAIL, VICTIM_PASSWORD)` → `200`.
- **brute-force do próprio pendente:** `register(EMAIL)`; 5× `confirm(EMAIL, wrongCode, PASSWORD)` → `422`; então `confirm(EMAIL, realCode, PASSWORD)` → `422` (o pendente morreu); nenhuma linha em `users`.
- **corrida:** dois `register(EMAIL)`; pega os dois códigos; `Promise.all` de `confirm(EMAIL, codeA, PASSWORD_A)` e `confirm(EMAIL, codeB, PASSWORD_B)` → um `200`, um `422`; exatamente 1 linha em `users`, `email_verified_at` não-nulo.
- **senha malformada:** `confirm(EMAIL, code, 'x')` → `400`; nenhuma tentativa gasta (um `confirm` seguinte com código certo + senha boa ainda funciona nas 5 tentativas).

`wrongCodeFor(code)` e os helpers de Mailpit já existem no arquivo; reaproveite.

- [ ] **Step 9: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/confirm-email.spec.ts` — PASS
Run: `pnpm vitest run --project unit src/modules/auth/entities/user.spec.ts` — PASS
Run: `pnpm test:integration` — PASS

- [ ] **Step 10: Portões**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration` — todos PASS.

- [ ] **Step 11: Commit**

```bash
git add src/modules/auth/entities/user.ts src/modules/auth/entities/user.spec.ts \
        src/modules/auth/use-cases/confirm-email.ts src/modules/auth/use-cases/confirm-email.spec.ts \
        src/modules/auth/container.ts \
        src/modules/auth/infra/http/endpoints/confirm-email.ts \
        tests/integration/verify-email.spec.ts
git commit -m "feat(auth): the account is created at confirmation, with the confirm request's password"
```

---

## Task 7: Cutover do `resend`

**Files:**
- Modify: `src/modules/auth/use-cases/request-email-verification.ts`
- Modify: `src/modules/auth/use-cases/request-email-verification.spec.ts` (reescrito)
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/endpoints/resend-verification.ts`
- Modify: `tests/integration/verify-email.spec.ts` (casos de resend)

**Interfaces:**
- Consumes: `EmailVerificationIssuer.issue`, `IPendingRegistrationsRepository`, `IUsersRepository.findByEmail`, `Email`, `IClock`.
- Produces:
  - `RequestEmailVerificationUseCase.execute({ email: string }): Promise<void>` (inalterado)
  - Construtor: `(usersRepository: Pick<IUsersRepository, 'findByEmail'>, pendingRegistrations: Pick<IPendingRegistrationsRepository, 'findUnconsumedByEmail' | 'reissueCode'>, issuer: EmailVerificationIssuer, clock: IClock, cooldownMs: number, maxAttempts: number, ttlSeconds: number)`

- [ ] **Step 1: Reescrever a spec (falha)**

Substituir `src/modules/auth/use-cases/request-email-verification.spec.ts`. Doubles: `InMemoryUsersRepository`, `InMemoryPendingRegistrationsRepository`, issuer real, `clock`, `callLog` de `pendingRegistrations.reissueCode` e `email.send`. Constantes: `MILLISECONDS_PER_SECOND = 1000`, `TTL_SECONDS = 900`, `COOLDOWN_MS = 60_000`, `MAX_ATTEMPTS = 5`.

```ts
describe('RequestEmailVerificationUseCase', () => {
  it('does nothing when a real account exists for the address', async () => {
    storeVerifiedUser()
    await useCase.execute({ email: EMAIL })
    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })

  it('does nothing when there is no usable pending', async () => {
    await useCase.execute({ email: EMAIL })
    expect(sent).toHaveLength(0)
  })

  it('does nothing when the most recent usable pending is still inside the cooldown', async () => {
    storeUsablePending({ ageMs: 1 })
    await useCase.execute({ email: EMAIL })
    expect(sent).toHaveLength(0)
    expect(callLog).toEqual([])
  })

  it('reissues the code onto the most recent pending once it leaves the cooldown, then sends', async () => {
    storeUsablePending({ id: PENDING_ID, ageMs: COOLDOWN_MS })

    await useCase.execute({ email: EMAIL })

    expect(callLog).toEqual([REISSUE_CALL, EMAIL_SEND])
    const pending = pendingRepo.pendingRegistrations.find((p) => p.id === PENDING_ID)
    expect(pending?.attempts).toBe(0)
    expect(pending?.codeIssuedAt).toEqual(NOW)
    expect(pending?.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND))
    expect(sent[0]?.subject).toBe(VERIFICATION_SUBJECT)
  })

  it('targets the most recent usable pending among several', async () => {
    storeUsablePending({ id: OLD_PENDING_ID, ageMs: 300_000 })
    storeUsablePending({ id: NEW_PENDING_ID, ageMs: COOLDOWN_MS })

    await useCase.execute({ email: EMAIL })

    expect(pendingRepo.pendingRegistrations.find((p) => p.id === NEW_PENDING_ID)?.codeIssuedAt).toEqual(NOW)
    expect(pendingRepo.pendingRegistrations.find((p) => p.id === OLD_PENDING_ID)?.codeIssuedAt).not.toEqual(NOW)
  })

  it('never opens a transaction', async () => {
    storeUsablePending({ ageMs: COOLDOWN_MS })
    await expect(useCase.execute({ email: EMAIL })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/request-email-verification.spec.ts`
Expected: FAIL — construtor antigo / `uow`.

- [ ] **Step 3: Reescrever o use case**

`src/modules/auth/use-cases/request-email-verification.ts`:

```ts
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { EmailVerificationIssuer } from '#modules/auth/services/email-verification-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'

const MILLISECONDS_PER_SECOND = 1000

/** Raw, untrusted input. The value object validates it. */
export interface RequestEmailVerificationCommand {
  email: string
}

/**
 * Resends the six-digit code — and answers with the same status and body for an
 * unknown address, a real account, a request inside the cooldown, and a code
 * actually sent. A status that told them apart would be an account oracle.
 *
 * This closes the response, not the timing: the sending branch pays an `UPDATE`
 * and an SMTP round trip the others do not. §12 of the design records that gap.
 */
export class RequestEmailVerificationUseCase {
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly pendingRegistrations: Pick<
      IPendingRegistrationsRepository,
      'findUnconsumedByEmail' | 'reissueCode'
    >,
    private readonly issuer: EmailVerificationIssuer,
    private readonly clock: IClock,
    private readonly cooldownMs: number,
    private readonly maxAttempts: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RequestEmailVerificationCommand): Promise<void> {
    const email = Email.create(command.email)

    // A real account only ever exists verified: nothing to resend.
    const user = await this.usersRepository.findByEmail(email)
    if (user !== null) return

    const now = this.clock.now()

    const pendings = await this.pendingRegistrations.findUnconsumedByEmail(email)
    const target = pendings.find((each) => each.isUsable(this.maxAttempts, now))
    if (target === undefined) return

    // Strictly less than: a resend at exactly the cooldown's age is allowed.
    if (now.getTime() - target.codeIssuedAt.getTime() < this.cooldownMs) return

    const { codeHash, deliver } = this.issuer.issue(email)
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * MILLISECONDS_PER_SECOND)
    await this.pendingRegistrations.reissueCode(target.id, codeHash, now, expiresAt)

    await deliver()
  }
}
```

- [ ] **Step 4: Atualizar o container**

`src/modules/auth/container.ts` — `requestEmailVerification`:

```ts
requestEmailVerification: new RequestEmailVerificationUseCase(
  usersRepository,
  pendingRegistrationsRepository,
  emailVerificationIssuer,
  clock,
  config.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
  config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
  config.EMAIL_VERIFICATION_TTL_SECONDS,
),
```

- [ ] **Step 5: Atualizar o endpoint**

`src/modules/auth/infra/http/endpoints/resend-verification.ts`:
- Remover `[SERVICE_UNAVAILABLE_STATUS]` do `response` e o import se não usado.
- `RESEND_VERIFICATION_DESCRIPTION`: manter o texto sobre status/latência, trocar "pays a transaction and an SMTP round trip" por "pays an UPDATE and an SMTP round trip".
- Comentário do rate limit: trocar "burn their live code by racing a fresh one into existence" por "spam their inbox by re-minting the pending's code".

- [ ] **Step 6: Adicionar os casos de resend a `verify-email.spec.ts`**

- resend antes de qualquer register → `202`, Mailpit vazio.
- register → resend imediato → `202`, ainda 1 msg (cooldown). *(a suíte já roda com `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: 0` — ver `CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS` no `beforeAll`; então este caso precisa de um `describe` próprio com cooldown real, OU asserte que com cooldown 0 o resend manda a 2ª msg e confirma com o código dela.)* Escolha: manter o cooldown 0 da suíte e assertar que `register` → `resend` → 2ª msg → `confirm` com o código da 2ª msg + `PASSWORD` → `200`.
- register → confirm → resend → `202`, Mailpit ainda com as msgs anteriores, nenhuma nova (já existe conta verificada).

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/request-email-verification.spec.ts` — PASS
Run: `pnpm test:integration` — PASS

- [ ] **Step 8: Portões**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration` — todos PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/use-cases/request-email-verification.ts \
        src/modules/auth/use-cases/request-email-verification.spec.ts \
        src/modules/auth/container.ts \
        src/modules/auth/infra/http/endpoints/resend-verification.ts \
        tests/integration/verify-email.spec.ts
git commit -m "feat(auth): resend re-mints the code onto the most recent pending registration"
```

---

## Task 8: Remover o caminho morto de email-verification e limpar a história de migration

**Files:**
- Delete: `src/modules/auth/entities/email-verification.ts` + `.spec.ts`
- Delete: `src/modules/auth/repositories/email-verifications-repository.ts`
- Delete: `src/modules/auth/infra/drizzle/drizzle-email-verifications-repository.ts`
- Delete: `src/modules/auth/infra/drizzle/email-verification-mapper.ts`
- Delete: `src/modules/auth/infra/drizzle/schema/email-verification-tokens.ts`
- Delete: `src/modules/auth/infra/in-memory/in-memory-email-verifications-repository.ts`
- Delete: `tests/integration/drizzle-email-verifications-repository.spec.ts`
- Delete: `tests/integration/email-verification-tokens-schema.spec.ts`
- Delete: `drizzle/20260904014721_create_email_verification_tokens_table/` **e** `drizzle/<timestamp>_create_pending_registrations/` (a da Task 1)
- Modify: `src/modules/auth/services/email-verification-issuer.ts` + `.spec.ts` (remove `issueFor`)
- Modify: `src/modules/auth/repositories/unit-of-work.ts` (remove `emailVerifications` de `AuthRepos`)
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts` (remove `DrizzleEmailVerificationsRepository`)
- Modify: `src/modules/auth/container.ts` (remove a construção do repo antigo)
- Modify: `src/modules/auth/repositories/users-repository.ts` (remove `markEmailVerified`)
- Modify: `src/modules/auth/infra/drizzle/drizzle-users-repository.ts` (remove `markEmailVerified`)
- Modify: `src/modules/auth/infra/in-memory/in-memory-users-repository.ts` (remove `markEmailVerified`)

**Interfaces:**
- Produces: `AuthRepos = { users, refreshTokens, pendingRegistrations }`; `EmailVerificationIssuer` só com `issue`; `IUsersRepository` sem `markEmailVerified`; história de migration `users → refresh_tokens → pending_registrations`.

- [ ] **Step 1: Escrever o teste de deleção do `issueFor` primeiro**

Em `src/modules/auth/services/email-verification-issuer.spec.ts`, adicionar (antes de remover o método):

```ts
it('no longer exposes issueFor: the pending flow issues codes through issue()', () => {
  const { issuer } = makeIssuer()
  expect((issuer as unknown as Record<string, unknown>).issueFor).toBeUndefined()
})
```

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts` — Expected: FAIL (o método ainda existe).

- [ ] **Step 2: Remover `issueFor` e os testes que o exercitavam**

- Em `email-verification-issuer.ts`: apagar o método `issueFor` e o import de `EmailVerification` / `verificationEmail` se `issue` não precisar (mantém `verificationEmail`; apaga `EmailVerification` e o import de `IEmailVerificationsRepository`).
- Em `email-verification-issuer.spec.ts`: apagar os `it` que chamavam `issuer.issueFor(...)` e o double `verifications` (`IEmailVerificationsRepository`); manter os `it` de `issue` e o novo de deleção.

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts` — Expected: PASS.

- [ ] **Step 3: Remover `markEmailVerified`**

- `repositories/users-repository.ts`: apagar o método `markEmailVerified` da interface e sua docstring.
- `infra/drizzle/drizzle-users-repository.ts`: apagar a implementação.
- `infra/in-memory/in-memory-users-repository.ts`: apagar a implementação.
- Buscar referências remanescentes: `grep -rn markEmailVerified src tests` deve voltar vazio.

- [ ] **Step 4: Remover `AuthRepos.emailVerifications` e o repo antigo**

- `repositories/unit-of-work.ts`: tirar `emailVerifications` de `AuthRepos`; atualizar a docstring — `pendingRegistrations` é o que o `confirm` consome numa transação junto com `users` e `refreshTokens`.
- `infra/drizzle/auth-repositories.ts`: tirar `new DrizzleEmailVerificationsRepository(db)` e o import.
- `container.ts`: tirar a desestruturação `emailVerifications: emailVerificationsRepository` e qualquer uso; o `EmailVerificationIssuer` já não recebe `idGenerator` — conferir a construção: `new EmailVerificationIssuer(emailSender, tokenGenerator, tokenDigest, config.EMAIL_VERIFICATION_TTL_SECONDS)`.

> **Nota:** o `EmailVerificationIssuer` perdeu `idGenerator` do construtor quando `issueFor` saiu (era ele que gerava o id da entidade). Ajustar o construtor e a chamada no `container.ts` nesta step.

- [ ] **Step 5: Deletar os arquivos mortos**

```bash
git rm src/modules/auth/entities/email-verification.ts \
       src/modules/auth/entities/email-verification.spec.ts \
       src/modules/auth/repositories/email-verifications-repository.ts \
       src/modules/auth/infra/drizzle/drizzle-email-verifications-repository.ts \
       src/modules/auth/infra/drizzle/email-verification-mapper.ts \
       src/modules/auth/infra/drizzle/schema/email-verification-tokens.ts \
       src/modules/auth/infra/in-memory/in-memory-email-verifications-repository.ts \
       tests/integration/drizzle-email-verifications-repository.spec.ts \
       tests/integration/email-verification-tokens-schema.spec.ts
```

Run: `pnpm typecheck` — Expected: PASS (nada mais importa esses módulos). Se apontar um import remanescente, remova-o.

- [ ] **Step 6: Limpar a história de migration**

```bash
rm -rf drizzle/20260904014721_create_email_verification_tokens_table
rm -rf drizzle/<timestamp>_create_pending_registrations   # a pasta gerada na Task 1
pnpm db:generate --name create_pending_registrations
```

Expected: uma pasta nova `drizzle/<novo-timestamp>_create_pending_registrations/` cujo `migration.sql` cria **só** `pending_registrations` (diff contra o snapshot de `create_refresh_tokens_table`), sem menção a `email_verification_tokens`. O `snapshot.json` da pasta não contém `email_verification_tokens`.

- [ ] **Step 7: Recriar o banco local e o de teste**

```bash
docker compose down -v && docker compose up -d
pnpm db:migrate                       # aplica users → refresh_tokens → pending_registrations no banco de dev
```

O banco de teste (tmpfs) é remigrado pelo `globalSetup` no próximo `pnpm test:integration`.

- [ ] **Step 8: Rodar tudo**

Run: `pnpm lint` — PASS
Run: `pnpm typecheck` — PASS
Run: `pnpm test:unit` — PASS
Run: `pnpm test:integration` — PASS (inclui `pending-registrations-schema.spec.ts` contra a migration regenerada)

- [ ] **Step 9: Auditoria**

Run: `node .claude/skills/architecture-audit/scripts/audit-scan.mjs --base main`
Expected: 0 achados CRÍTICOS/ALTOS. Ler a saída e o passo 3 da skill (fronteira, R7, status declarados) para os arquivos novos.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(auth): remove the dead email-verification path, rewrite the migration history"
```

---

## Task 9: Emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md`
- Verify: `docs/superpowers/specs/2026-09-06-account-pre-hijacking-design.md` (§8.1, §13 batem com o que foi feito)

**Interfaces:** nenhuma — documentação.

- [ ] **Step 1: Adicionar as decisões novas ao `DECISIONS.md`**

Na seção numerada (depois da decisão 26), adicionar, seguindo o formato das existentes (título `### N — …`, prosa, "Custo aceito", "Descartado"):

- **`### 27 — A conta nasce na confirmação, com a senha do request de confirm`** — resume o §1 e o §12.2 da spec: `register` recebe só o e-mail e grava um `pending_registrations` sem senha; `POST /auth/email/verify` recebe `password` e cria `users` já verificada com ela. Fecha o account pre-hijacking nos dois sentidos de cadastro porque quem completa a confirmação escolhe a senha, e completar exige um código que só chegou na caixa do dono. **Quebra de contrato deliberada** (em cima da decisão 25): `POST /auth/register` perde `password`, `POST /auth/email/verify` ganha `password` obrigatório. Barato agora — boilerplate, sem cliente, sem front. **Descartado:** 4.1 (pendente carrega o hash da senha) — remove o hijack determinístico da fatia 10 mas deixa um residual de timing + confusão de inbox; link de confirmação por pendente — contra a decisão §6.2 da fatia 10.
- **`### 28 — Exceção pontual a R4: a migration de `email_verification_tokens` foi apagada`** — resume o §12.1 da spec: sem ambiente deployado, a migration só vivia em CI efêmero e no banco local do desenvolvedor; foi apagada em vez de seguida por uma de `DROP` para o histórico ficar `users → refresh_tokens → pending_registrations`. **Custo aceito:** R4 é regra escrita; esta é a exceção registrada, e não se repete.

Adicionar também, na seção "Escopo de produto" (onde "Verificação de e-mail — RESOLVIDA pela fatia 10" está), uma linha: a fatia 11 fechou o account pre-hijacking movendo a criação da conta para a confirmação; throttle de `confirm` por e-mail e deleção de conta varrendo pendentes continuam fatias próprias.

- [ ] **Step 2: Conferir a spec contra o que foi feito**

Ler `§8.1` e `§13` da spec e confirmar que descrevem o que as Tasks 1/8 fizeram (formato de pasta do `drizzle-kit` rc.4, recriação do banco local). Se algum detalhe divergiu na implementação (ex.: nome de índice, ordem de colunas), corrigir a spec inline — a spec viaja com o plano e precisa continuar verdadeira.

- [ ] **Step 3: Rodar os portões uma última vez**

Run: `pnpm lint` · `pnpm typecheck` · `pnpm test:unit` · `pnpm test:integration` — todos PASS.
Run: `node .claude/skills/architecture-audit/scripts/audit-scan.mjs --base main` — 0 CRÍTICO/ALTO.

- [ ] **Step 4: Commit**

```bash
git add docs/DECISIONS.md docs/superpowers/specs/2026-09-06-account-pre-hijacking-design.md
git commit -m "docs: record the pre-hijacking fix decisions (account at confirmation, R4 exception)"
```

---

## Self-Review (preenchido)

**1. Cobertura da spec:**

| Seção da spec | Task |
|---|---|
| §4.1 tabela `pending_registrations` | Task 1 |
| §4.2 `code_issued_at` separado | Task 1 (schema), Task 3 (`reissueCode`), Task 7 (resend usa) |
| §4.3 gate de login / `email_verified_at` ficam | Task 6 (comentário local em `login-user.ts` — **adicionar na Step 7 do Task 6**) |
| §5.1 entidade `PendingRegistration` | Task 2 |
| §5.2 contrato `IPendingRegistrationsRepository` | Task 3 |
| §5.3 `AuthRepos` / `unit-of-work.ts` | Task 3 (adiciona), Task 8 (remove o antigo) |
| §5.4 issuer remodelado | Task 4 (`issue`), Task 8 (remove `issueFor` + `idGenerator`) |
| §5.5 `User.create` verificado | Task 6 |
| §6.1 fluxo `register` | Task 5 |
| §6.2 fluxo `confirm` (argon2 incondicional, match em todos, corrida) | Task 6 |
| §6.3 fluxo `resend` | Task 7 |
| §6.4 percursos de ataque | Task 6 (testes de integração) |
| §7.1 endpoints (`.strict()`, `password`, `503` fora) | Task 5, 6, 7 |
| §7.2 taxonomia (zero categoria nova) | Task 6 (reusa `EmailVerificationFailedError`, `InvalidPasswordError`) |
| §8.1 migrations | Task 1, Task 8 |
| §8.2 container | Task 3, 5, 6, 7, 8 |
| §8.3 config (nenhuma env nova) | — (confirmado: `config.ts` não muda) |
| §9 deleções | Task 8 |
| §10.1 testes unitários | Tasks 2, 4, 5, 6, 7 |
| §10.2 testes de integração | Tasks 1, 3, 5, 6, 7 |
| §11 custos aceitos | Task 9 (referenciados no `DECISIONS.md`) |
| §12.1 exceção a R4 | Task 8 (executa), Task 9 (registra) |
| §12.2 4.3 sobre 4.1 | Task 9 |
| §12.3 `resend` mantido | Task 7 |
| §13 fora de escopo | Task 9 (linha no `DECISIONS.md`) |

**Lacuna corrigida:** o comentário local em `login-user.ts` (§4.3) não tinha task — adicionado à Step 7 do Task 6: uma linha acima do `if (user.emailVerifiedAt === null)` dizendo que o ramo "não verificado" não tem produtor até o login social.

**2. Placeholders:** nenhum "TBD"/"TODO"/"handle edge cases". Todo passo de código tem bloco real. O único ponto com escolha é a Step 6 do Task 7 (cooldown 0 da suíte de integração) — resolvido explicitamente no texto do passo (assertar a 2ª msg com cooldown 0).

**3. Consistência de tipos:**
- `findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]>` — mesma assinatura no contrato (Task 3), no adapter, no in-memory, e nos `Pick` dos use cases (Tasks 5, 6, 7). ✓
- `reissueCode(id, codeHash, codeIssuedAt, expiresAt)` — 4 args em todo lugar (contrato, adapter, in-memory, resend). ✓
- `PendingRegistration.create({ id, email, codeHash, now, ttlSeconds })` — Task 2 define, Task 5 usa com esses nomes. ✓
- `EmailVerificationIssuer.issue(email): { codeHash, deliver }` — Task 4 define, Tasks 5 e 7 desestruturam `{ codeHash, deliver }`. ✓
- `User.create({ id, email, passwordHash, now })` — `CreateUserProps` inalterado; Task 6 só muda o corpo. ✓
- Construtor de `ConfirmEmailUseCase`: `pendingRegistrations` Pick vem **antes** de `uow` (Task 6 Step 5) e o container passa nessa ordem (Step 6). ✓
- Construtor de `RegisterUserUseCase`: ordem `(usersRepository, pendingRegistrations, issuer, emailSender, clock, idGenerator, resendCooldownMs, maxAttempts, ttlSeconds)` — Task 5 Step 3 e Step 4 batem. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-07-account-pre-hijacking.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
