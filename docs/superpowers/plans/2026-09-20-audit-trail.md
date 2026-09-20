# Trilha de auditoria — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gravar um evento de auditoria durável em cada um dos cinco pontos de segurança do `auth` que já gravam um aviso no outbox (senha alterada, senha redefinida, Google vinculado, reuso detectado, conta deletada), na mesma transação, com IP e aparelho, e podar os eventos antigos pelo cron.

**Architecture:** Tabela `audit_events` dentro do módulo `auth` (nada em `shared/`), sem FK em `user_id` para sobreviver à conta apagada. Porta `IAuditEventsRepository` (`save`, `deleteOccurredBefore`) exposta no `AuthRepos`, então cada use case grava o evento dentro do `uow` que já existe. A poda é um job novo no registro do cron, com retenção em `AUDIT_EVENT_PRUNE_RETENTION_SECONDS` (padrão 1 ano).

**Tech Stack:** TypeScript, Zod (`authEnvSchema`), Drizzle/Postgres + drizzle-kit, Vitest (projetos `unit` e `integration`), Fastify, Biome.

**Spec:** [`docs/superpowers/specs/2026-09-20-audit-trail-design.md`](../specs/2026-09-20-audit-trail-design.md)

## Global Constraints

- Todo código, string, log e comentário em **inglês**; só os `*.md` podem ser em português (`CLAUDE.md`).
- **Sem magic strings/numbers** inline: constantes nomeadas, `UPPER_SNAKE_CASE`, inclusive nos testes, no estilo dos arquivos vizinhos (`CLAUDE.md`). Exceção: nomes de tabela, coluna e índice em `infra/drizzle/schema/*.ts`.
- Comentários explicam o código, nunca o processo: nada de "fatia 26", "o plano diz". Ponteiros para a spec/decisão são permitidos (`CLAUDE.md`).
- A trilha mora **dentro do `auth`**, nada em `shared/`; `audit_events.user_id` é `uuid NOT NULL` **sem** `references`; sem coluna de e-mail e sem coluna JSON (spec D1, D4, D7).
- `occurred_at` vem do `IClock`; nenhuma coluna de tempo tem default no banco (spec D8).
- Retenção padrão: `31_536_000` s (1 ano), variável `AUDIT_EVENT_PRUNE_RETENTION_SECONDS`; o número é marcador, não conselho jurídico (spec D9).
- A porta **não** ganha método de leitura (spec D11): os testes leem a tabela direto ou o array do fake.
- `REUSE_DETECTED` continua **retornado**, nunca lançado dentro da transação; o evento de reuso só é gravado na transição (`revoked > 0`), fora do `if (owner !== null)` (spec D10, §6.4).
- Migration nova em **pasta nova**, com `--name`; migration aplicada é imutável (R4).
- Rodar `pnpm` normalmente neste checkout. Se aparecer `ERR_PNPM_UNEXPECTED_STORE`, é o snap do VS Code: repetir com `--store-dir` apontando para o store antigo. Em um worktree com `node_modules` por symlink, **não** rodar `pnpm`: usar `node_modules/.bin/<ferramenta>` direto.
- Testes de integração precisam de Postgres e **`REDIS_URL`** definidos. A base de teste é migrada pelo global setup, então a migration nova precisa estar commitada antes de rodar a integração.
- Nunca canalizar um portão (`pnpm lint | tail`): rodar sozinho e ler o exit code.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/modules/auth/config.ts`, `config.spec.ts` | Variável e padrão da retenção | Modificar |
| `src/infra/config/fixtures/test-env.ts`, `src/infra/config/env.spec.ts`, `.env.example` | Env completo | Modificar |
| `src/modules/auth/entities/audit-event.ts` (+ `.spec.ts`) | `AuditEventType` e a entidade | Criar |
| `src/modules/auth/repositories/audit-events-repository.ts` | A porta | Criar |
| `src/modules/auth/infra/in-memory/in-memory-audit-events-repository.ts` (+ `.spec.ts`) | Fake dos use cases | Criar |
| `src/modules/auth/infra/drizzle/schema/audit-events.ts` | Tabela | Criar |
| `drizzle/<timestamp>_audit_events/` | Migration gerada | Criar (gerado) |
| `src/modules/auth/infra/drizzle/audit-event-mapper.ts`, `drizzle-audit-events-repository.ts` | Adapter Postgres | Criar |
| `src/modules/auth/repositories/unit-of-work.ts`, `noop-auth-repos.ts`, `infra/drizzle/auth-repositories.ts` | `auditEvents` no `AuthRepos` | Modificar |
| `src/modules/auth/use-cases/prune-audit-events.ts` (+ `.spec.ts`) | Poda | Criar |
| `src/modules/auth/container.ts` | Poda no cron | Modificar |
| `src/modules/auth/use-cases/{change-password,sign-in-with-google,reset-password,delete-account,refresh-token}.ts` (+ specs) | Um evento por use case | Modificar |
| `src/modules/auth/infra/http/endpoints/{reset-password,delete-account}.ts` | `device` nos dois endpoints | Modificar |
| `tests/integration/drizzle-audit-events-repository.spec.ts` | Repositório no Postgres real | Criar |
| `tests/integration/{unit-of-work,cron,refresh-token,reset-password,delete-account}.spec.ts` | Atomicidade, poda, prova ponta a ponta | Modificar |
| `docs/DECISIONS.md`, `docs/TODO.md`, spec da fatia | Decisão 43 e fila | Modificar |

---

### Task 1: A variável `AUDIT_EVENT_PRUNE_RETENTION_SECONDS`

**Files:**
- Modify: `src/modules/auth/config.ts` (constante depois da linha 178; campo depois de `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS`, ~linha 421)
- Modify: `src/infra/config/fixtures/test-env.ts` (import ~linha 39, entrada ~linha 134)
- Modify: `src/infra/config/env.spec.ts` (import ~linha 45, entrada ~linha 209)
- Modify: `.env.example` (depois da linha 133)
- Test: `src/modules/auth/config.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS = 31_536_000` exportado de `#modules/auth/config` e o campo `AUDIT_EVENT_PRUNE_RETENTION_SECONDS: number` em `authEnvSchema`/`AuthConfig`. A Task 3 depende de ambos.

- [ ] **Step 1: Write the failing tests**

Em `config.spec.ts`, acrescentar `DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS` ao import de `#modules/auth/config` (a posição não importa: o `pnpm lint:fix` ordena). Constante nova junto das outras do topo: `const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60`. Ao fim do `describe('authEnvSchema', …)`:

```ts
  it('defaults the audit event retention to one year', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.AUDIT_EVENT_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS,
    )
    expect(DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS).toBe(ONE_YEAR_SECONDS)
  })

  it('rejects an empty audit event retention instead of coercing it to zero', () => {
    // Zero would make every prune run delete the whole trail.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, AUDIT_EVENT_PRUNE_RETENTION_SECONDS: '' }),
    ).toThrow()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/config.spec.ts`
Expected: FAIL — `AUDIT_EVENT_PRUNE_RETENTION_SECONDS` ausente do schema.

- [ ] **Step 3: Write the implementation**

`config.ts`, depois de `DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS`:

```ts
/**
 * One year. How long an audit event stays before the prune job removes it. A
 * placeholder, not a compliance answer: how much of the trail to keep is a
 * product and legal decision, which is why it is a variable and not a constant.
 */
export const DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS = 31_536_000
```

No schema, logo depois do campo `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS`:

```ts
  // `.positive()` and not `.nonnegative()`: zero would delete the whole trail on
  // every prune run, and rejecting zero is also what rejects an empty value.
  AUDIT_EVENT_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS),
```

`test-env.ts` e `env.spec.ts`: importar `DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS` junto dos outros `DEFAULT_…` e acrescentar, logo depois da entrada `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS`:

```ts
  AUDIT_EVENT_PRUNE_RETENTION_SECONDS: DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS,
```

