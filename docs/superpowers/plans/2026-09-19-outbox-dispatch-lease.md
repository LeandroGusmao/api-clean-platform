# Fatia 23 — Outbox: etiqueta com prazo no dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada mensagem do outbox é pega com uma etiqueta de prazo antes de ser enviada, para que execuções concorrentes do dispatch trabalhem em mensagens diferentes e nenhuma seja enviada duas vezes por concorrência.

**Architecture:** `claimNext(now, leaseUntil)` substitui `findPendingBatch`: uma instrução única (`UPDATE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING`) que etiqueta e devolve a mais antiga pendente e sem etiqueta vigente. O use case pega uma mensagem por vez; uma falha mantém a etiqueta, então o prazo também é o intervalo entre tentativas. O transporte SMTP ganha timeouts explícitos, porque a etiqueta só é confiável se o envio tem limite.

**Tech Stack:** Node 24, TypeScript 7, Drizzle 1.0.0-rc.4 (`drizzle-kit` para a migration), Postgres 18, nodemailer 9.1.1, Vitest 4, Biome 2.5.9, pnpm 11.

**Spec:** [`docs/superpowers/specs/2026-09-19-outbox-dispatch-lease-design.md`](../specs/2026-09-19-outbox-dispatch-lease-design.md) — leia junto: o plano argumenta a partir dela.

## Global Constraints

- Todo código, identificador, string, log e comentário em **inglês**; arquivos `*.md` podem ficar em português (`CLAUDE.md`).
- **Sem strings ou números mágicos** inline: constante nomeada, `UPPER_SNAKE_CASE`, perto do uso (`CLAUDE.md`). Vale também para os testes.
- **Comentários explicam o código, não a tarefa**: nada de "a revisão achou", "a fatia 23 mudou isto". Cite (`decision 40`), não reargumente (`CLAUDE.md`).
- Dependências em versão exata; esta fatia não adiciona nenhuma.
- Migration **sempre com `--name=`** e em pasta nova; migration aplicada é imutável (`ARCHITECTURE.md` §6, R4).
- Só `src/infra/config/env.ts` lê `process.env` (R6).
- Biome: 2 espaços, aspas simples, sem ponto e vírgula, vírgula final, largura 90. `pnpm lint:fix` resolve formatação; `pnpm lint` tem de sair limpo.
- TypeScript estrito com `exactOptionalPropertyTypes` e `verbatimModuleSyntax`.
- Imports: alias `#infra/*`, `#modules/*`, `#shared/*` entre pastas; caminho relativo com `.js` dentro da mesma pasta.
- Commits: Conventional Commits em inglês, sem narrativa de processo, terminando com o trailer `Co-Authored-By` da sessão que executa.
- A suíte de integração exige `pnpm db:up` (Postgres de teste, Mailpit e Redis de teste).
- **Antes de começar:** se o Postgres de teste já recebeu uma migration `*_outbox_claimed_until` de uma tentativa anterior, o migrator tentaria aplicar a nova pasta e falharia com "column already exists". O banco de teste é `tmpfs`: `docker restart api-clean-platform-postgres-test` o zera, e o `globalSetup` reaplica tudo do repositório.

## File Structure

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `src/modules/auth/config.ts` | `OUTBOX_DISPATCH_LEASE_SECONDS` e seu default | 1 |
| `src/infra/providers/smtp-email-sender.ts` | Timeouts explícitos do transporte | 1 |
| `src/modules/auth/infra/drizzle/schema/outbox-messages.ts` | Coluna `claimed_until` | 2 |
| `drizzle/<timestamp>_outbox_claimed_until/` | A migration | 2 |
| `src/modules/auth/infra/drizzle/outbox-message-mapper.ts` | O insert deixa a etiqueta de fora | 2 |
| `src/modules/auth/repositories/outbox-messages-repository.ts` | A porta: `claimNext` no lugar de `findPendingBatch` | 3 |
| `src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts` | A instrução única | 3 |
| `src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts` | O mesmo contrato, em memória | 3 |
| `src/modules/auth/use-cases/dispatch-outbox-messages.ts` | O laço de uma mensagem por viagem | 3 |
| `src/modules/auth/container.ts` | Entrega o prazo ao use case | 3 |
| `tests/integration/dispatch-outbox-concurrency.spec.ts` | As provas: cada mensagem uma vez, etiqueta que vence | 4 |

---

### Task 1: O prazo da etiqueta e os limites do envio SMTP

**Files:**
- Modify: `src/modules/auth/config.ts`, `src/modules/auth/config.spec.ts`
- Modify: `src/infra/config/env.spec.ts`, `src/infra/config/fixtures/test-env.ts`
- Modify: `src/infra/providers/smtp-email-sender.ts`, `src/infra/providers/smtp-email-sender.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `Env` ganha `OUTBOX_DISPATCH_LEASE_SECONDS: number` (default `120`). `#modules/auth/config` exporta `DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS`. `#infra/providers/smtp-email-sender` exporta `SMTP_CONNECTION_TIMEOUT_MS` (`10_000`), `SMTP_GREETING_TIMEOUT_MS` (`10_000`) e `SMTP_SOCKET_TIMEOUT_MS` (`30_000`), e `smtpTransportOptions` os passa ao nodemailer.

- [ ] **Step 1: Escrever os testes (red)**

O guarda em `env.spec.ts` amarra dois números que vivem em módulos diferentes: o padrão da etiqueta tem de ser maior que a soma dos três timeouts. Os testes do SMTP têm uma asserção de tipo a mais de propósito: sem ela, `undefined` seria igual a `undefined` e o teste passaria antes de o código existir.

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('src/modules/auth/config.spec.ts', [
("  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n",
 "  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n"),
("    expect(config.OUTBOX_DISPATCH_BATCH_SIZE).toBe(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE)\n",
 "    expect(config.OUTBOX_DISPATCH_BATCH_SIZE).toBe(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE)\n    expect(config.OUTBOX_DISPATCH_LEASE_SECONDS).toBe(\n      DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n    )\n"),
("""      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_MAX_ATTEMPTS: '' }),
    ).toThrow()
  })
})
""",
"""      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_MAX_ATTEMPTS: '' }),
    ).toThrow()
  })

  it('rejects an empty outbox claim lease instead of coercing it to zero', () => {
    // Zero would expire every claim the moment it is taken.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_LEASE_SECONDS: '' }),
    ).toThrow()
  })
})
"""),
])

edit('src/infra/config/env.spec.ts', [
("  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n",
 "  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n"),
("  parseEnv,\n} from '#infra/config/env'\n",
 "  parseEnv,\n} from '#infra/config/env'\nimport {\n  SMTP_CONNECTION_TIMEOUT_MS,\n  SMTP_GREETING_TIMEOUT_MS,\n  SMTP_SOCKET_TIMEOUT_MS,\n} from '#infra/providers/smtp-email-sender'\n"),
("      OUTBOX_DISPATCH_BATCH_SIZE: DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n",
 "      OUTBOX_DISPATCH_BATCH_SIZE: DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n      OUTBOX_DISPATCH_LEASE_SECONDS: DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n"),
])
s = open('src/infra/config/env.spec.ts').read().rstrip('\n')
s += """

const MILLISECONDS_PER_SECOND = 1000

// The claim on an outbox message has to outlast the longest a single send can
// stall, or a second run picks the message up and sends it again (decision 40).
// The two numbers live in different modules, so nothing else keeps them together.
describe('the outbox claim lease', () => {
  it('outlasts a stalled SMTP send at the shipped defaults', () => {
    const stalledSendMs =
      SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS

    expect(DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS * MILLISECONDS_PER_SECOND).toBeGreaterThan(
      stalledSendMs,
    )
  })
})
"""
open('src/infra/config/env.spec.ts', 'w').write(s)

edit('src/infra/providers/smtp-email-sender.spec.ts', [
("import { type SmtpEmailSenderConfig, smtpTransportOptions } from './smtp-email-sender.js'\n",
 "import {\n  SMTP_CONNECTION_TIMEOUT_MS,\n  SMTP_GREETING_TIMEOUT_MS,\n  SMTP_SOCKET_TIMEOUT_MS,\n  type SmtpEmailSenderConfig,\n  smtpTransportOptions,\n} from './smtp-email-sender.js'\n"),
("""  it('pools connections rather than opening a fresh one per send', () => {
    expect(smtpTransportOptions(baseConfig).pool).toBe(true)
  })
""",
"""  it('pools connections rather than opening a fresh one per send', () => {
    expect(smtpTransportOptions(baseConfig).pool).toBe(true)
  })

  it('bounds a single send with explicit timeouts instead of the library defaults', () => {
    const options = smtpTransportOptions(baseConfig)

    expect(options.connectionTimeout).toBeTypeOf('number')
    expect(options.greetingTimeout).toBeTypeOf('number')
    expect(options.socketTimeout).toBeTypeOf('number')
    expect(options.connectionTimeout).toBe(SMTP_CONNECTION_TIMEOUT_MS)
    expect(options.greetingTimeout).toBe(SMTP_GREETING_TIMEOUT_MS)
    expect(options.socketTimeout).toBe(SMTP_SOCKET_TIMEOUT_MS)
  })
"""),
])
print('task 1 tests edited')
PYEOF
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:unit src/modules/auth/config.spec.ts src/infra/providers/smtp-email-sender.spec.ts src/infra/config/env.spec.ts`

Expected: FAIL em exatamente 3 testes: `bounds a single send with explicit timeouts instead of the library defaults`, `rejects an empty outbox claim lease instead of coercing it to zero` e `outlasts a stalled SMTP send at the shipped defaults`.

- [ ] **Step 3: Implementar**

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('src/modules/auth/config.ts', [
("""/**
 * Five attempts before a pending notice gives up and stops being retried
 * (design §3, §8). The interval BETWEEN attempts is whatever the external
 * scheduler invoking `cron.ts` is set to — that already is the backoff
 * (decision 30, §3.1 of the slice 13 design).
 */
export const DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS = 5

/** How many pending rows one dispatch run picks up. */
export const DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE = 100
""",
"""/**
 * Five attempts before a pending notice gives up and stops being retried
 * (design §3, §8). The interval BETWEEN attempts is the claim lease below: a
 * message whose send failed keeps its claim, so it is offered again only when
 * the claim expires (decision 40).
 */
export const DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS = 5

/** The most messages one dispatch run handles. */
export const DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE = 100

/**
 * How long a dispatch run's claim on a message lasts (decision 40). It has to
 * outlast the longest a single send can stall — the SMTP timeouts bound that —
 * or a second run picks the message up and sends it again. It is also the wait
 * between two attempts at a message whose send failed.
 */
export const DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS = 120
"""),
("""    .default(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE),
""",
"""    .default(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE),
  // `.positive()` for the same reason: zero would expire every claim the moment
  // it is taken, and two runs would send the same message.
  OUTBOX_DISPATCH_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS),
"""),
])

edit('src/infra/config/fixtures/test-env.ts', [
("  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n",
 "  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,\n"),
("  OUTBOX_DISPATCH_BATCH_SIZE: DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n",
 "  OUTBOX_DISPATCH_BATCH_SIZE: DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,\n  OUTBOX_DISPATCH_LEASE_SECONDS: DEFAULT_OUTBOX_DISPATCH_LEASE_SECONDS,\n"),
])

edit('.env.example', [
("""# Outbox dispatch retry cap, batch size, and how long a settled row survives
# before the cron prunes it
OUTBOX_DISPATCH_MAX_ATTEMPTS=5
OUTBOX_DISPATCH_BATCH_SIZE=100
OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS=604800
""",
"""# Outbox dispatch retry cap, batch size, how long a settled row survives before
# the cron prunes it, and how long a run's claim on a message lasts. The claim
# must outlast a stalled SMTP send (50 s at the shipped timeouts) or two runs
# send the same message; it is also the wait between two attempts at a message
# whose send failed.
OUTBOX_DISPATCH_MAX_ATTEMPTS=5
OUTBOX_DISPATCH_BATCH_SIZE=100
OUTBOX_DISPATCH_LEASE_SECONDS=120
OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS=604800
"""),
])

edit('src/infra/providers/smtp-email-sender.ts', [
("const POOL_ENABLED = true\n",
"""const POOL_ENABLED = true

/**
 * Bounds on a single send, so a stalled connection cannot hold a dispatch run
 * past the claim it holds (decision 40). nodemailer's own defaults are 2
 * minutes to connect, 30 seconds for the greeting and 10 minutes of socket
 * inactivity. These cut a stalled connection; a server that answers every
 * command slowly is not cut, because the socket timeout restarts with each reply.
 */
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000
export const SMTP_GREETING_TIMEOUT_MS = 10_000
export const SMTP_SOCKET_TIMEOUT_MS = 30_000
"""),
("    pool: POOL_ENABLED,\n",
 "    pool: POOL_ENABLED,\n    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,\n    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,\n    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,\n"),
])
print('task 1 implementation edited')
PYEOF
```

- [ ] **Step 4: Verificar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
```

Expected: lint e typecheck limpos; `test:unit` verde com 58 arquivos e 511 testes. O `lint:fix` reformata um arquivo (a ordem dos imports).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts src/infra/config src/infra/providers .env.example
git commit -m "feat(auth): add the outbox claim lease and bound the SMTP send"
```

---

### Task 2: A coluna da etiqueta

**Files:**
- Modify: `src/modules/auth/infra/drizzle/schema/outbox-messages.ts`
- Modify: `src/modules/auth/infra/drizzle/outbox-message-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/outbox-message-mapper.spec.ts`
- Create: `drizzle/<timestamp>_outbox_claimed_until/` (gerada)
- Test: `tests/integration/outbox-messages-schema.spec.ts`

**Interfaces:**
- Produces: `outboxMessages.claimedUntil` (`timestamp with time zone`, nulável, sem default). `toPersistenceOutboxMessage` deixa de exigir essa coluna: o insert a omite e o banco grava `NULL`.

- [ ] **Step 1: Escrever os testes (red)**