(no `env.spec.ts` a indentação tem 6 espaços, como as outras entradas do objeto esperado).

`.env.example`, depois de `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS=604800`:

```
# Audit trail (security events kept per account). How long an event stays before
# the prune job deletes it; one year is a placeholder, not a compliance answer.
AUDIT_EVENT_PRUNE_RETENTION_SECONDS=31536000
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix` (só para ordenar imports), depois `pnpm vitest run --project unit src/modules/auth/config.spec.ts src/infra/config` e `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts src/infra/config .env.example
git commit -m "feat(auth): add AUDIT_EVENT_PRUNE_RETENTION_SECONDS

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: O evento, a porta, a tabela e o adapter

**Files:**
- Create: `src/modules/auth/entities/audit-event.ts`, `audit-event.spec.ts`
- Create: `src/modules/auth/repositories/audit-events-repository.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-audit-events-repository.ts`, `.spec.ts`
- Create: `src/modules/auth/infra/drizzle/schema/audit-events.ts`
- Create (gerado): `drizzle/<timestamp>_audit_events/{migration.sql,snapshot.json}`
- Create: `src/modules/auth/infra/drizzle/audit-event-mapper.ts`, `drizzle-audit-events-repository.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts`, `noop-auth-repos.ts`, `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Test: `tests/integration/drizzle-audit-events-repository.spec.ts` (criar), `tests/integration/unit-of-work.spec.ts` (modificar)

**Interfaces:**
- Consumes: `toPersistenceError` (`#infra/database/driver-error`), `Database` (`#infra/database/client`).
- Produces:
  - `AuditEventType` (objeto `as const` + tipo união) e `AuditEvent.create({ id, type, userId, device, now })`, com getters `id`, `type`, `userId`, `ip`, `deviceLabel`, `occurredAt`; `AuditEventDevice = { ip: string | null; label: string | null }`.
  - `IAuditEventsRepository { save(event: AuditEvent): Promise<void>; deleteOccurredBefore(cutoff: Date): Promise<number> }`.
  - `InMemoryAuditEventsRepository` com `readonly events: AuditEvent[]`.
  - `AuthRepos.auditEvents: IAuditEventsRepository`; `noopAuthRepos().auditEvents` (no-op, devolve 0).
  - A tabela `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`).
  As Tasks 3–7 dependem de tudo isso.

- [ ] **Step 1: Write the failing unit tests**

`src/modules/auth/entities/audit-event.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'

const EVENT_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const NOW = new Date('2026-09-20T12:00:00.000Z')
const AN_OLD_YEAR = 1999

const create = (device = { ip: IP, label: DEVICE_LABEL }) =>
  AuditEvent.create({
    id: EVENT_ID,
    type: AuditEventType.PasswordChanged,
    userId: USER_ID,
    device,
    now: NOW,
  })

describe('AuditEvent', () => {
  it('carries the type, the user, the device and the instant', () => {
    const event = create()

    expect(event.id).toBe(EVENT_ID)
    expect(event.type).toBe('PASSWORD_CHANGED')
    expect(event.userId).toBe(USER_ID)
    expect(event.ip).toBe(IP)
    expect(event.deviceLabel).toBe(DEVICE_LABEL)
    expect(event.occurredAt).toEqual(NOW)
  })

  it('accepts an absent address and label', () => {
    const event = create({ ip: null, label: null })

    expect(event.ip).toBeNull()
    expect(event.deviceLabel).toBeNull()
  })

  it('has exactly the five security event types', () => {
    expect(Object.values(AuditEventType).sort()).toEqual([
      'ACCOUNT_DELETED',
      'GOOGLE_ACCOUNT_LINKED',
      'PASSWORD_CHANGED',
      'PASSWORD_RESET_COMPLETED',
      'REFRESH_TOKEN_REUSE_DETECTED',
    ])
  })

  it('does not let a caller mutate its date through a getter', () => {
    const event = create()

    event.occurredAt.setFullYear(AN_OLD_YEAR)

    expect(event.occurredAt).toEqual(NOW)
  })

  it('does not let the supplied instant be mutated after creation', () => {
    const mutable = new Date(NOW.getTime())
    const event = AuditEvent.create({
      id: EVENT_ID,
      type: AuditEventType.AccountDeleted,
      userId: USER_ID,
      device: { ip: IP, label: DEVICE_LABEL },
      now: mutable,
    })

    mutable.setFullYear(AN_OLD_YEAR)

    expect(event.occurredAt).toEqual(NOW)
  })

  it('keeps its state out of JSON, so a stray log cannot leak it', () => {
    expect(JSON.stringify(create())).toBe('{}')
  })
})
```

`src/modules/auth/infra/in-memory/in-memory-audit-events-repository.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { InMemoryAuditEventsRepository } from '#modules/auth/infra/in-memory/in-memory-audit-events-repository'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const CUTOFF = new Date('2026-09-20T12:00:00.000Z')
const ONE_SECOND_MS = 1000
const NO_EVENTS = 0
const TWO_EVENTS = 2
const ONE_EVENT = 1

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.PasswordChanged,
    userId: USER_ID,
    device: { ip: null, label: null },
    now: occurredAt,
  })

const offset = (ms: number) => new Date(CUTOFF.getTime() + ms)

describe('InMemoryAuditEventsRepository', () => {
  it('stores what it is given', async () => {
    const repository = new InMemoryAuditEventsRepository()

    await repository.save(eventAt('a', CUTOFF))

    expect(repository.events).toHaveLength(ONE_EVENT)
  })

  it('deletes what happened at or before the cutoff and returns how many', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('before', offset(-ONE_SECOND_MS)))
    await repository.save(eventAt('at', CUTOFF))
    await repository.save(eventAt('after', offset(ONE_SECOND_MS)))

    const deleted = await repository.deleteOccurredBefore(CUTOFF)

    expect(deleted).toBe(TWO_EVENTS)
    expect(repository.events.map((event) => event.id)).toEqual(['after'])
  })

  it('returns zero when nothing is old enough', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('after', offset(ONE_SECOND_MS)))

    expect(await repository.deleteOccurredBefore(CUTOFF)).toBe(NO_EVENTS)
    expect(repository.events).toHaveLength(ONE_EVENT)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/entities/audit-event.spec.ts src/modules/auth/infra/in-memory/in-memory-audit-events-repository.spec.ts`
Expected: FAIL — os módulos não existem.

- [ ] **Step 3: Write the entity, the port and the fake**

`src/modules/auth/entities/audit-event.ts`:

```ts
/**
 * The closed set of things the trail records. A TypeScript union over a `text`
 * column, not a Postgres enum: an enum would need a migration per new event, and
 * the type is where the check lives.
 */
export const AuditEventType = {
  PasswordChanged: 'PASSWORD_CHANGED',
  PasswordResetCompleted: 'PASSWORD_RESET_COMPLETED',
  GoogleAccountLinked: 'GOOGLE_ACCOUNT_LINKED',
  RefreshTokenReuseDetected: 'REFRESH_TOKEN_REUSE_DETECTED',
  AccountDeleted: 'ACCOUNT_DELETED',
} as const

export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType]

/** Where the event came from. Both nullable: an address can fail to parse. */
export interface AuditEventDevice {
  ip: string | null
  label: string | null
}

export interface CreateAuditEventProps {
  id: string
  type: AuditEventType
  /** No foreign key behind it: the event outlives the account it describes. */
  userId: string
  device: AuditEventDevice
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/**
 * One fact about an account, recorded in the same transaction as the change it
 * describes. State lives in `#` private fields, non-enumerable at runtime, so a
 * stray `log.info({ event })` cannot dump the address or the device.
 *
 * Only `create`: nothing reads a row back (the port has no read), so there is no
 * `fromTrusted` to keep in step with it.
 */
export class AuditEvent {
  readonly #id: string
  readonly #type: AuditEventType
  readonly #userId: string
  readonly #ip: string | null
  readonly #deviceLabel: string | null
  readonly #occurredAt: Date