O spec do mapper é uma guarda: ele passa antes e depois, porque o mapper hoje já não menciona a coluna. Quem fica vermelho é o spec de schema.

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('tests/integration/outbox-messages-schema.spec.ts', [
("const CREATED_AT = new Date('2026-09-15T00:00:00.000Z')\n",
 "const CREATED_AT = new Date('2026-09-15T00:00:00.000Z')\nconst CLAIMED_UNTIL = new Date('2026-09-15T00:02:00.000Z')\n"),
("  it('stores a row with every column, dispatchedAt/failedAt/lastError null by default input', async () => {\n",
 "  it('stores a row with every column, dispatchedAt/failedAt/lastError/claimedUntil null by default input', async () => {\n"),
("    expect(stored?.failedAt).toBeNull()\n    expect(stored?.createdAt).toEqual(CREATED_AT)\n  })\n",
 """    expect(stored?.failedAt).toBeNull()
    expect(stored?.claimedUntil).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('stores the instant a claim expires', async () => {
    await db.insert(outboxMessages).values(row({ claimedUntil: CLAIMED_UNTIL }))

    const [stored] = await db.select().from(outboxMessages)

    expect(stored?.claimedUntil).toEqual(CLAIMED_UNTIL)
  })
"""),
])

open('src/modules/auth/infra/drizzle/outbox-message-mapper.spec.ts', 'w').write("""import { describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { toPersistenceOutboxMessage } from './outbox-message-mapper.js'

const NOW = new Date('2026-09-19T12:00:00.000Z')

describe('toPersistenceOutboxMessage', () => {
  // A message is born unclaimed, and only `claimNext` ever writes the column:
  // the insert leaves it out and the database stores NULL.
  it('leaves the claim out of the insert', () => {
    const message = OutboxMessage.create({
      id: 'message-1',
      message: { to: 'joao@example.com', subject: 'subject', text: 'text' },
      now: NOW,
    })

    expect(toPersistenceOutboxMessage(message)).not.toHaveProperty('claimedUntil')
  })
})
""")
print('task 2 tests written')
PYEOF
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:integration tests/integration/outbox-messages-schema.spec.ts`

Expected: FAIL em 2 testes (`stores a row with every column, … claimedUntil null by default input` e `stores the instant a claim expires`): a coluna ainda não existe no schema.

- [ ] **Step 3: Implementar o schema e o mapper**

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('src/modules/auth/infra/drizzle/schema/outbox-messages.ts', [
("    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),\n",
 """    /**
     * Set when a dispatch run picks the message up: it is not offered to another
     * run until this instant has passed (decision 40). Null until first claimed.
     * No default, like every other time column — the instant comes from `IClock`.
     */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
"""),
])

edit('src/modules/auth/infra/drizzle/outbox-message-mapper.ts', [
("""export function toPersistenceOutboxMessage(
  message: OutboxMessage,
): Omit<OutboxMessageRow, 'id'> & { id: string } {
""",
"""/**
 * The claim is not part of the insert: a message is born unclaimed, and only
 * `claimNext` ever writes the column, so the database stores NULL.
 */
export function toPersistenceOutboxMessage(
  message: OutboxMessage,
): Omit<OutboxMessageRow, 'id' | 'claimedUntil'> & { id: string } {
"""),
])
print('task 2 implementation edited')
PYEOF
```

- [ ] **Step 4: Gerar a migration**

```bash
pnpm db:generate --name=outbox_claimed_until
cat drizzle/*_outbox_claimed_until/migration.sql
```

Expected, exatamente esta linha (a pasta leva o timestamp do momento em que você roda):

```sql
ALTER TABLE "outbox_messages" ADD COLUMN "claimed_until" timestamp with time zone;
```

- [ ] **Step 5: Rodar e ver passar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
pnpm test:integration tests/integration/outbox-messages-schema.spec.ts
pnpm test:unit src/modules/auth/infra/drizzle
```

Expected: o `globalSetup` aplica a migration ao banco de teste; o spec de schema passa com 4 testes e o do mapper com 1.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/infra/drizzle tests/integration/outbox-messages-schema.spec.ts drizzle
git commit -m "feat(auth): add claimed_until to outbox_messages"
```

---

### Task 3: `claimNext` no lugar de `findPendingBatch`

**Files:**
- Modify: `src/modules/auth/repositories/outbox-messages-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Modify: `src/modules/auth/use-cases/dispatch-outbox-messages.ts`
- Modify: `src/modules/auth/container.ts`
- Test: `src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts`
- Test: `src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts`
- Test: `tests/integration/drizzle-outbox-messages-repository.spec.ts`
- Modify (encaminhadores e uma asserção): `src/modules/auth/use-cases/reset-password.spec.ts`, `change-password.spec.ts`, `sign-in-with-google.spec.ts`, `prune-outbox-messages.spec.ts`

**Interfaces:**
- Consumes: `outboxMessages.claimedUntil` (Task 2) e `Env.OUTBOX_DISPATCH_LEASE_SECONDS` (Task 1).
- Produces:
  - `IOutboxMessagesRepository.claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null>`; `findPendingBatch` deixa de existir.
  - `new DispatchOutboxMessagesUseCase(outboxMessages, emailSender, clock, maxAttempts, batchSize, leaseMs)`: o sexto argumento é novo, em milissegundos.

Este é um passo atômico de propósito: a porta, as três implementações, o use case e os specs que a usam mudam juntos, para cada commit continuar compilando.

- [ ] **Step 1: Escrever os testes (red)**

Reescreve por inteiro os specs do repositório em memória, do use case e do repositório Drizzle, e troca os encaminhadores dos specs dos produtores. O teste antigo de `markDispatched` usava `Object.create(repository)`, que não funciona mais com os campos privados do repositório em memória; ele passa a usar `vi.spyOn`.

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

# ---- in-memory repository spec: whole file
open('src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts', 'w').write("""import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LEASE_UNTIL = new Date('2026-09-15T12:02:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const ONE_ROW = 1
const ERROR_MESSAGE = 'connection refused'

const messageAt = (id: string, createdAt: Date) =>
  OutboxMessage.create({
    id,
    message: { to: `${id}@example.com`, subject: 'subject', text: 'text' },
    now: createdAt,
  })

let repository: InMemoryOutboxMessagesRepository

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
})

describe('InMemoryOutboxMessagesRepository', () => {
  it('claims pending rows oldest first, one at a time', async () => {
    await repository.save(messageAt('newest', LATER))
    await repository.save(messageAt('oldest', NOW))

    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe('oldest')
    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe('newest')
    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a dispatched row', async () => {
    await repository.save(messageAt('done', NOW))
    await repository.markDispatched('done', LATER)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a permanently failed row', async () => {
    await repository.save(messageAt('doomed', NOW))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    }

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a claimed row until its claim expires', async () => {
    await repository.save(messageAt('only', NOW))
    await repository.claimNext(NOW, LEASE_UNTIL)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
    // The claim runs out AT its expiry: `claimed_until <= now` no longer counts.
    expect((await repository.claimNext(LEASE_UNTIL, LATER))?.id).toBe('only')
  })

  it('records a failure below the cap without marking it failed', async () => {
    await repository.save(messageAt('retry-me', NOW))

    await repository.recordFailure('retry-me', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)

    const [stored] = repository.messages
    expect(stored?.attempts).toBe(ONE_ROW)
    expect(stored?.lastError).toBe(ERROR_MESSAGE)
    expect(stored?.failedAt).toBeNull()
  })

  it('keeps the claim when a failure is recorded', async () => {
    await repository.save(messageAt('retry-me', NOW))
    await repository.claimNext(NOW, LEASE_UNTIL)

    await repository.recordFailure('retry-me', NOW, ERROR_MESSAGE, MAX_ATTEMPTS)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('deletes only dispatched or failed rows before the cutoff', async () => {
    await repository.save(messageAt('old-dispatched', NOW))
    await repository.markDispatched('old-dispatched', NOW)
    await repository.save(messageAt('still-pending', NOW))

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    expect(repository.messages.map((message) => message.id)).toEqual(['still-pending'])
  })
})
""")

# ---- dispatch use case spec: whole file
open('src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts', 'w').write("""import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import {
  DISPATCH_OUTBOX_MESSAGES_JOB,
  DispatchOutboxMessagesUseCase,
} from '#modules/auth/use-cases/dispatch-outbox-messages'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const MAX_ATTEMPTS = 3
const BATCH_SIZE = 10
const SMALL_BATCH_SIZE = 2
const LEASE_MS = 120_000
const NONE = 0
const ONE = 1
const TWO = 2

const message = (to: string): EmailMessage => ({ to, subject: 'subject', text: 'text' })

let clockNow: Date
let repository: InMemoryOutboxMessagesRepository
let sendCalls: string[]
let sentTo: string[]
let failing: Set<string>
let emailSender: IEmailSender
let useCase: DispatchOutboxMessagesUseCase

const clock = { now: () => clockNow }
const unsettled = () =>
  repository.messages.filter(
    (stored) => stored.dispatchedAt === null && stored.failedAt === null,
  )

beforeEach(() => {
  clockNow = NOW
  repository = new InMemoryOutboxMessagesRepository()
  sendCalls = []
  sentTo = []
  failing = new Set()

  emailSender = {
    send: async (m) => {
      sendCalls.push(m.to)
      if (failing.has(m.to)) throw new Error(`smtp refused ${m.to}`)
      sentTo.push(m.to)
    },
  }

  useCase = new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    clock,
    MAX_ATTEMPTS,
    BATCH_SIZE,
    LEASE_MS,
  )
})

const seed = async (...recipients: string[]) => {
  for (const to of recipients) {
    await repository.save(
      OutboxMessage.create({ id: to, message: message(to), now: NOW }),
    )
  }
}

describe('DispatchOutboxMessagesUseCase', () => {
  it('names its job', () => {
    expect(DISPATCH_OUTBOX_MESSAGES_JOB).toBe('dispatch-outbox-messages')
  })

  it('reports zero/zero on an empty batch, without calling the sender', async () => {
    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: NONE })
    expect(sendCalls).toEqual([])
  })

  it('marks a successfully sent message dispatched', async () => {
    await seed('ok@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: ONE, failed: NONE })
    expect(sentTo).toEqual(['ok@example.com'])
    expect(unsettled()).toHaveLength(NONE)
  })

  it('records a failure without marking the row failed, below the cap', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: ONE })
    const [stored] = repository.messages
    expect(stored?.attempts).toBe(ONE)
    expect(stored?.failedAt).toBeNull()
  })

  /**
   * The falsification that matters most here: one bad row in the middle of a
   * batch must not stop the rows around it from being sent. A `toContain`
   * assertion instead of this one would stay green even if a thrown `send`
   * aborted the whole loop.
   */
  it('isolates a failure: the rest of the batch still gets processed', async () => {
    failing.add('bad@example.com')
    await seed('first@example.com', 'bad@example.com', 'last@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: TWO, failed: ONE })
    expect(sentTo.sort()).toEqual(['first@example.com', 'last@example.com'])
  })

  it('respects the batch size', async () => {
    await seed('a@example.com', 'b@example.com', 'c@example.com')
    const smallBatchUseCase = new DispatchOutboxMessagesUseCase(
      repository,
      emailSender,
      clock,
      MAX_ATTEMPTS,
      SMALL_BATCH_SIZE,
      LEASE_MS,
    )

    const result = await smallBatchUseCase.execute()

    expect(result).toEqual({ dispatched: SMALL_BATCH_SIZE, failed: NONE })
    expect(unsettled()).toHaveLength(ONE)
  })

  it('claims each message for the configured lease', async () => {
    await seed('a@example.com')
    const claim = vi.spyOn(repository, 'claimNext')

    await useCase.execute()

    expect(claim).toHaveBeenCalledWith(NOW, new Date(NOW.getTime() + LEASE_MS))
  })

  // Releasing the claim on a failure would hand the same message straight back
  // to the loop — it is the oldest — and spend every attempt within one run.
  it('keeps the claim on a failed message until it expires', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')
    await useCase.execute()

    expect(await useCase.execute()).toEqual({ dispatched: NONE, failed: NONE })
    expect(sendCalls).toEqual(['bad@example.com'])

    clockNow = new Date(NOW.getTime() + LEASE_MS)

    expect(await useCase.execute()).toEqual({ dispatched: NONE, failed: ONE })
    expect(sendCalls).toEqual(['bad@example.com', 'bad@example.com'])
    expect(repository.messages[0]?.attempts).toBe(TWO)
  })

  // The problem the claim exists to close: the second run starts while the first
  // is in the middle of a send, and must not pick the same message up.
  it('never sends the same message twice when two runs overlap', async () => {
    await seed('a@example.com', 'b@example.com', 'c@example.com')
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    emailSender.send = async (m) => {
      sendCalls.push(m.to)
      if (m.to === 'a@example.com') {
        started.resolve()
        await gate.promise
      }
      sentTo.push(m.to)
    }

    const first = useCase.execute()
    await started.promise
    const second = await useCase.execute()
    gate.resolve()
    const firstResult = await first

    expect(second).toEqual({ dispatched: TWO, failed: NONE })
    expect(firstResult).toEqual({ dispatched: ONE, failed: NONE })
    expect(sendCalls.sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  /**
   * If send succeeds but markDispatched throws (e.g. transient DB error), the
   * error should propagate, not be silently caught and mislabeled as a send
   * failure. This proves the fix: only send is inside try/catch.
   */
  it('propagates markDispatched errors instead of mislabeling them as send failures', async () => {
    await seed('ok@example.com')
    vi.spyOn(repository, 'markDispatched').mockRejectedValue(
      new Error('db connection lost'),
    )

    await expect(useCase.execute()).rejects.toThrow('db connection lost')
  })
})
""")

# ---- integration repository spec: whole file
open('tests/integration/drizzle-outbox-messages-repository.spec.ts', 'w').write("""import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { DrizzleOutboxMessagesRepository } from '#modules/auth/infra/drizzle/drizzle-outbox-messages-repository'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LEASE_UNTIL = new Date('2026-09-15T12:02:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const HIGH_MAX_ATTEMPTS = 1000
const CONCURRENT_FAILURES = 5
const CONCURRENT_CLAIMERS = 6
const MESSAGES_TO_CLAIM = 40
const MILLISECONDS_PER_MESSAGE = 1000
const ONE_ROW = 1
const NONE = 0

let db: Database
let pool: Pool
let repository: DrizzleOutboxMessagesRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = new DrizzleOutboxMessagesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(outboxMessages)
})

const messageAt = (label: string, createdAt: Date) => {
  const id = randomUUID()
  return {
    id,
    msg: OutboxMessage.create({
      id,
      message: { to: `${label}@example.com`, subject: 'subject', text: 'text' },
      now: createdAt,
    }),
  }
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(outboxMessages).where(eq(outboxMessages.id, id))
  return row
}

describe('DrizzleOutboxMessagesRepository', () => {
  it('claims the oldest pending row first, ignoring dispatched and failed ones', async () => {
    const newest = messageAt('newest', LATER)
    const oldest = messageAt('oldest', NOW)
    const dispatched = messageAt('dispatched', NOW)
    const failed = messageAt('failed', NOW)

    await repository.save(newest.msg)
    await repository.save(oldest.msg)
    await repository.save(dispatched.msg)
    await repository.save(failed.msg)
    await repository.markDispatched(dispatched.id, LATER)
    await repository.recordFailure(failed.id, LATER, 'boom', ONE_ROW)

    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe(oldest.id)
    expect((await repository.claimNext(NOW, LEASE_UNTIL))?.id).toBe(newest.id)
    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
  })

  it('does not offer a claimed row until its claim expires', async () => {
    const only = messageAt('only', NOW)
    await repository.save(only.msg)
    await repository.claimNext(NOW, LEASE_UNTIL)

    expect(await repository.claimNext(NOW, LEASE_UNTIL)).toBeNull()
    // The claim runs out AT its expiry: `claimed_until <= now` no longer counts.
    expect((await repository.claimNext(LEASE_UNTIL, LATER))?.id).toBe(only.id)
  })

  it('stores the claim and changes nothing else about the row', async () => {
    const only = messageAt('only', NOW)
    await repository.save(only.msg)

    await repository.claimNext(NOW, LEASE_UNTIL)

    const row = await rowOf(only.id)
    expect(row?.claimedUntil).toEqual(LEASE_UNTIL)
    expect(row?.attempts).toBe(NONE)
    expect(row?.dispatchedAt).toBeNull()
    expect(row?.failedAt).toBeNull()
  })

  // The whole point of the claim: however the runs interleave, a row goes to
  // exactly one of them.
  it('hands each row to exactly one of several concurrent claimers', async () => {
    for (let index = 0; index < MESSAGES_TO_CLAIM; index++) {
      await repository.save(
        messageAt(
          `row-${index}`,
          new Date(NOW.getTime() + index * MILLISECONDS_PER_MESSAGE),
        ).msg,
      )
    }
    const claimed: string[] = []

    await Promise.all(
      Array.from({ length: CONCURRENT_CLAIMERS }, async () => {
        for (;;) {
          const next = await repository.claimNext(NOW, LEASE_UNTIL)
          if (next === null) return
          claimed.push(next.id)
        }
      }),
    )

    expect(claimed).toHaveLength(MESSAGES_TO_CLAIM)
    expect(new Set(claimed).size).toBe(MESSAGES_TO_CLAIM)
  })

  it('sets failedAt only once attempts reaches the cap', async () => {
    const doomed = messageAt('doomed', NOW)
    await repository.save(doomed.msg)

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    let row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(1)
    expect(row?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(2)
    expect(row?.failedAt).toBeNull()

    await repository.recordFailure(doomed.id, LATER, 'boom', MAX_ATTEMPTS)
    row = await rowOf(doomed.id)
    expect(row?.attempts).toBe(MAX_ATTEMPTS)
    expect(row?.failedAt).toEqual(LATER)
  })

  it('increments attempts atomically under concurrent failures, losing none', async () => {
    const racy = messageAt('racy', NOW)
    await repository.save(racy.msg)

    await Promise.all(
      Array.from({ length: CONCURRENT_FAILURES }, () =>
        repository.recordFailure(racy.id, LATER, 'boom', HIGH_MAX_ATTEMPTS),
      ),
    )

    expect((await rowOf(racy.id))?.attempts).toBe(CONCURRENT_FAILURES)
  })

  it('prunes only dispatched/failed rows at or before the cutoff, never a pending one', async () => {
    const oldDispatched = messageAt('old-dispatched', NOW)
    const oldPending = messageAt('old-pending', NOW)

    await repository.save(oldDispatched.msg)
    await repository.markDispatched(oldDispatched.id, NOW)
    await repository.save(oldPending.msg)

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    const survivors = await db.select().from(outboxMessages)
    expect(survivors.map((row) => row.id)).toEqual([oldPending.id])
  })
})
""")

# ---- forwarders in the three producer specs, the prune spec
edit('src/modules/auth/use-cases/reset-password.spec.ts', [
("      findPendingBatch: (limit) => outboxMessagesRepository.findPendingBatch(limit),\n",
 "      claimNext: (now, leaseUntil) => outboxMessagesRepository.claimNext(now, leaseUntil),\n"),
])
edit('src/modules/auth/use-cases/change-password.spec.ts', [
("      findPendingBatch: (limit) => outboxMessages.findPendingBatch(limit),\n",
 "      claimNext: (now, leaseUntil) => outboxMessages.claimNext(now, leaseUntil),\n"),
])
edit('src/modules/auth/use-cases/sign-in-with-google.spec.ts', [
("  findPendingBatch: (limit) => outboxMessagesRepository.findPendingBatch(limit),\n",
 "  claimNext: (now, leaseUntil) => outboxMessagesRepository.claimNext(now, leaseUntil),\n"),
])
edit('src/modules/auth/use-cases/prune-outbox-messages.spec.ts', [
("    expect(await repository.findPendingBatch(ONE)).toHaveLength(ONE)\n",
 "    expect(repository.messages.map((stored) => stored.id)).toEqual(['ancient-but-pending'])\n"),
])
print('task 3 tests written')
PYEOF
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:unit src/modules/auth/infra/in-memory src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts`