  private constructor(props: CreateAuditEventProps) {
    this.#id = props.id
    this.#type = props.type
    this.#userId = props.userId
    this.#ip = props.device.ip
    this.#deviceLabel = props.device.label
    // `Object.freeze` is shallow: copying the date in and out is what makes the
    // immutability this class claims hold.
    this.#occurredAt = new Date(props.now.getTime())
    Object.freeze(this)
  }

  static create(props: CreateAuditEventProps): AuditEvent {
    return new AuditEvent(props)
  }

  get id(): string {
    return this.#id
  }

  get type(): AuditEventType {
    return this.#type
  }

  get userId(): string {
    return this.#userId
  }

  get ip(): string | null {
    return this.#ip
  }

  get deviceLabel(): string | null {
    return this.#deviceLabel
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime())
  }
}
```

`src/modules/auth/repositories/audit-events-repository.ts`:

```ts
import type { AuditEvent } from '#modules/auth/entities/audit-event'

export interface IAuditEventsRepository {
  /** Plain insert, called INSIDE the `uow` of the use case that made the change. */
  save(event: AuditEvent): Promise<void>

  /**
   * Deletes every event that occurred at or before `cutoff` and returns how many.
   * Mirrors `deleteExpiredBefore` on the sibling repositories.
   */
  deleteOccurredBefore(cutoff: Date): Promise<number>
}
```

`src/modules/auth/infra/in-memory/in-memory-audit-events-repository.ts`:

```ts
import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Exposes
 * `events` because the port has no read: the tests inspect what was recorded.
 */
export class InMemoryAuditEventsRepository implements IAuditEventsRepository {
  readonly events: AuditEvent[] = []

  async save(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }

  async deleteOccurredBefore(cutoff: Date): Promise<number> {
    const survivors = this.events.filter((event) => event.occurredAt > cutoff)
    const deleted = this.events.length - survivors.length
    this.events.length = 0
    this.events.push(...survivors)
    return deleted
  }
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm vitest run --project unit src/modules/auth/entities/audit-event.spec.ts src/modules/auth/infra/in-memory/in-memory-audit-events-repository.spec.ts`
Expected: PASS (9 testes).

- [ ] **Step 5: Write the schema and generate the migration**

`src/modules/auth/infra/drizzle/schema/audit-events.ts`:

```ts
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * One row per security event, kept for the retention window and then pruned.
 *
 * `user_id` deliberately has NO `references`: the trail has to outlive the
 * account it describes, and a foreign key would either block the delete or
 * cascade the evidence away with it.
 *
 * NO column defaults, like `outbox-messages.ts`: `occurred_at` comes from
 * `IClock` so any later instant comparison has both sides from one source.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    userId: uuid('user_id').notNull(),
    ip: text('ip'),
    deviceLabel: text('device_label'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // "What happened to this account", newest first.
    index('audit_events_user_id_occurred_at_idx').on(table.userId, table.occurredAt),
    // The prune job's `occurred_at <= cutoff`.
    index('audit_events_occurred_at_idx').on(table.occurredAt),
  ],
)
```

Run: `pnpm db:generate --name audit_events`
Expected: uma pasta nova `drizzle/<timestamp>_audit_events/` com `migration.sql` e `snapshot.json`. Abrir o `migration.sql` e conferir: um `CREATE TABLE "audit_events"` com as seis colunas (`id`, `type`, `user_id`, `ip`, `device_label`, `occurred_at`), **dois** `CREATE INDEX` (`audit_events_user_id_occurred_at_idx`, `audit_events_occurred_at_idx`) e **nenhum** `FOREIGN KEY`/`REFERENCES`. Se algo diferir, corrigir o schema e regerar **antes** de commitar (migration aplicada é imutável, mas esta ainda não foi commitada).

- [ ] **Step 6: Write the Drizzle adapter, then wire the repository bag**

`src/modules/auth/infra/drizzle/audit-event-mapper.ts`:

```ts
import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { auditEvents } from './schema/audit-events.js'

/** Entity to row; there is no way back, because nothing reads a row. */
export function toPersistenceAuditEvent(event: AuditEvent): typeof auditEvents.$inferInsert {
  return {
    id: event.id,
    type: event.type,
    userId: event.userId,
    ip: event.ip,
    deviceLabel: event.deviceLabel,
    occurredAt: event.occurredAt,
  }
}
```

`src/modules/auth/infra/drizzle/drizzle-audit-events-repository.ts`:

```ts
import { lte } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { AuditEvent } from '#modules/auth/entities/audit-event'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'
import { toPersistenceAuditEvent } from './audit-event-mapper.js'
import { auditEvents } from './schema/audit-events.js'

/** How many rows affected when none matched. */
const NO_ROW_AFFECTED = 0

export class DrizzleAuditEventsRepository implements IAuditEventsRepository {
  constructor(private readonly db: Database) {}

  async save(event: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditEvents).values(toPersistenceAuditEvent(event))
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  async deleteOccurredBefore(cutoff: Date): Promise<number> {
    try {
      const result = await this.db
        .delete(auditEvents)
        .where(lte(auditEvents.occurredAt, cutoff))

      return result.rowCount ?? NO_ROW_AFFECTED
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}
```

`unit-of-work.ts`: importar `import type { IAuditEventsRepository } from './audit-events-repository.js'` junto dos outros imports de repositório, acrescentar `auditEvents: IAuditEventsRepository` ao fim de `AuthRepos`, e ao comentário da interface, depois do parágrafo do `outboxMessages`:

```
 *
 * `auditEvents` for the same reason: the event of a security-relevant change is
 * written in the SAME transaction as the change, beside its outbox notice.
```

`noop-auth-repos.ts`: acrescentar, depois de `outboxMessages: { … }`:

```ts
    auditEvents: {
      save: async () => {},
      deleteOccurredBefore: async () => 0,
    },
```

`auth-repositories.ts`: importar `DrizzleAuditEventsRepository from './drizzle-audit-events-repository.js'` e acrescentar `auditEvents: new DrizzleAuditEventsRepository(db),` depois de `outboxMessages`.

- [ ] **Step 7: Write the integration tests**

`tests/integration/drizzle-audit-events-repository.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { auditEvents } from '#modules/auth/infra/drizzle/schema/audit-events'
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'

const EVENT_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_EVENT_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const THIRD_EVENT_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
/** A user id with NO row in `users`: the trail has no foreign key to it. */
const UNKNOWN_USER_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const CUTOFF = new Date('2026-09-20T12:00:00.000Z')
const ONE_SECOND_MS = 1000
const ONE_ROW = 1
const TWO_ROWS = 2

let db: Database
let pool: Pool
let repository: IAuditEventsRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = authRepositories(db).auditEvents
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(auditEvents)
})

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.PasswordChanged,
    userId: UNKNOWN_USER_ID,
    device: { ip: IP, label: DEVICE_LABEL },
    now: occurredAt,
  })

const offset = (ms: number) => new Date(CUTOFF.getTime() + ms)