Expected: FAIL em 8 testes. O caso `never sends the same message twice when two runs overlap` termina por timeout de 5 s, porque o `claimNext` ainda não existe.

- [ ] **Step 3: Implementar**

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

# ---- the port
edit('src/modules/auth/repositories/outbox-messages-repository.ts', [
("""  /**
   * `WHERE dispatched_at IS NULL AND failed_at IS NULL ORDER BY created_at
   * LIMIT ?`. FIFO: the order a notice was promised is the order it goes out.
   */
  findPendingBatch(limit: number): Promise<OutboxMessage[]>
""",
"""  /**
   * Picks the oldest message that is pending and not currently claimed, sets its
   * claim to expire at `leaseUntil`, and returns it — or null when there is
   * none. A claim whose `claimed_until <= now` no longer counts. One statement,
   * so two concurrent callers never receive the same message (decision 40).
   * FIFO: the order a notice was promised is the order it goes out.
   */
  claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null>
"""),
])

# ---- the in-memory adapter
edit('src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts', [
("""/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * no row lock: only the dispatch job ever writes to a given row, one at a time.
 */
export class InMemoryOutboxMessagesRepository implements IOutboxMessagesRepository {
  readonly messages: OutboxMessage[] = []
""",
"""/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * the claim (`claimNext`), not row locks: the tests are sequential, and a run
 * that overlaps another is simulated by interleaving `await`s.
 */
export class InMemoryOutboxMessagesRepository implements IOutboxMessagesRepository {
  readonly messages: OutboxMessage[] = []
  /** Beside the messages, because the entity does not carry its claim. */
  readonly #claimedUntil = new Map<string, Date>()
"""),
("""  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    return [...this.messages]
      .filter((message) => message.dispatchedAt === null && message.failedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
  }
""",
"""  async claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null> {
    const [next] = this.messages
      .filter((message) => this.#isClaimable(message, now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    if (next === undefined) return null

    this.#claimedUntil.set(next.id, leaseUntil)
    return next
  }
"""),
("""  /** The entity is frozen, so "updating" means rebuilding it in place. */
""",
"""  #isClaimable(message: OutboxMessage, now: Date): boolean {
    if (message.dispatchedAt !== null || message.failedAt !== null) return false
    const claimedUntil = this.#claimedUntil.get(message.id)
    return claimedUntil === undefined || claimedUntil <= now
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
"""),
])

# ---- the Drizzle adapter
edit('src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts', [
("/** One row increment for attempts counter. */\nconst ONE_INCREMENT = 1\n",
 "/** One row increment for attempts counter. */\nconst ONE_INCREMENT = 1\n\n/** One message per claim, so the lease only has to cover one send (decision 40). */\nconst ONE_MESSAGE_PER_CLAIM = 1\n"),
("""  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    try {
      const rows = await this.db
        .select()
        .from(outboxMessages)
        .where(and(isNull(outboxMessages.dispatchedAt), isNull(outboxMessages.failedAt)))
        .orderBy(outboxMessages.createdAt)
        .limit(limit)

      return rows.map(toDomainOutboxMessage)
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
""",
"""  async claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null> {
    try {
      // `SKIP LOCKED` is what keeps two callers from waiting on, or receiving,
      // the same row; the whole thing is ONE statement, so no transaction stays
      // open while the caller sends.
      const next = this.db
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(
          and(
            isNull(outboxMessages.dispatchedAt),
            isNull(outboxMessages.failedAt),
            or(isNull(outboxMessages.claimedUntil), lte(outboxMessages.claimedUntil, now)),
          ),
        )
        .orderBy(outboxMessages.createdAt)
        .limit(ONE_MESSAGE_PER_CLAIM)
        .for('update', { skipLocked: true })

      const [row] = await this.db
        .update(outboxMessages)
        .set({ claimedUntil: leaseUntil })
        .where(eq(outboxMessages.id, next))
        .returning()

      return row === undefined ? null : toDomainOutboxMessage(row)
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
"""),
])

# ---- the no-op stub used by the unit-of-work fakes
edit('src/modules/auth/repositories/noop-auth-repos.ts', [
("      findPendingBatch: async () => [],\n", "      claimNext: async () => null,\n"),
])

# ---- the container hands the use case its lease
edit('src/modules/auth/container.ts', [
("""    config.OUTBOX_DISPATCH_MAX_ATTEMPTS,
    config.OUTBOX_DISPATCH_BATCH_SIZE,
  )
""",
"""    config.OUTBOX_DISPATCH_MAX_ATTEMPTS,
    config.OUTBOX_DISPATCH_BATCH_SIZE,
    config.OUTBOX_DISPATCH_LEASE_SECONDS * MILLISECONDS_PER_SECOND,
  )
"""),
])

# ---- the use case
open('src/modules/auth/use-cases/dispatch-outbox-messages.ts', 'w').write("""import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'

/** The job id the scheduler and the run log key on. */
export const DISPATCH_OUTBOX_MESSAGES_JOB = 'dispatch-outbox-messages'

export interface DispatchResult {
  dispatched: number
  failed: number
}

/**
 * Sends pending outbox rows for real, one at a time, outside any transaction: a
 * failure on one row must not block or roll back the others (same isolation
 * `runJobs` gives two different `CronJob`s).
 *
 * Each row is claimed before it is sent (decision 40), so two runs that overlap
 * work on different rows instead of sending the same one twice. The claim lasts
 * `leaseMs`: a run that dies mid-send leaves a claim that simply expires.
 *
 * Takes the RAW `IEmailSender`, never a best-effort wrapper — the `catch`
 * below IS the retry policy: deciding whether to try again, not swallowing
 * and forgetting.
 */
export class DispatchOutboxMessagesUseCase {
  constructor(
    private readonly outboxMessages: IOutboxMessagesRepository,
    private readonly emailSender: IEmailSender,
    private readonly clock: IClock,
    private readonly maxAttempts: number,
    private readonly batchSize: number,
    private readonly leaseMs: number,
  ) {}

  async execute(): Promise<DispatchResult> {
    let dispatched = 0
    let failed = 0

    for (let handled = 0; handled < this.batchSize; handled++) {
      const now = this.clock.now()
      const message = await this.outboxMessages.claimNext(
        now,
        new Date(now.getTime() + this.leaseMs),
      )
      if (message === null) break

      let sent = false
      let sendError: unknown

      try {
        await this.emailSender.send(message.toEmailMessage())
        sent = true
      } catch (error) {
        sendError = error
      }

      if (sent) {
        await this.outboxMessages.markDispatched(message.id, now)
        dispatched++
      } else {
        // The claim stays: the message is offered again only once it expires,
        // which is also the wait between attempts. Releasing it would hand the
        // same message straight back to this loop.
        await this.outboxMessages.recordFailure(
          message.id,
          now,
          sendError instanceof Error ? sendError.message : String(sendError),
          this.maxAttempts,
        )
        failed++
      }
    }

    return { dispatched, failed }
  }
}
""")
print('task 3 implementation written')
PYEOF
```

- [ ] **Step 4: Verificar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
pnpm test:unit
pnpm test:integration tests/integration/drizzle-outbox-messages-repository.spec.ts
```

Expected: lint e typecheck limpos; `test:unit` verde com 59 arquivos e 517 testes; o spec de integração do repositório passa com 7 testes, incluindo `hands each row to exactly one of several concurrent claimers` (seis pegadores sobre 40 linhas no Postgres real).

- [ ] **Step 5: Commit**

```bash
git add src tests/integration/drizzle-outbox-messages-repository.spec.ts
git commit -m "feat(auth): claim outbox messages one at a time with a lease"
```

---

### Task 4: As provas de concorrência

**Files:**
- Test: `tests/integration/dispatch-outbox-concurrency.spec.ts`

**Interfaces:**
- Consumes: `DispatchOutboxMessagesUseCase` com o sexto argumento e `DrizzleOutboxMessagesRepository.claimNext` (Task 3).
- Produces: nada além dos testes. É o teste que **prova o problema do TODO**.

- [ ] **Step 1: Escrever o spec**

Cinco execuções concorrentes sobre 30 mensagens, com um enviador lento, e cada mensagem tem de sair exatamente uma vez. O segundo caso simula uma execução que morreu: ela deixou uma etiqueta, e a mensagem só volta a ser oferecida quando a etiqueta vence (na fronteira exata, `claimed_until <= now`).