describe('DrizzleAuditEventsRepository', () => {
  it('saves an event with its type, device and instant', async () => {
    await repository.save(eventAt(EVENT_ID, CUTOFF))

    const [row] = await db.select().from(auditEvents)

    expect(row).toEqual({
      id: EVENT_ID,
      type: 'PASSWORD_CHANGED',
      userId: UNKNOWN_USER_ID,
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      occurredAt: CUTOFF,
    })
  })

  it('keeps an event for a user that has no row: there is no foreign key', async () => {
    await repository.save(eventAt(EVENT_ID, CUTOFF))

    expect(await db.select().from(auditEvents)).toHaveLength(ONE_ROW)
  })

  it('deletes what happened at or before the cutoff and returns how many', async () => {
    await repository.save(eventAt(EVENT_ID, offset(-ONE_SECOND_MS)))
    await repository.save(eventAt(OTHER_EVENT_ID, CUTOFF))
    await repository.save(eventAt(THIRD_EVENT_ID, offset(ONE_SECOND_MS)))

    const deleted = await repository.deleteOccurredBefore(CUTOFF)

    expect(deleted).toBe(TWO_ROWS)
    const remaining = await db.select().from(auditEvents)
    expect(remaining.map((row) => row.id)).toEqual([THIRD_EVENT_ID])
  })
})
```

Em `tests/integration/unit-of-work.spec.ts`: importar `AuditEvent, AuditEventType` (`#modules/auth/entities/audit-event`) e `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`); constantes `const AUDIT_EVENT_ID = '5c4b3a29-1807-4f6e-9d5c-4b3a29180716'`, `const AUDIT_USER_ID = '7d6c5b4a-3928-4170-8e6d-5c4b3a291807'`, `const NO_EVENTS = 0`, `const ONE_EVENT = 1`; no `beforeEach`, acrescentar `await db.delete(auditEvents)`; e, dentro do `describe`, depois do teste `'rolls back EVERY write when the work throws'`:

```ts
  it('rolls back an audit event written in the same unit of work', async () => {
    const boom = new Error(BOOM_MESSAGE)

    await expect(
      unitOfWork(async (repos) => {
        await repos.auditEvents.save(makeAuditEvent())

        throw boom
      }),
    ).rejects.toBe(boom)

    // Read through the pool handle: the row must not exist for anyone.
    expect(await db.select().from(auditEvents)).toHaveLength(NO_EVENTS)
  })

  it('commits an audit event when the work resolves', async () => {
    await unitOfWork(async (repos) => {
      await repos.auditEvents.save(makeAuditEvent())
    })

    expect(await db.select().from(auditEvents)).toHaveLength(ONE_EVENT)
  })
```

com o helper, junto de `makeUser`:

```ts
function makeAuditEvent() {
  return AuditEvent.create({
    id: AUDIT_EVENT_ID,
    type: AuditEventType.PasswordChanged,
    userId: AUDIT_USER_ID,
    device: { ip: null, label: null },
    now: NOW,
  })
}
```

(O teste de commit existe para o de rollback valer: sem ele, o de rollback passaria também se nada fosse gravado. Estes dois usam o `uow` do container real, então provam que `auditEvents` no `authRepositories` está ligado à transação e não ao pool.)

- [ ] **Step 8: Run everything for this task**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`, depois `pnpm vitest run --project integration tests/integration/drizzle-audit-events-repository.spec.ts tests/integration/unit-of-work.spec.ts`
Expected: PASS em tudo. Se o typecheck acusar algum spec que monta um `AuthRepos` inteiro à mão sem `auditEvents`, acrescentar `auditEvents: noopAuthRepos().auditEvents` ali.

- [ ] **Step 9: Commit**

```bash
git add src drizzle tests
git commit -m "feat(auth): add the audit event, its port, table and repository

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: A poda pelo cron

**Files:**
- Create: `src/modules/auth/use-cases/prune-audit-events.ts`, `prune-audit-events.spec.ts`
- Modify: `src/modules/auth/container.ts` (imports ~linha 66-71; singleton ~linha 100; use case ~linha 165; registro do job ~linha 208)
- Test: `tests/integration/cron.spec.ts`

**Interfaces:**
- Consumes: `IAuditEventsRepository.deleteOccurredBefore` e `InMemoryAuditEventsRepository` (Task 2); `config.AUDIT_EVENT_PRUNE_RETENTION_SECONDS` (Task 1).
- Produces: `PRUNE_AUDIT_EVENTS_JOB = 'prune-audit-events'` e `PruneAuditEventsUseCase(auditEvents, clock, retentionMs).execute(): Promise<{ rowsDeleted: number }>`; o job registrado no cron.

- [ ] **Step 1: Write the failing tests**

`src/modules/auth/use-cases/prune-audit-events.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'
import { InMemoryAuditEventsRepository } from '#modules/auth/infra/in-memory/in-memory-audit-events-repository'
import { PruneAuditEventsUseCase } from '#modules/auth/use-cases/prune-audit-events'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const NOW = new Date('2026-09-20T12:00:00.000Z')
const RETENTION_MS = 1000 * 60 * 60
const ONE_SECOND_MS = 1000
const ONE_ROW = 1
const TWO_ROWS = 2

const eventAt = (id: string, occurredAt: Date) =>
  AuditEvent.create({
    id,
    type: AuditEventType.AccountDeleted,
    userId: USER_ID,
    device: { ip: null, label: null },
    now: occurredAt,
  })

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

describe('PruneAuditEventsUseCase', () => {
  it('deletes what is at or past the retention window and keeps the rest', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('past', at(-RETENTION_MS - ONE_SECOND_MS)))
    await repository.save(eventAt('edge', at(-RETENTION_MS)))
    await repository.save(eventAt('inside', at(-RETENTION_MS + ONE_SECOND_MS)))

    const result = await new PruneAuditEventsUseCase(
      repository,
      { now: () => NOW },
      RETENTION_MS,
    ).execute()

    expect(result).toEqual({ rowsDeleted: TWO_ROWS })
    expect(repository.events.map((event) => event.id)).toEqual(['inside'])
  })

  it('reports zero when nothing is old enough', async () => {
    const repository = new InMemoryAuditEventsRepository()
    await repository.save(eventAt('recent', NOW))

    const result = await new PruneAuditEventsUseCase(
      repository,
      { now: () => NOW },
      RETENTION_MS,
    ).execute()

    expect(result).toEqual({ rowsDeleted: 0 })
    expect(repository.events).toHaveLength(ONE_ROW)
  })
})
```

Em `tests/integration/cron.spec.ts`: importar `randomUUID` (já importado no arquivo), `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`) e `PRUNE_AUDIT_EVENTS_JOB` (`#modules/auth/use-cases/prune-audit-events`); trocar `const EXPECTED_JOBS = 5` por `const EXPECTED_JOBS = 6`; constante `const ABOVE_AUDIT_RETENTION_MS = (env.AUDIT_EVENT_PRUNE_RETENTION_SECONDS + 24 * 60 * 60) * 1000`; no `beforeEach`, antes do `db.delete(users)`, `await db.delete(auditEvents)`; e, dentro de `describe('runCron', …)`, depois do teste `'with no selector, prunes …'`:

```ts
  it('prunes audit events past the retention window and keeps the recent ones', async () => {
    await db.insert(auditEvents).values([
      {
        id: randomUUID(),
        type: 'PASSWORD_CHANGED',
        userId,
        ip: null,
        deviceLabel: null,
        occurredAt: ago(ABOVE_AUDIT_RETENTION_MS),
      },
      {
        id: randomUUID(),
        type: 'PASSWORD_CHANGED',
        userId,
        ip: null,
        deviceLabel: null,
        occurredAt: ago(RECENTLY_MS),
      },
    ])

    const outcomes = await runCron(env, SILENT_LOGGER)

    const pruned = outcomes.find((outcome) => outcome.name.endsWith(PRUNE_AUDIT_EVENTS_JOB))
    expect(pruned?.metrics?.rowsDeleted).toBe(ROWS_DELETED_PER_JOB)
    expect(await db.select().from(auditEvents)).toHaveLength(SURVIVORS_PER_TABLE)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/prune-audit-events.spec.ts`
Expected: FAIL — o módulo não existe. (O `cron.spec.ts` só passa a fazer sentido depois do Step 3.)

- [ ] **Step 3: Write the implementation**

`src/modules/auth/use-cases/prune-audit-events.ts`:

```ts
import type { IAuditEventsRepository } from '#modules/auth/repositories/audit-events-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_AUDIT_EVENTS_JOB = 'prune-audit-events'

export interface PruneAuditEventsResult {
  rowsDeleted: number
}

/**
 * Deletes audit events that occurred at or before the retention window ago.
 * Same cutoff arithmetic as `PruneOutboxMessagesUseCase`; unlike it there is no
 * "still pending" state to protect, so age is the only criterion.
 */
export class PruneAuditEventsUseCase {
  constructor(
    private readonly auditEvents: IAuditEventsRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneAuditEventsResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.auditEvents.deleteOccurredBefore(cutoff)
    return { rowsDeleted }
  }
}
```

`container.ts`:
- imports: `import { PRUNE_AUDIT_EVENTS_JOB, PruneAuditEventsUseCase } from './use-cases/prune-audit-events.js'` (junto dos outros imports de use case; o Biome ordena);
- na desestruturação de `authRepositories(db)`, depois de `outboxMessages: outboxMessagesRepository,`: `auditEvents: auditEventsRepository,`;
- depois de `const pruneOutboxMessages = new PruneOutboxMessagesUseCase(…)`:

```ts
  const pruneAuditEvents = new PruneAuditEventsUseCase(
    auditEventsRepository,
    clock,
    config.AUDIT_EVENT_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
  )
```

- no array de jobs, depois da entrada de `PRUNE_OUTBOX_MESSAGES_JOB`:

```ts
    {
      name: PRUNE_AUDIT_EVENTS_JOB,
      run: async () => {
        const { rowsDeleted } = await pruneAuditEvents.execute()
        return { rowsDeleted }
      },
    },
```

Se `AuthContainerConfig` (o tipo que o container recebe) enumerar as chaves de config à mão, acrescentar `AUDIT_EVENT_PRUNE_RETENTION_SECONDS` a ele; o compilador acusa.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`, `pnpm vitest run --project integration tests/integration/cron.spec.ts`
Expected: PASS. O teste `'with no selector …'` agora vê 6 jobs; conferir que os outros testes do arquivo que usam `EXPECTED_JOBS` continuam verdes.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(auth): prune old audit events from the cron job registry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Eventos de senha alterada e de Google vinculado

Os dois use cases já recebem `device: SessionDevice`.

**Files:**
- Modify: `src/modules/auth/use-cases/change-password.ts` (transação ~linha 127)
- Modify: `src/modules/auth/use-cases/sign-in-with-google.ts` (transação do vínculo ~linha 142)
- Test: `src/modules/auth/use-cases/change-password.spec.ts`, `src/modules/auth/use-cases/sign-in-with-google.spec.ts`

**Interfaces:**
- Consumes: `AuditEvent.create`, `AuditEventType`, `AuthRepos.auditEvents` (Task 2); `InMemoryAuditEventsRepository`.
- Produces: um evento `PASSWORD_CHANGED` e um `GOOGLE_ACCOUNT_LINKED` por operação bem-sucedida, gravados no `uow`.

- [ ] **Step 1: Write the failing tests**

**`change-password.spec.ts`.** Imports: `AuditEventType` (`#modules/auth/entities/audit-event`) e `InMemoryAuditEventsRepository` (`#modules/auth/infra/in-memory/in-memory-audit-events-repository`). Constantes: `const ONE_EVENT = 1`, `const NO_EVENTS = 0`. Variável `let auditEventsRepository: InMemoryAuditEventsRepository`; no `beforeEach`, `auditEventsRepository = new InMemoryAuditEventsRepository()` junto de `outboxMessages = new …`; e em `trackedRepos`, logo depois de `...noopAuthRepos(),`: `auditEvents: auditEventsRepository,` (sem embrulhar em `callLog`: a sequência de chamadas que o spec afirma não muda). Testes novos dentro do `describe('ChangePasswordUseCase', …)`:

```ts
  it('records a PASSWORD_CHANGED audit event with the device that asked', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.PasswordChanged)
    expect(event?.userId).toBe(USER_ID)
    expect(event?.ip).toBe(DEVICE.ip)
    expect(event?.deviceLabel).toBe(DEVICE.label)
    expect(event?.occurredAt).toEqual(NOW)
  })

  it('records nothing when the current password is wrong', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ currentPassword: WRONG_PASSWORD })).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
```

**`sign-in-with-google.spec.ts`.** Mesmos imports (`AuditEventType`, `InMemoryAuditEventsRepository`); constantes `ONE_EVENT = 1`, `NO_EVENTS = 0`; `let auditEventsRepository: InMemoryAuditEventsRepository`, criado no `beforeEach` (junto de `outboxMessagesRepository = new …`); em `const repos: AuthRepos = { ...noopAuthRepos(), …`, acrescentar `auditEvents: auditEventsRepository,`. Dentro do `describe` do vínculo (o que contém `'links on the right password: …'`), depois desse teste:

```ts
  it('records a GOOGLE_ACCOUNT_LINKED audit event with the device that linked', async () => {
    storePasswordUser()

    await useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD, device: DEVICE })

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.GoogleAccountLinked)
    expect(event?.userId).toBe(USER_ID)
    expect(event?.ip).toBe(DEVICE.ip)
    expect(event?.deviceLabel).toBe(DEVICE.label)
    expect(event?.occurredAt).toEqual(NOW)
  })

  it('records nothing when the password is wrong', async () => {
    storePasswordUser()
    compareResult = false

    await expect(
      useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
```

(`InvalidCredentialsError` e `InvalidCurrentPasswordError` já são importados nos respectivos specs; se algum não for, importar do mesmo caminho dos vizinhos.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/change-password.spec.ts src/modules/auth/use-cases/sign-in-with-google.spec.ts`
Expected: FAIL — os dois testes de gravação veem 0 eventos; os de "records nothing" passam (guardam o comportamento).

- [ ] **Step 3: Write the implementation**

`change-password.ts`: importar `import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'`; na assinatura da transação acrescentar `auditEvents`: `async ({ users, refreshTokens, outboxMessages, auditEvents }) => {`; e, logo depois do `await outboxMessages.save(…)` (dentro do mesmo callback):

```ts
      // The trail, in the same transaction as the change and its notice.
      await auditEvents.save(
        AuditEvent.create({
          id: this.idGenerator.generate(),
          type: AuditEventType.PasswordChanged,
          userId: user.id,
          device: command.device,
          now,
        }),
      )
```

`sign-in-with-google.ts` (método do vínculo, o `uow` que grava `googleAccountLinkedEmail`): mesmo import; `async ({ federatedIdentities, refreshTokens, outboxMessages, auditEvents }) => {`; e, depois do `outboxMessages.save(…)`:

```ts
      await auditEvents.save(
        AuditEvent.create({
          id: this.idGenerator.generate(),
          type: AuditEventType.GoogleAccountLinked,
          userId: existing.id,
          device: command.device,
          now,
        }),
      )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`
Expected: PASS. Conferir que o teste da sequência de chamadas (`callLog`) de cada spec continua igual: o fake de auditoria não registra no log.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(auth): record audit events for password changes and Google links

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Evento de senha redefinida, com `device` no endpoint

**Files:**
- Modify: `src/modules/auth/use-cases/reset-password.ts` (comando linha 14; transação ~linha 79)
- Modify: `src/modules/auth/infra/http/endpoints/reset-password.ts` (imports; handler linha 84)
- Test: `src/modules/auth/use-cases/reset-password.spec.ts`, `tests/integration/reset-password.spec.ts`

**Interfaces:**
- Consumes: as da Task 4, mais `SessionDevice` (`#modules/auth/services/refresh-token-issuer`) e `buildDeviceContext` (`#infra/http/device-context`).
- Produces: `ResetPasswordCommand.device: SessionDevice` e um evento `PASSWORD_RESET_COMPLETED` por redefinição bem-sucedida.

- [ ] **Step 1: Write the failing tests**

**`reset-password.spec.ts`.** Imports: `AuditEventType`, `InMemoryAuditEventsRepository`. Constantes: `const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const`, `const ONE_EVENT = 1`, `const NO_EVENTS = 0`. Variável `let auditEventsRepository: InMemoryAuditEventsRepository`, criada no `beforeEach` (junto de `outboxMessagesRepository = new …`); em `trackedRepos`, depois de `...noopAuthRepos(),`: `auditEvents: auditEventsRepository,`. O helper passa a incluir o dispositivo:

```ts
const reset = (overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
  useCase.execute({
    token: RAW_TOKEN,
    newPassword: NEW_PASSWORD,
    device: DEVICE,
    ...overrides,
  })
```

Testes novos, dentro do `describe('ResetPasswordUseCase', …)`:

```ts
  it('records a PASSWORD_RESET_COMPLETED audit event with the device that redeemed the token', async () => {
    storeUser()

    await reset()

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.PasswordResetCompleted)
    expect(event?.userId).toBe(USER_ID)
    expect(event?.ip).toBe(DEVICE.ip)
    expect(event?.deviceLabel).toBe(DEVICE.label)
    expect(event?.occurredAt).toEqual(NOW)
  })

  it('records nothing when the token is unusable', async () => {
    findByHashSpy.mockResolvedValueOnce(null)

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
```

Qualquer outra chamada direta a `useCase.execute({ token, newPassword })` no arquivo (fora do helper) passa a exigir `device: DEVICE`; o compilador aponta.

**`tests/integration/reset-password.spec.ts`.** Imports: `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`); constantes (copiadas do estilo de `login.spec.ts`):