Crie `tests/integration/dispatch-outbox-concurrency.spec.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { DrizzleOutboxMessagesRepository } from '#modules/auth/infra/drizzle/drizzle-outbox-messages-repository'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { DispatchOutboxMessagesUseCase } from '#modules/auth/use-cases/dispatch-outbox-messages'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const MESSAGES = 30
const CONCURRENT_RUNS = 5
const SEND_DELAY_MS = 5
const MAX_ATTEMPTS = 3
const BATCH_SIZE = 100
const LEASE_MS = 60_000
const NONE = 0
const ONE = 1

const RUN_STARTED_AT = new Date('2026-09-19T12:00:00.000Z')
const ABANDONED_RECIPIENT = 'abandoned@example.com'

let db: Database
let pool: Pool
let repository: DrizzleOutboxMessagesRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repository = new DrizzleOutboxMessagesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(outboxMessages)
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const saveMessage = (to: string, createdAt: Date) =>
  repository.save(
    OutboxMessage.create({
      id: randomUUID(),
      message: { to, subject: 'subject', text: 'text' },
      now: createdAt,
    }),
  )

const dispatcherAt = (emailSender: IEmailSender, now: () => Date) =>
  new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    { now },
    MAX_ATTEMPTS,
    BATCH_SIZE,
    LEASE_MS,
  )

describe('overlapping outbox dispatch runs', () => {
  // The problem the claim exists to close: with a plain SELECT every run below
  // reads the same rows, and each message goes out once per run.
  it('send each message exactly once', async () => {
    for (let index = 0; index < MESSAGES; index++) {
      await saveMessage(
        `user-${index}@example.com`,
        new Date(RUN_STARTED_AT.getTime() + index),
      )
    }
    const sends: string[] = []
    const emailSender: IEmailSender = {
      send: async (message: EmailMessage) => {
        await sleep(SEND_DELAY_MS)
        sends.push(message.to)
      },
    }

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_RUNS }, () =>
        dispatcherAt(emailSender, () => new Date()).execute(),
      ),
    )

    expect(sends).toHaveLength(MESSAGES)
    expect(new Set(sends).size).toBe(MESSAGES)
    expect(results.reduce((total, result) => total + result.dispatched, NONE)).toBe(
      MESSAGES,
    )
    const rows = await db.select().from(outboxMessages)
    expect(rows.every((row) => row.dispatchedAt !== null)).toBe(true)
  })

  // A run that dies mid-send leaves a claim behind. Nothing releases it: it
  // expires, and the next run takes the message.
  it('offers a message again once the claim of a run that died has expired', async () => {
    await saveMessage(ABANDONED_RECIPIENT, RUN_STARTED_AT)
    await repository.claimNext(RUN_STARTED_AT, new Date(RUN_STARTED_AT.getTime() + LEASE_MS))
    const sends: string[] = []
    const emailSender: IEmailSender = {
      send: async (message: EmailMessage) => {
        sends.push(message.to)
      },
    }

    const insideTheLease = await dispatcherAt(
      emailSender,
      () => new Date(RUN_STARTED_AT.getTime() + LEASE_MS - ONE),
    ).execute()
    const atExpiry = await dispatcherAt(
      emailSender,
      () => new Date(RUN_STARTED_AT.getTime() + LEASE_MS),
    ).execute()

    expect(insideTheLease).toEqual({ dispatched: NONE, failed: NONE })
    expect(atExpiry).toEqual({ dispatched: ONE, failed: NONE })
    expect(sends).toEqual([ABANDONED_RECIPIENT])
  })
})
```

- [ ] **Step 2: Rodar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
pnpm test:integration tests/integration/dispatch-outbox-concurrency.spec.ts
```

Expected: 2 testes PASS.

- [ ] **Step 3: Provar que a suíte detecta o problema**

Sem isto o teste pode passar por acidente. Tire por um instante o filtro de etiqueta do `claimNext` (o `or(...)` de 4 linhas) e veja as provas falharem:

```bash
python3 - <<'PYEOF'
p = 'src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts'
s = open(p).read()
old = """            or(
              isNull(outboxMessages.claimedUntil),
              lte(outboxMessages.claimedUntil, now),
            ),
"""
assert s.count(old) == 1, s.count(old)
open(p, 'w').write(s.replace(old, ''))
PYEOF
pnpm test:integration tests/integration/dispatch-outbox-concurrency.spec.ts tests/integration/drizzle-outbox-messages-repository.spec.ts
git checkout src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts
git diff --stat src | wc -l
```

Expected: FAIL em 5 testes, entre eles `send each message exactly once` e `offers a message again once the claim of a run that died has expired`; depois do `git checkout`, `git diff --stat src` não imprime nada (0 linhas). Se o `assert` reclamar, o Biome formatou o trecho de outro jeito: copie o trecho exato do arquivo.

- [ ] **Step 4: Toda a suíte de integração**

```bash
pnpm test:integration
```

Expected: verde, 35 arquivos e 254 testes.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/dispatch-outbox-concurrency.spec.ts
git commit -m "test(auth): prove overlapping dispatch runs send each message once"
```

---

### Task 5: Docs e verificação final

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/TODO.md`
- Modify: `docs/superpowers/specs/2026-09-15-transactional-outbox-design.md`

**Interfaces:**
- Consumes: tudo das tarefas 1–4.
- Produces: a decisão 40, que os comentários do código já citam.

- [ ] **Step 1: A decisão 40, o TODO e as emendas da spec do outbox**

O `DECISIONS.md` não termina na decisão 39: depois dela vêm um `---` e a seção "7. Pendências de manutenção". A 40 entra logo depois da 39, antes desse `---`; o `assert` garante que o ponto de inserção existe uma única vez.

```bash
python3 - <<'PYEOF'
def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    open(path, 'w').write(s)

# ---- DECISIONS.md: decision 40 goes right after 39, before the `---` of section 7
decision = """### 40 — Dispatch do outbox com etiqueta por mensagem

Fecha o item #2 de "Pendências do boilerplate". O `findPendingBatch` era um
`SELECT` comum e o `markDispatched` só rodava depois do `send`: duas execuções
que se sobrepusessem liam as mesmas linhas e mandavam o mesmo e-mail duas vezes.
A janela era a duração da execução inteira. A spec do outbox aceitou isso
apoiada em "one-shot agendado pela plataforma não sobrepõe execução", premissa
que depende de onde o app roda, e isso ainda não está decidido.

**Medido de ponta a ponta:** três processos `cron` concorrentes sobre 100
mensagens, com SMTP de verdade (Mailpit), entregaram **300 e-mails** com o
código antigo e **100** com o novo.

**O desenho.** Cada mensagem ganha `claimed_until`. `claimNext(now, leaseUntil)`
é uma instrução única (`UPDATE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE SKIP
LOCKED) RETURNING`) que pega a mais antiga pendente e sem etiqueta vigente e a
etiqueta. É uma mensagem por vez, então a etiqueta só precisa cobrir um envio, e
uma execução que some prende no máximo uma mensagem. Se o processo morre, a
etiqueta vence e outra execução assume. O padrão é de 120 s
(`OUTBOX_DISPATCH_LEASE_SECONDS`).

**Falha mantém a etiqueta.** Uma mensagem cujo envio falhou só é oferecida de
novo quando a etiqueta vence: soltá-la a devolveria ao mesmo laço na hora (é a
mais antiga) e gastaria as tentativas em segundos. O prazo da etiqueta vira o
intervalo entre tentativas; com o padrão e 5 tentativas, uma mensagem que sempre
falha desiste em cerca de 8 minutos.

**Timeouts no SMTP.** A etiqueta só é confiável se o envio tem limite. O
transporte não configurava nenhum (padrões do nodemailer: 2 min para conectar,
30 s para a saudação, 10 min de inatividade no socket) e passou a ter 10 s, 10 s
e 30 s. Medido: as opções cortam um servidor mudo em exatamente o configurado.
Vale também para os caminhos de requisição, que deixam de ficar presos por até
10 minutos num SMTP pendurado.

**Rejeitado.** *Lock consultivo do Postgres por execução:* serializaria as
execuções sem coluna nova, mas quebra atrás de um pooler em modo transação e um
envio pendurado bloquearia todas as seguintes. *`FOR UPDATE SKIP LOCKED` numa
transação que engloba o envio:* segura uma conexão parada durante o SMTP, e o
`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` mataria a transação de um envio lento
(§8 do desenho da unit of work: sem I/O externo em transação). *Etiquetar um
lote inteiro:* a etiqueta teria de durar cem envios ou venceria no meio.

**Custos aceitos.**

1. Uma execução que morre entre o `send` e o `markDispatched` reenvia depois do
   prazo: inerente a e-mail. A decisão elimina a duplicata por concorrência, não
   a por queda.
2. O timeout corta uma conexão parada, não um servidor que responde devagar a
   cada comando; nesse caso a etiqueta pode vencer com o envio em curso.
3. A etiqueta compara relógios de réplicas diferentes; um desvio de segundos é
   irrelevante frente a 120 s.
4. Uma mensagem que derruba o processo antes do `recordFailure` nunca soma
   tentativas. Igual a antes.

Spec: [`specs/2026-09-19-outbox-dispatch-lease-design.md`](superpowers/specs/2026-09-19-outbox-dispatch-lease-design.md).
"""
path = 'docs/DECISIONS.md'
text = open(path).read()
anchor = '\n---\n\n## 7. Pendências de manutenção'
assert text.count(anchor) == 1
open(path, 'w').write(text.replace(anchor, '\n' + decision + anchor))