```ts
const CHROME_ON_ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const CHROME_ON_ANDROID_LABEL = 'Chrome on Android'
/** The exact type stored; spelled out, not imported. */
const PASSWORD_RESET_COMPLETED_EVENT = 'PASSWORD_RESET_COMPLETED'
const ONE_EVENT = 1
```

No `beforeEach`, `await db.delete(auditEvents)` antes do `db.delete(users)`. Teste novo, depois de `'enqueues a "password was reset" notice …'`:

```ts
  it('records an audit event with the address and device that redeemed the token', async () => {
    const token = await forgotAndFetchToken()

    await app.inject({
      method: POST_METHOD,
      url: RESET_PATH,
      payload: { token, newPassword: NEW_PASSWORD },
      headers: { 'user-agent': CHROME_ON_ANDROID_USER_AGENT },
    })

    const events = await db.select().from(auditEvents)
    const [account] = await db.select().from(users)

    expect(events).toHaveLength(ONE_EVENT)
    expect(events[0]?.type).toBe(PASSWORD_RESET_COMPLETED_EVENT)
    expect(events[0]?.userId).toBe(account?.id)
    expect(events[0]?.deviceLabel).toBe(CHROME_ON_ANDROID_LABEL)
    expect(events[0]?.ip).not.toBeNull()
  })
```