# ---- TODO.md
edit('docs/TODO.md', [
("> **Fatia 22 (2026-09-19) entregou o store de rate limit compartilhado no\n",
"""> **Fatia 23 (2026-09-19) entregou o dispatch do outbox com etiqueta por
> mensagem** (decisão 40). Fecha o item #2 de "Pendências do boilerplate". Cada
> mensagem é pega com um prazo (`claimed_until`) antes de ser enviada, então
> execuções que se sobreponham trabalham em mensagens diferentes: três
> `cron.ts` concorrentes sobre 100 mensagens entregavam 300 e-mails e agora
> entregam 100. Não é "exatamente uma vez": uma queda entre o envio e o registro
> ainda reenvia. O SMTP ganhou timeouts explícitos, que a etiqueta exige.
>
> **Fatia 22 (2026-09-19) entregou o store de rate limit compartilhado no
"""),
("""~~Store do rate limit~~ — **fechado pela fatia 22** (decisão 39). O #2,
**dispatch do outbox sem trava**, tem natureza diferente dos outros cinco: não é
feature ausente, é uma promessa que o boilerplate faz e deixa de cumprir na
segunda instância. Um app de alimentação rodando dois contêineres sofre o
problema, e dado sensível não entra na conta.
""",
"""~~Store do rate limit~~ — **fechado pela fatia 22** (decisão 39).
~~Dispatch do outbox sem trava~~ — **fechado pela fatia 23** (decisão 40). O
próximo é o #3, **notificar o dono quando a detecção de reuso dispara**, o
primeiro consumidor natural de um aviso que precisa sair uma vez só.
"""),
])
path = 'docs/TODO.md'
row = ('| 2 | ~~Dispatch do outbox sem trava~~ | — | **fechado pela fatia 23.** '
       'Cada mensagem é pega com uma etiqueta de prazo (`claimed_until`) por uma '
       'instrução única com `FOR UPDATE SKIP LOCKED`; execuções concorrentes '
       'trabalham em mensagens diferentes. Decisão 40 |')
lines = open(path).read().split('\n')
marker = '| 2 | **Dispatch do outbox sem trava**'
assert sum(l.startswith(marker) for l in lines) == 1
open(path, 'w').write('\n'.join(row if l.startswith(marker) else l for l in lines))

# ---- the outbox spec: what it accepted is now closed
edit('docs/superpowers/specs/2026-09-15-transactional-outbox-design.md', [
("""  duração de um `execute()`) e sem custo caso aconteça. Mesma aceitação que o
  "sem lock de instância" da poda (§8 da spec da fatia 13).
""",
"""  duração de um `execute()`) e sem custo caso aconteça. Mesma aceitação que o
  "sem lock de instância" da poda (§8 da spec da fatia 13).

  > **Emendado pela fatia 23 (decisão 40).** Deixou de ser custo aceito: cada
  > mensagem é pega com uma etiqueta de prazo (`claimNext`), então execuções
  > concorrentes trabalham em mensagens diferentes. O laço do §6 descreve o
  > desenho original, com `findPendingBatch`, e fica como registro.
"""),
("""  "Pendências do boilerplate" no [`TODO.md`](../../TODO.md), porque atinge todo
  app derivado e estava registrado apenas aqui.
""",
"""  "Pendências do boilerplate" no [`TODO.md`](../../TODO.md), porque atinge todo
  app derivado e estava registrado apenas aqui.
  **Fechado pela fatia 23 (decisão 40).**
"""),
("""  fatia 13: one-shot agendado pela plataforma não sobrepõe execução; um
  agendador que sobreponha é problema do agendador.
""",
"""  fatia 13: one-shot agendado pela plataforma não sobrepõe execução; um
  agendador que sobreponha é problema do agendador. **A parte do dispatch foi
  fechada pela fatia 23**; a da poda segue valendo (idempotente).
"""),
])
print('task 5 docs edited')
PYEOF
grep -n '^### 39\|^### 40\|^## 7\.' docs/DECISIONS.md
```

Expected: as linhas das decisões 39 e 40, nessa ordem, ambas antes de `## 7.`.

- [ ] **Step 2: Verificação final**

```bash
pnpm lint && pnpm typecheck && pnpm test:unit
pnpm db:up
pnpm test:integration
pnpm build
```

Expected: tudo verde (59 arquivos e 517 testes unitários; 35 arquivos e 254 de integração).

- [ ] **Step 3: A prova de ponta a ponta, com SMTP de verdade**

Três processos `cron` concorrentes sobre 100 mensagens, contando no Mailpit quantos e-mails saíram. Com o código antigo, o mesmo teste entregou **300**.

```bash
export NODE_ENV=development LOG_LEVEL=silent \
  DATABASE_URL=postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test \
  REDIS_URL=redis://127.0.0.1:6380 JWT_SECRET=a-local-e2e-secret-with-at-least-32-chars \
  GOOGLE_CLIENT_ID=e2e.apps.googleusercontent.com JWT_ISSUER=e2e JWT_AUDIENCE=e2e
PSQL="docker exec -i api-clean-platform-postgres-test psql -q -U api_clean_platform -d api_clean_platform_test"
$PSQL -c "delete from outbox_messages; insert into outbox_messages (id, \"to\", subject, text, attempts, created_at) select gen_random_uuid(), 'user-'||g||'@example.com', 'subject', 'text', 0, now() - (g||' seconds')::interval from generate_series(1,100) g;"
curl -s -X DELETE localhost:8025/api/v1/messages >/dev/null
for i in 1 2 3; do node dist/main/cron.js auth:dispatch-outbox-messages >/dev/null 2>&1 & done; wait
echo "delivered: $(curl -s localhost:8025/api/v1/messages | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")"
$PSQL -t -A -c "select count(*) filter (where dispatched_at is not null), count(*) from outbox_messages"
$PSQL -c "delete from outbox_messages"; curl -s -X DELETE localhost:8025/api/v1/messages >/dev/null
```

Expected: `delivered: 100` e `100|100`.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(auth): record decision 40 and close the outbox dispatch item"
```

---

## Depois do plano

Com os testes verdes, a regra do `CLAUDE.md` global manda invocar `superpowers:finishing-a-development-branch`, e dele `finish-with-review-pr` logo depois do Step 1 (testes passando), antes do menu de integração. A branch é `feat/outbox-dispatch-lease`.