(`users` já é importado no arquivo; conferir e importar `auditEvents` no mesmo bloco de imports de schema.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/reset-password.spec.ts` e `pnpm vitest run --project integration tests/integration/reset-password.spec.ts -t "records an audit event"`
Expected: FAIL — 0 eventos gravados.

- [ ] **Step 3: Write the implementation**

`reset-password.ts`: importar `AuditEvent, AuditEventType` e `import type { SessionDevice } from '#modules/auth/services/refresh-token-issuer'`; o comando:

```ts
export interface ResetPasswordCommand {
  token: string
  newPassword: string
  /** Resolved at the edge by `buildDeviceContext`; the trail records where this came from. */
  device: SessionDevice
}
```

a transação passa a desestruturar `auditEvents`: `async ({ users, refreshTokens, passwordResetTokens, outboxMessages, auditEvents }) => {`; e, depois do `outboxMessages.save(…)`:

```ts
        await auditEvents.save(
          AuditEvent.create({
            id: this.idGenerator.generate(),
            type: AuditEventType.PasswordResetCompleted,
            userId: token.userId,
            device: command.device,
            now,
          }),
        )
```

`endpoints/reset-password.ts`: importar `import { buildDeviceContext } from '#infra/http/device-context'` (mesmo caminho do endpoint de troca de senha) e trocar o handler por:

```ts
    async (request, reply) => {
      await container.resetPassword.execute({
        ...request.body,
        device: buildDeviceContext(request),
      })

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`, `pnpm vitest run --project integration tests/integration/reset-password.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(auth): record an audit event for password resets, with the device

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Evento de conta deletada, com `device` no endpoint

**Files:**
- Modify: `src/modules/auth/use-cases/delete-account.ts` (comando linha 12; transação linha 73)
- Modify: `src/modules/auth/infra/http/endpoints/delete-account.ts` (imports; chamada ~linha 82)
- Test: `src/modules/auth/use-cases/delete-account.spec.ts`, `tests/integration/delete-account.spec.ts`

**Interfaces:**
- Consumes: as da Task 5.
- Produces: `DeleteAccountCommand.device: SessionDevice` e um evento `ACCOUNT_DELETED` gravado **antes** do `users.deleteById`, no mesmo `uow`.

- [ ] **Step 1: Write the failing tests**

**`delete-account.spec.ts`.** Imports: `AuditEventType`, `InMemoryAuditEventsRepository`. Constantes: `const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const`, `const ONE_EVENT = 1`, `const NO_EVENTS = 0`. Variável `let auditEventsRepository: InMemoryAuditEventsRepository`, criada no `beforeEach`; no `repos: AuthRepos = { ...noopAuthRepos(), …`, acrescentar `auditEvents: auditEventsRepository,`. **Cada** chamada existente a `useCase.execute({ userId: …, … })` ganha `device: DEVICE` (o compilador aponta todas). Testes novos:

```ts
describe('DeleteAccountUseCase — audit trail', () => {
  it('records an ACCOUNT_DELETED audit event with the device that asked', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD, device: DEVICE })

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.AccountDeleted)
    expect(event?.userId).toBe(USER_ID)
    expect(event?.ip).toBe(DEVICE.ip)
    expect(event?.deviceLabel).toBe(DEVICE.label)
    expect(event?.occurredAt).toEqual(NOW)
  })

  it('records nothing when the password is wrong', async () => {
    storeUser(STORED_HASH)
    compareResult = false

    await expect(
      useCase.execute({ userId: USER_ID, password: WRONG_PASSWORD, device: DEVICE }),
    ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })

  it('records nothing when the account does not exist', async () => {
    await expect(
      useCase.execute({ userId: MISSING_USER_ID, device: DEVICE }),
    ).rejects.toBeInstanceOf(UserNotFoundError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
})
```

**`tests/integration/delete-account.spec.ts`.** Imports: `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`). Constantes (`CHROME_ON_ANDROID_USER_AGENT` e `CHROME_ON_ANDROID_LABEL` copiadas do `login.spec.ts`, como na Task 5) e `const ACCOUNT_DELETED_EVENT = 'ACCOUNT_DELETED'`. No `beforeEach`, `await db.delete(auditEvents)`. Teste novo, depois de `'queues the deletion notice, which outlives the account'`:

```ts
  it('records an audit event that outlives the account, with the device that asked', async () => {
    const [account] = await db.select().from(users)

    await app.inject({
      method: DELETE_METHOD,
      url: ME_PATH,
      payload: { password: PASSWORD },
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': CHROME_ON_ANDROID_USER_AGENT,
      },
    })

    // The account and everything the cascade owns are gone…
    expect(await db.select().from(users)).toHaveLength(NO_ROWS)

    // …and the event that describes the deletion is not.
    const events = await db.select().from(auditEvents)
    expect(events).toHaveLength(ONE_ROW)
    expect(events[0]?.type).toBe(ACCOUNT_DELETED_EVENT)
    expect(events[0]?.userId).toBe(account?.id)
    expect(events[0]?.deviceLabel).toBe(CHROME_ON_ANDROID_LABEL)
    expect(events[0]?.ip).not.toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/delete-account.spec.ts` e `pnpm vitest run --project integration tests/integration/delete-account.spec.ts -t "audit event"`
Expected: FAIL — 0 eventos; o `typecheck` também acusa o `device` ainda desconhecido.

- [ ] **Step 3: Write the implementation**

`delete-account.ts`: importar `AuditEvent, AuditEventType` e `SessionDevice`; o comando ganha:

```ts
  /** Resolved at the edge by `buildDeviceContext`; the trail records where this came from. */
  device: SessionDevice
```

a transação: `async ({ users, pendingRegistrations, outboxMessages, auditEvents }) => {`, e o evento **antes** do `deleteById`:

```ts
    await this.uow(async ({ users, pendingRegistrations, outboxMessages, auditEvents }) => {
      // Before the delete, in the same transaction. The trail has no foreign key
      // to the account, so the cascade below does not reach it.
      await auditEvents.save(
        AuditEvent.create({
          id: this.idGenerator.generate(),
          type: AuditEventType.AccountDeleted,
          userId: user.id,
          device: command.device,
          now,
        }),
      )

      await users.deleteById(user.id)
      …
```

(o resto do callback fica como está).

`endpoints/delete-account.ts`: importar `buildDeviceContext` (`#infra/http/device-context`) e passar `device: buildDeviceContext(request),` no objeto de `container.deleteAccount.execute({ … })`, depois de `password: request.body.password,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`, `pnpm vitest run --project integration tests/integration/delete-account.spec.ts`
Expected: PASS. O teste de integração é **a prova do problema**: se o `user_id` tivesse FK, o `users.deleteById` ou a cascata apagaria o evento.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(auth): record an audit event for account deletion, with the device

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Evento de reuso detectado

**Files:**
- Modify: `src/modules/auth/use-cases/refresh-token.ts` (ramo de reuso ~linhas 115-140)
- Test: `src/modules/auth/use-cases/refresh-token.spec.ts`, `tests/integration/refresh-token.spec.ts`

**Interfaces:**
- Consumes: as da Task 4. `RefreshTokenUseCase` já recebe `idGenerator` (fatia 24), então o construtor não muda.
- Produces: um evento `REFRESH_TOKEN_REUSE_DETECTED` na transição (`revoked > 0`), gravado antes da busca do dono e fora do `if (owner !== null)`.

- [ ] **Step 1: Write the failing tests**

**`refresh-token.spec.ts`.** Imports: `AuditEventType` e `InMemoryAuditEventsRepository`. Constantes: `const ONE_EVENT = 1`, `const NO_EVENTS = 0`. Variável `let auditEventsRepository: InMemoryAuditEventsRepository`, criada em `build()` (junto de `outboxMessages = new …`); no `makeUow({ … })` de `build()`, acrescentar `auditEvents: auditEventsRepository,` ao objeto (junto de `users: usersRepository,` e `outboxMessages,`). Novo `describe`, ao fim do arquivo (`PAST_GRACE` já existe no módulo):

```ts
describe('RefreshTokenUseCase — reuse audit event', () => {
  it('records ONE event naming the owner, the request address and the session device', async () => {
    // No owner stored on purpose: the event does not need the e-mail.
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(PAST_GRACE)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
    const [event] = auditEventsRepository.events
    expect(event?.type).toBe(AuditEventType.RefreshTokenReuseDetected)
    expect(event?.userId).toBe(USER_ID)
    // The address that PRESENTED the token; the label is the session's.
    expect(event?.ip).toBe(ROTATION_IP)
    expect(event?.deviceLabel).toBe(DEVICE_LABEL)
    expect(event?.occurredAt).toEqual(clockReading)
  })

  it('records nothing when the same spent token is replayed against a dead family', async () => {
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(PAST_GRACE)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(auditEventsRepository.events).toHaveLength(ONE_EVENT)
  })

  it('records nothing for a token revoked by logout, where nothing was left to revoke', async () => {
    store({ revokedAt: NOW })
    clockReading = at(ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })

  it('records nothing inside the grace window, where the family is not revoked', async () => {
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(ONE_MILLISECOND)

    await refresh()

    expect(auditEventsRepository.events).toHaveLength(NO_EVENTS)
  })
})
```

O teste do "COMMITS the family revocation …" monta um `rollingBack` uow à mão com `{ ...noopAuthRepos(), refreshTokens: repository }`: o `noopAuthRepos().auditEvents` já cobre o novo repositório, então ele não muda.

**`tests/integration/refresh-token.spec.ts`.** Imports: `auditEvents` (`#modules/auth/infra/drizzle/schema/audit-events`); constantes `const REUSE_EVENT = 'REFRESH_TOKEN_REUSE_DETECTED'` (spelled out) e, se ainda não houver, `const ONE_EVENT = 1`; no `beforeEach`, `await db.delete(auditEvents)` antes do `db.delete(users)`. Teste novo, depois do teste `'warns the owner ONCE …'`:

```ts
  it('records ONE audit event however many times the spent token is replayed', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    await ageOutTheGraceWindow()

    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      const reused = await refresh({ refreshToken })
      expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)
    }

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.type, REUSE_EVENT))

    expect(events).toHaveLength(ONE_EVENT)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/refresh-token.spec.ts` e `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts -t "audit event"`
Expected: FAIL — 0 eventos.

- [ ] **Step 3: Write the implementation**

`refresh-token.ts`: importar `import { AuditEvent, AuditEventType } from '#modules/auth/entities/audit-event'`; a desestruturação passa a `const { refreshTokens, users, outboxMessages, auditEvents } = repos`; e, no ramo `if (revoked > 0) {`, **antes** de `const owner = await users.findById(…)`:

```ts
          // The fact, before the notice: it needs the family owner's id, which
          // this row already carries, and not the address `findById` fetches.
          await auditEvents.save(
            AuditEvent.create({
              id: this.idGenerator.generate(),
              type: AuditEventType.RefreshTokenReuseDetected,
              userId: current.userId,
              device: { ip: command.ip, label: current.deviceLabel },
              now,
            }),
          )

```

(o `const owner = …` e o `if (owner !== null)` ficam exatamente como estão.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm lint:fix`, `pnpm typecheck`, `pnpm test:unit`, `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(auth): record an audit event when reuse detection revokes a family

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Prove the test bites, then revert**

Com o commit feito (a árvore está limpa), em `refresh-token.ts` trocar temporariamente `if (revoked > 0) {` por `if (revoked >= 0) {`, rodar `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts -t "audit event however many"` e ver **FAIL** com "expected length 1 but got 3"; depois `git checkout src/modules/auth/use-cases/refresh-token.ts` e conferir `git status --short` vazio.

---

### Task 8: Documentação (§11 da spec)

**Files:**
- Modify: `docs/DECISIONS.md` (decisão 43 depois da 42; nota na decisão 37)
- Modify: `docs/TODO.md` (cabeçalho, linha #6, "Próxima fatia", ordem da auditoria)
- Modify: `docs/superpowers/specs/2026-09-20-audit-trail-design.md` (§8, teste de atomicidade)

**Interfaces:** nenhuma.

- [ ] **Step 1: Decisão 43 no `DECISIONS.md`**

Inserir depois do "Spec: …session-absolute-lifetime-design.md" da decisão 42 (e antes do `---` da seção 7):

```markdown
### 43 — Trilha de auditoria: o mecanismo e os cinco avisos de segurança

Fecha o item #6 de "Pendências do boilerplate". Os eventos de segurança do `auth`
deixavam três rastros e nenhum era uma trilha: o aviso por e-mail (vai para o dono
e é podado em 7 dias), a linha de log `securityEvent` (sem retenção garantida e sem
consulta por conta) e o próprio estado (uma senha trocada não diz quando nem de
onde). Não havia onde responder "o que aconteceu com esta conta, quando e de
onde", que é o que a LGPD art. 37 cobra de quem opera dados pessoais.

**O desenho.** Tabela `audit_events` dentro do módulo `auth`: `id`, `type`,
`user_id`, `ip`, `device_label`, `occurred_at`. Porta `IAuditEventsRepository`
(`save`, `deleteOccurredBefore`) exposta no `AuthRepos`, então cada use case grava
o evento dentro do `uow` que já existe, ao lado do aviso do outbox.

**Nasce dentro do `auth`, e com cinco consumidores.** A decisão 33 recusou o outbox
genérico em `shared/` antes de um segundo módulo, e a decisão 37 recusou criar a
tabela só para a deleção ("resolveria o problema maior pela metade e para um
evento só"). O #6 entra com os cinco pontos que já gravam um aviso de segurança:
senha alterada, senha redefinida, Google vinculado, reuso detectado e conta
deletada. Nenhum evento foi inventado.

**`user_id` sem FK**, para a trilha sobreviver à conta apagada: uma FK bloquearia
o delete ou levaria a evidência junto na cascata. O evento `ACCOUNT_DELETED` é a
prova, e o teste de integração a mede: a conta e a cascata somem, o evento fica.

**IP e aparelho nos cinco.** Só três dos cinco use cases já recebiam o contexto do
cliente. A redefinição de senha e a deleção de conta passaram a receber `device`
(os endpoints chamam `buildDeviceContext`), porque uma trilha que não diz de onde
veio a deleção é fraca para o que a LGPD cobra. O `User-Agent` cru continua fora
(decisão 38); o rótulo é o derivado.

**O reuso grava só na transição**, como o aviso da decisão 41 (`revoked > 0`), e
o evento é gravado antes da busca do dono e fora do `if (owner !== null)`: ele não
precisa do e-mail, então não mora sob uma condição que é sobre o e-mail. Os replays
seguem só no log `securityEvent`.

**Retenção por variável:** `AUDIT_EVENT_PRUNE_RETENTION_SECONDS`, padrão 1 ano, com
um job de poda no cron. O número é **marcador**, não conselho jurídico: quanto
guardar é decisão de produto e de compliance.

**Medido:** três reapresentações do mesmo token gasto deixam **um** evento em
`audit_events`; com a condição removida de propósito, deixam três. E um evento
gravado numa unit of work que depois falha é desfeito, e sem falha é confirmado
(prova o `auditEvents` ligado à transação e não ao pool).

**Recusado.** *Um mecanismo em `shared/`:* nenhum segundo módulo consome. *Só a
tabela, sem eventos:* contrato sem consumidor, não valida a forma. *Coluna JSON
livre de metadados:* sem consumidor, sem forma validada; cada evento novo que
precise de um dado ganha uma coluna. *E-mail do usuário na linha:* dado pessoal que
sobreviveria à conta. *Eventos de login e logout:* volume alto, e a decisão de
quanto guardar deixa de ser trivial.

**Custos aceitos.**

1. O `user_id` continua na trilha depois da conta apagada: é identificador
   pseudonimizado, e a trilha existe justamente para provar o que aconteceu.
2. IP e aparelho ficam em repouso pelo tempo da retenção, que é maior que os 7 dias
   do outbox. O mesmo dado já vive 60 dias em `refresh_tokens` (decisão 38).
3. O reuso registra só a primeira detecção.
4. Sem leitura pela API: o operador consulta por SQL. Uma rota é o passo natural
   seguinte e é decisão de produto.
5. O padrão de 1 ano é um marcador, não uma resposta de compliance.
6. O banco não impede escrever um `type` fora do conjunto: a validação está no
   tipo da entidade e a coluna é `text`. Um `CHECK` custaria uma migration por
   evento novo.

Spec: [`specs/2026-09-20-audit-trail-design.md`](superpowers/specs/2026-09-20-audit-trail-design.md).

```

Na decisão 37, trocar a frase final do parágrafo "**Sem tabela de eventos de auditoria.**":
`evitaram. Quando o gatilho disparar, a deleção é um dos eventos a capturar.` por
`evitaram. Quando o gatilho disparar, a deleção é um dos eventos a capturar.
**Emenda (decisão 43):** o mecanismo veio com a fatia 26, e a deleção é gravada como \`ACCOUNT_DELETED\`.`

- [ ] **Step 2: `TODO.md`**

(a) Antes do parágrafo "> **Fatia 25 (2026-09-19) entregou o teto absoluto", dentro do bloco `>` do cabeçalho:

```markdown
> **Fatia 26 (2026-09-20) entregou a trilha de auditoria** (decisão 43). Fecha o
> item #6 de "Pendências do boilerplate". Tabela `audit_events` dentro do `auth`,
> sem FK em `user_id` para sobreviver à conta apagada, e um evento gravado nos
> cinco pontos que já avisam o dono (senha alterada, senha redefinida, Google
> vinculado, reuso detectado, conta deletada), na mesma transação, com IP e
> aparelho. A retenção é `AUDIT_EVENT_PRUNE_RETENTION_SECONDS` (1 ano, marcador).
> Sem leitura pela API: o operador consulta por SQL.
>
```

(b) Linha #6 da tabela vira:

```markdown
| 6 | ~~Trilha de auditoria — só o mecanismo~~ | — | **fechado pela fatia 26.** `audit_events` no `auth`, cinco eventos de segurança gravados no `uow`, poda pelo cron. Decisão 43 |
```

(c) Em "Próxima fatia", trocar "Restam o\n#6 (trilha de auditoria, só o mecanismo) e o #7 (`kid` no JWT); o #5\n(checagem de senha vazada) foi **adiado em 2026-09-19** com gatilho próprio, na\ntabela acima." por "~~Trilha de auditoria~~ — **fechada pela fatia 26** (decisão 43).\nResta o #7 (`kid` no JWT), que compra pouco; o #5 (checagem de senha vazada) foi\n**adiado em 2026-09-19** com gatilho próprio, na tabela acima."

(d) Na ordem da auditoria, trocar "(5) trilha de auditoria e\n~~teto absoluto de sessão~~, fechado pela fatia 25; (6) MFA." por "(5) ~~trilha de\nauditoria~~, fechada pela fatia 26, e ~~teto absoluto de sessão~~, fechado pela\nfatia 25; (6) MFA."

- [ ] **Step 3: Emenda na spec (§8)**

Em `docs/superpowers/specs/2026-09-20-audit-trail-design.md`, trocar
`- Atomicidade: uma troca de senha cuja transação falha não deixa evento; uma que\n  passa deixa exatamente um.`
por
`- Atomicidade: pela unit of work do container real, um evento gravado e seguido de\n  falha é desfeito, e sem falha é confirmado. Prova que \`auditEvents\` está ligado à\n  transação; forçar a falha dentro de um use case exigiria um fake artificial.`

- [ ] **Step 4: Verify and commit**

Run: `pnpm lint` e `pnpm typecheck` (cada um sozinho, exit 0).

```bash
git add docs
git commit -m "docs(auth): record decision 43 and close the audit trail item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Verificação final

- [ ] **Step 1:** `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` — cada um sozinho, exit 0; anotar a contagem de testes.
- [ ] **Step 2:** `pnpm test:integration` (Postgres, Redis e `REDIS_URL` de pé) — tudo verde.
- [ ] **Step 3:** `node .claude/skills/architecture-audit/scripts/audit-scan.mjs --base 4986478` e a leitura do passo 3 da skill `architecture-audit`: **0 achados** bloqueantes. Pontos de atenção da leitura: o `audit_events.user_id` sem `references`; nenhum dado sensível (senha, hash, token) nas colunas nem em log; `AuditEvent` com estado em campos `#`; nenhum `new Date()` na camada pura; a migration é nova, com `--name`, e o `snapshot.json` foi gerado.
- [ ] **Step 4:** Chamar `superpowers:finishing-a-development-branch`; pelo `CLAUDE.md` global, logo após ela confirmar os testes, invocar `finish-with-review-pr`. Antes de qualquer push, oferecer ao usuário a revisão local (`git reset --soft` para o último commit publicado), como nas fatias anteriores.
