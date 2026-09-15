# Transactional Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "crash between `COMMIT` and SMTP send loses the e-mail in silence" hole for the three post-commit notice e-mails (`passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail`) by writing them to an `outbox_messages` table inside the same transaction that changes state, and dispatching them for real from a new `cron.ts` job.

**Architecture:** A new `OutboxMessage` entity + `IOutboxMessagesRepository`, added to `AuthRepos` so the three producer use cases (`change-password`, `reset-password`, `sign-in-with-google`) can `save` a row **inside** their existing `uow` callback instead of calling `emailSender.send` after it resolves. A new `DispatchOutboxMessagesUseCase`, run outside any transaction via a `CronJob`, reads a batch of pending rows and sends each one for real, retrying failures up to a configured cap before giving up on a row. A companion `PruneOutboxMessagesUseCase`/`CronJob` deletes old dispatched/failed rows, mirroring the three prune jobs from slice 13.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM (Postgres), Vitest, Zod (env validation), `cron.ts`/`run-cron.ts` (slice 13's one-shot entrypoint + job registry).

**Spec:** [`docs/superpowers/specs/2026-09-15-transactional-outbox-design.md`](../specs/2026-09-15-transactional-outbox-design.md)

## Global Constraints

- All code, identifiers, strings, log messages and comments in **English** (`CLAUDE.md`).
- No magic strings/numbers inline — every one is a named constant, placed close to its use unless shared, per `CLAUDE.md`.
- Schema declaration files (`src/modules/*/infra/drizzle/schema/*.ts`) spell table/column/index names inline — the one documented exception to the rule above.
- Outbox is scoped to exactly three e-mails: `passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail`. `verificationEmail` and `passwordResetEmail` stay outside (plaintext secret at rest); `accountAlreadyExistsEmail` stays outside (no preceding transactional write to correlate).
- State on `outbox_messages` is modeled with nullable timestamps (`dispatched_at`, `failed_at`), never a status enum — same idiom as `consumed_at`/`revoked_at` on sibling tables.
- No column defaults on `outbox_messages` — every timestamp comes from `IClock`, same reason as `refresh_tokens`/`pending_registrations`.
- A use case that receives a unit of work must not also receive a repository directly (`src/shared/ports/unit-of-work.ts`) — the three producer use cases write the outbox row only through `uow`'s `repos.outboxMessages`.
- TDD: write the failing test before the implementation, for every step below.

---

## Task 1: `OutboxMessage` entity

**Files:**
- Create: `src/modules/auth/entities/outbox-message.ts`
- Test: `src/modules/auth/entities/outbox-message.spec.ts`

**Interfaces:**
- Consumes: `EmailMessage` from `#shared/ports/email-sender` (`{ to: string; subject: string; text: string }`).
- Produces: `OutboxMessage` class with `static create(props: CreateOutboxMessageProps): OutboxMessage`, `static fromTrusted(props: TrustedOutboxMessageProps): OutboxMessage`, `toEmailMessage(): EmailMessage`, and getters `id`, `to`, `subject`, `text`, `attempts`, `lastError`, `dispatchedAt`, `failedAt`, `createdAt` — consumed by Tasks 2, 5, 6, 7, 8, 9.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/auth/entities/outbox-message.spec.ts
import { describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { EmailMessage } from '#shared/ports/email-sender'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const NOW = new Date('2026-09-15T12:00:00.000Z')
const NO_ATTEMPTS = 0

const MESSAGE: EmailMessage = {
  to: 'joao@example.com',
  subject: 'Your password was changed',
  text: 'Your password was just changed.',
}

const fresh = () => OutboxMessage.create({ id: ID, message: MESSAGE, now: NOW })

describe('OutboxMessage.create', () => {
  it('is born with no attempts and neither dispatched nor failed', () => {
    const message = fresh()

    expect(message.id).toBe(ID)
    expect(message.to).toBe(MESSAGE.to)
    expect(message.subject).toBe(MESSAGE.subject)
    expect(message.text).toBe(MESSAGE.text)
    expect(message.attempts).toBe(NO_ATTEMPTS)
    expect(message.lastError).toBeNull()
    expect(message.dispatchedAt).toBeNull()
    expect(message.failedAt).toBeNull()
    expect(message.createdAt).toEqual(NOW)
  })

  it('yields {} under JSON.stringify, so a message body cannot leak into a stray log', () => {
    expect(JSON.stringify(fresh())).toBe('{}')
  })

  it('hands out a copy of createdAt, not the internal instance', () => {
    const message = fresh()
    message.createdAt.setFullYear(1970)

    expect(message.createdAt).toEqual(NOW)
  })

  it('reconstitutes the EmailMessage it was built from', () => {
    expect(fresh().toEmailMessage()).toEqual(MESSAGE)
  })
})

describe('OutboxMessage.fromTrusted', () => {
  it('rehydrates every field as given, including a permanent failure', () => {
    const failedAt = new Date('2026-09-15T13:00:00.000Z')
    const message = OutboxMessage.fromTrusted({
      id: ID,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      attempts: 5,
      lastError: 'connection refused',
      dispatchedAt: null,
      failedAt,
      createdAt: NOW,
    })

    expect(message.attempts).toBe(5)
    expect(message.lastError).toBe('connection refused')
    expect(message.dispatchedAt).toBeNull()
    expect(message.failedAt).toEqual(failedAt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/modules/auth/entities/outbox-message.spec.ts`
Expected: FAIL — `Cannot find module '#modules/auth/entities/outbox-message'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/modules/auth/entities/outbox-message.ts
import type { EmailMessage } from '#shared/ports/email-sender'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — same reasoning as `PendingRegistration`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const NO_ATTEMPTS_SPENT = 0

export interface CreateOutboxMessageProps {
  id: string
  message: EmailMessage
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedOutboxMessageProps {
  id: string
  to: string
  subject: string
  text: string
  attempts: number
  lastError: string | null
  dispatchedAt: Date | null
  failedAt: Date | null
  createdAt: Date
}

/**
 * One notice promised inside a transaction, to be sent for real later by
 * `DispatchOutboxMessagesUseCase`. Carries no secret — the three e-mails it
 * exists for (`passwordChangedEmail`, `passwordResetCompletedEmail`,
 * `googleAccountLinkedEmail`) are avisos, not codes or tokens — but state still
 * lives in `#` private fields, non-enumerable at runtime, so a stray
 * `log.info({ message })` cannot leak a message body into the log stream.
 *
 * State is a nullable timestamp, not a status enum: `dispatchedAt`/`failedAt`
 * are the same idiom as `PendingRegistration.consumedAt` and
 * `RefreshToken.revokedAt`.
 */
export class OutboxMessage {
  readonly #id: string
  readonly #to: string
  readonly #subject: string
  readonly #text: string
  readonly #attempts: number
  readonly #lastError: string | null
  readonly #dispatchedAt: Date | null
  readonly #failedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedOutboxMessageProps) {
    this.#id = props.id
    this.#to = props.to
    this.#subject = props.subject
    this.#text = props.text
    this.#attempts = props.attempts
    this.#lastError = props.lastError
    this.#dispatchedAt = cloneNullableDate(props.dispatchedAt)
    this.#failedAt = cloneNullableDate(props.failedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /** Born with no attempts spent, neither dispatched nor failed. */
  static create(props: CreateOutboxMessageProps): OutboxMessage {
    return new OutboxMessage({
      id: props.id,
      to: props.message.to,
      subject: props.message.subject,
      text: props.message.text,
      attempts: NO_ATTEMPTS_SPENT,
      lastError: null,
      dispatchedAt: null,
      failedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedOutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props)
  }

  /** Reconstitutes the `IEmailSender.send` payload. The entity does not know the port. */
  toEmailMessage(): EmailMessage {
    return { to: this.#to, subject: this.#subject, text: this.#text }
  }

  get id(): string {
    return this.#id
  }

  get to(): string {
    return this.#to
  }

  get subject(): string {
    return this.#subject
  }

  get text(): string {
    return this.#text
  }

  get attempts(): number {
    return this.#attempts
  }

  get lastError(): string | null {
    return this.#lastError
  }

  get dispatchedAt(): Date | null {
    return cloneNullableDate(this.#dispatchedAt)
  }

  get failedAt(): Date | null {
    return cloneNullableDate(this.#failedAt)
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/modules/auth/entities/outbox-message.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/entities/outbox-message.ts src/modules/auth/entities/outbox-message.spec.ts
git commit -m "feat(outbox): add the OutboxMessage entity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `IOutboxMessagesRepository` + in-memory adapter + `AuthRepos`/`noopAuthRepos` wiring

**Files:**
- Create: `src/modules/auth/repositories/outbox-messages-repository.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Test: `src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts`

**Interfaces:**
- Consumes: `OutboxMessage` from Task 1.
- Produces: `IOutboxMessagesRepository` (`save`, `findPendingBatch`, `markDispatched`, `recordFailure`, `deleteDispatchedOrFailedBefore`); `InMemoryOutboxMessagesRepository` with public `readonly messages: OutboxMessage[]`; `AuthRepos.outboxMessages: IOutboxMessagesRepository` — consumed by Tasks 3, 5, 6, 7, 8, 9.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const ONE_ROW = 1
const TWO_ROWS = 2
const NONE = 0
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
  it('finds only pending rows, oldest first, up to the limit', async () => {
    await repository.save(messageAt('newest', LATER))
    await repository.save(messageAt('oldest', NOW))

    const batch = await repository.findPendingBatch(ONE_ROW)

    expect(batch.map((message) => message.id)).toEqual(['oldest'])
  })

  it('excludes a dispatched row from the pending batch', async () => {
    await repository.save(messageAt('done', NOW))
    await repository.markDispatched('done', LATER)

    expect(await repository.findPendingBatch(TWO_ROWS)).toHaveLength(NONE)
  })

  it('excludes a permanently failed row from the pending batch', async () => {
    await repository.save(messageAt('doomed', NOW))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    }

    expect(await repository.findPendingBatch(TWO_ROWS)).toHaveLength(NONE)
  })

  it('records a failure below the cap without marking it failed', async () => {
    await repository.save(messageAt('retry-me', NOW))

    await repository.recordFailure('retry-me', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)

    const [pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(1)
    expect(pending?.lastError).toBe(ERROR_MESSAGE)
    expect(pending?.failedAt).toBeNull()
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/modules/auth/repositories/outbox-messages-repository.ts
import type { OutboxMessage } from '#modules/auth/entities/outbox-message'

export interface IOutboxMessagesRepository {
  /** Plain insert, called INSIDE the `uow` of the producing use case. */
  save(message: OutboxMessage): Promise<void>

  /**
   * `WHERE dispatched_at IS NULL AND failed_at IS NULL ORDER BY created_at
   * LIMIT ?`. FIFO: the order a notice was promised is the order it goes out.
   */
  findPendingBatch(limit: number): Promise<OutboxMessage[]>

  /** `UPDATE ... SET dispatched_at = ? WHERE id = ?`. */
  markDispatched(id: string, at: Date): Promise<void>

  /**
   * Increments `attempts`, records `lastError`, and sets `failedAt` once
   * `attempts` reaches `maxAttempts` — never before. No corresponding
   * `Promise<boolean>`: unlike `registerFailedAttempt`, only the dispatch job
   * ever writes to one row, one at a time, so there is no race to serialize
   * against.
   */
  recordFailure(
    id: string,
    at: Date,
    error: string,
    maxAttempts: number,
  ): Promise<void>

  /**
   * Poda: deletes rows that are dispatched OR failed, whichever happened at or
   * before `cutoff`. Never touches a still-pending row. Mirrors
   * `deleteExpiredBefore` on the sibling repositories.
   */
  deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number>
}
```

```typescript
// src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'

const ONE_INCREMENT = 1

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * no row lock: only the dispatch job ever writes to a given row, one at a time.
 */
export class InMemoryOutboxMessagesRepository implements IOutboxMessagesRepository {
  readonly messages: OutboxMessage[] = []

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message)
  }

  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    return [...this.messages]
      .filter((message) => message.dispatchedAt === null && message.failedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
  }

  async markDispatched(id: string, at: Date): Promise<void> {
    this.#replace(id, (message) =>
      OutboxMessage.fromTrusted({ ...toTrusted(message), dispatchedAt: at }),
    )
  }

  async recordFailure(
    id: string,
    at: Date,
    error: string,
    maxAttempts: number,
  ): Promise<void> {
    this.#replace(id, (message) => {
      const attempts = message.attempts + ONE_INCREMENT
      return OutboxMessage.fromTrusted({
        ...toTrusted(message),
        attempts,
        lastError: error,
        failedAt: attempts >= maxAttempts ? at : null,
      })
    })
  }

  async deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number> {
    const survivors = this.messages.filter((message) => {
      const settledAt = message.dispatchedAt ?? message.failedAt
      return settledAt === null || settledAt > cutoff
    })
    const deleted = this.messages.length - survivors.length
    this.messages.length = 0
    this.messages.push(...survivors)
    return deleted
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replace(id: string, rebuild: (message: OutboxMessage) => OutboxMessage): void {
    const index = this.messages.findIndex((message) => message.id === id)
    if (index === -1) return
    const current = this.messages[index]
    if (current === undefined) return
    this.messages[index] = rebuild(current)
  }
}

function toTrusted(message: OutboxMessage) {
  return {
    id: message.id,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attempts: message.attempts,
    lastError: message.lastError,
    dispatchedAt: message.dispatchedAt,
    failedAt: message.failedAt,
    createdAt: message.createdAt,
  }
}
```

Now wire it into `AuthRepos` — modify `src/modules/auth/repositories/unit-of-work.ts`:

```typescript
// Add to the imports:
import type { IOutboxMessagesRepository } from './outbox-messages-repository.js'

// Add to the AuthRepos interface, and document it next to the others:
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
  pendingRegistrations: IPendingRegistrationsRepository
  passwordResetTokens: IPasswordResetTokensRepository
  federatedIdentities: IFederatedIdentitiesRepository
  outboxMessages: IOutboxMessagesRepository
}
```

Add this paragraph to the interface's doc comment, after the `federatedIdentities` paragraph:

```
 * `outboxMessages` for the three post-commit notices (password changed,
 * password reset completed, Google account linked): the row that promises the
 * e-mail is written in the SAME transaction as the state change it describes —
 * one fact, either both land or neither does.
```

And `src/modules/auth/repositories/noop-auth-repos.ts` — add after `federatedIdentities`:

```typescript
    outboxMessages: {
      save: async () => {},
      findPendingBatch: async () => [],
      markDispatched: async () => {},
      recordFailure: async () => {},
      deleteDispatchedOrFailedBefore: async () => 0,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts`
Expected: PASS (5 tests)

Run: `pnpm typecheck`
Expected: PASS — confirms `AuthRepos`/`noopAuthRepos` still type-check everywhere they are used.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/repositories/outbox-messages-repository.ts \
  src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.ts \
  src/modules/auth/infra/in-memory/in-memory-outbox-messages-repository.spec.ts \
  src/modules/auth/repositories/unit-of-work.ts \
  src/modules/auth/repositories/noop-auth-repos.ts
git commit -m "feat(outbox): add IOutboxMessagesRepository, wire it into AuthRepos

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `outbox_messages` schema + migration + Drizzle repository + mapper

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/outbox-messages.ts`
- Create: `src/modules/auth/infra/drizzle/outbox-message-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Test: `tests/integration/drizzle-outbox-messages-repository.spec.ts`
- Test: `tests/integration/outbox-messages-schema.spec.ts`
- Generated: a new file under `drizzle/` (via `pnpm db:generate`)

**Interfaces:**
- Consumes: `OutboxMessage` (Task 1), `IOutboxMessagesRepository` (Task 2), `Database` from `#infra/database/client`, `toPersistenceError` from `#infra/database/driver-error`.
- Produces: `outboxMessages` Drizzle table; `DrizzleOutboxMessagesRepository`; `authRepositories()` returns `outboxMessages` — consumed by Task 8 (container wiring) and the integration tests here.

- [ ] **Step 1: Write the schema**

```typescript
// src/modules/auth/infra/drizzle/schema/outbox-messages.ts
import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * A notice promised inside a transaction, waiting for `DispatchOutboxMessagesUseCase`
 * to send it for real (design §4.1). Scoped to the three post-commit notices —
 * `passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail` —
 * that carry no secret; `verificationEmail`/`passwordResetEmail` stay outside
 * this table because they carry a code/token in plaintext.
 *
 * NO column defaults, same reason as `refresh_tokens`/`pending_registrations`:
 * `timestamptz` is microseconds in Postgres, milliseconds in a JS `Date`, and
 * every comparison of an instant needs both sides from the same `IClock`.
 *
 * State is `dispatched_at`/`failed_at`, nullable timestamps — not a status
 * column — same idiom as `consumed_at`/`revoked_at` on the sibling tables.
 * NO foreign key to `users`: the recipient is an address already resolved at
 * enqueue time, not a live reference — a deleted user should not block
 * dispatch of a notice that made sense when it was queued.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The hot lookup for `findPendingBatch` — FIFO over the rows still owed.
    index('outbox_messages_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} is null and ${table.failedAt} is null`),
  ],
)
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:up` (if the local Postgres container is not already running), then `pnpm db:generate`
Expected: a new folder under `drizzle/`, named `<timestamp>_create_outbox_messages` (or similar drizzle-kit-chosen name), containing the `CREATE TABLE outbox_messages (...)` and `CREATE INDEX outbox_messages_pending_idx ...` SQL. Inspect the generated SQL to confirm it matches the schema above — no default clauses, both timestamp columns nullable except `created_at`.

Run: `pnpm db:migrate`
Expected: migration applies cleanly against the local dev database.

- [ ] **Step 3: Write the mapper and the Drizzle repository**

```typescript
// src/modules/auth/infra/drizzle/outbox-message-mapper.ts
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { outboxMessages } from './schema/outbox-messages.js'

type NewOutboxMessageRow = typeof outboxMessages.$inferInsert
type OutboxMessageRow = typeof outboxMessages.$inferSelect

/** Entity to row. Only this file knows both shapes (decision 20). */
export const toPersistenceOutboxMessage = (
  message: OutboxMessage,
): NewOutboxMessageRow => ({
  id: message.id,
  to: message.to,
  subject: message.subject,
  text: message.text,
  attempts: message.attempts,
  lastError: message.lastError,
  dispatchedAt: message.dispatchedAt,
  failedAt: message.failedAt,
  createdAt: message.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `OutboxMessage.fromTrusted`. */
export const toDomainOutboxMessage = (row: OutboxMessageRow): OutboxMessage =>
  OutboxMessage.fromTrusted({
    id: row.id,
    to: row.to,
    subject: row.subject,
    text: row.text,
    attempts: row.attempts,
    lastError: row.lastError,
    dispatchedAt: row.dispatchedAt,
    failedAt: row.failedAt,
    createdAt: row.createdAt,
  })
```

```typescript
// src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type { OutboxMessage } from '#modules/auth/entities/outbox-message'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import { toDomainOutboxMessage, toPersistenceOutboxMessage } from './outbox-message-mapper.js'
import { outboxMessages } from './schema/outbox-messages.js'

const NO_ROW_AFFECTED = 0
const ONE_INCREMENT = 1

export class DrizzleOutboxMessagesRepository implements IOutboxMessagesRepository {
  constructor(private readonly db: Database) {}

  async save(message: OutboxMessage): Promise<void> {
    try {
      await this.db.insert(outboxMessages).values(toPersistenceOutboxMessage(message))
    } catch (error) {
      // Never re-throw what the driver gave us: this insert binds the message body.
      throw toPersistenceError(error)
    }
  }

  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    const rows = await this.db
      .select()
      .from(outboxMessages)
      .where(and(isNull(outboxMessages.dispatchedAt), isNull(outboxMessages.failedAt)))
      .orderBy(asc(outboxMessages.createdAt))
      .limit(limit)

    return rows.map(toDomainOutboxMessage)
  }

  async markDispatched(id: string, at: Date): Promise<void> {
    await this.db
      .update(outboxMessages)
      .set({ dispatchedAt: at })
      .where(eq(outboxMessages.id, id))
  }

  async recordFailure(
    id: string,
    at: Date,
    error: string,
    maxAttempts: number,
  ): Promise<void> {
    await this.db
      .update(outboxMessages)
      .set({
        attempts: sql`${outboxMessages.attempts} + ${ONE_INCREMENT}`,
        lastError: error,
        failedAt: sql`case when ${outboxMessages.attempts} + ${ONE_INCREMENT} >= ${maxAttempts} then ${at} else null end`,
      })
      .where(eq(outboxMessages.id, id))
  }

  async deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(outboxMessages)
      .where(
        or(
          and(
            sql`${outboxMessages.dispatchedAt} is not null`,
            lte(outboxMessages.dispatchedAt, cutoff),
          ),
          and(
            sql`${outboxMessages.failedAt} is not null`,
            lte(outboxMessages.failedAt, cutoff),
          ),
        ),
      )

    return result.rowCount ?? NO_ROW_AFFECTED
  }
}
```

Wire it into `authRepositories()` in `src/modules/auth/infra/drizzle/auth-repositories.ts`:

```typescript
// Add the import:
import { DrizzleOutboxMessagesRepository } from './drizzle-outbox-messages-repository.js'

// Add to the returned object:
    outboxMessages: new DrizzleOutboxMessagesRepository(db),
```

- [ ] **Step 4: Write the integration tests, run them, confirm they pass**

```typescript
// tests/integration/drizzle-outbox-messages-repository.spec.ts
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { DrizzleOutboxMessagesRepository } from '#modules/auth/infra/drizzle/drizzle-outbox-messages-repository'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const LATER = new Date('2026-09-15T12:05:00.000Z')
const MAX_ATTEMPTS = 3
const ONE_ROW = 1
const TWO_ROWS = 2
const NONE = 0
const ERROR_MESSAGE = 'connection refused'

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

const messageAt = (id: string, createdAt: Date) =>
  OutboxMessage.create({
    id,
    message: { to: `${id}@example.com`, subject: 'subject', text: 'text' },
    now: createdAt,
  })

describe('DrizzleOutboxMessagesRepository', () => {
  it('finds pending rows oldest first, ignoring dispatched and failed ones', async () => {
    await repository.save(messageAt('newest', LATER))
    await repository.save(messageAt('oldest', NOW))
    await repository.save(messageAt('dispatched', NOW))
    await repository.markDispatched('dispatched', LATER)

    const batch = await repository.findPendingBatch(TWO_ROWS)

    expect(batch.map((message) => message.id)).toEqual(['oldest', 'newest'])
  })

  it('sets failedAt only once attempts reaches the cap', async () => {
    await repository.save(messageAt('doomed', NOW))

    await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    let [pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(1)
    expect(pending?.failedAt).toBeNull()

    await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    ;[pending] = await repository.findPendingBatch(ONE_ROW)
    expect(pending?.attempts).toBe(2)
    expect(pending?.failedAt).toBeNull()

    await repository.recordFailure('doomed', LATER, ERROR_MESSAGE, MAX_ATTEMPTS)
    expect(await repository.findPendingBatch(ONE_ROW)).toHaveLength(NONE)
  })

  it('prunes only dispatched/failed rows at or before the cutoff, never a pending one', async () => {
    await repository.save(messageAt('old-dispatched', NOW))
    await repository.markDispatched('old-dispatched', NOW)
    await repository.save(messageAt('old-pending', NOW))

    const deleted = await repository.deleteDispatchedOrFailedBefore(LATER)

    expect(deleted).toBe(ONE_ROW)
    const survivors = await repository.findPendingBatch(TWO_ROWS)
    expect(survivors.map((message) => message.id)).toEqual(['old-pending'])
  })
})
```

```typescript
// tests/integration/outbox-messages-schema.spec.ts
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological.
const TABLE_NAME = 'outbox_messages'
const PENDING_INDEX = 'outbox_messages_pending_idx'
const PENDING_INDEX_PREDICATE =
  'WHERE ((dispatched_at IS NULL) AND (failed_at IS NULL))'
const NOT_NULL_VIOLATION = '23502'

const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const CREATED_AT = new Date('2026-09-15T00:00:00.000Z')
const ZERO_ATTEMPTS = 0
const ONE_INDEX = 1

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(outboxMessages)
})

const row = (overrides: Partial<typeof outboxMessages.$inferInsert> = {}) => ({
  id: ROW_ID,
  to: 'joao@example.com',
  subject: 'subject',
  text: 'text',
  attempts: ZERO_ATTEMPTS,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('outbox_messages table', () => {
  it('stores a row with every column, dispatchedAt/failedAt/lastError null by default input', async () => {
    await db.insert(outboxMessages).values(row())

    const [stored] = await db.select().from(outboxMessages)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.to).toBe('joao@example.com')
    expect(stored?.subject).toBe('subject')
    expect(stored?.text).toBe('text')
    expect(stored?.attempts).toBe(ZERO_ATTEMPTS)
    expect(stored?.lastError).toBeNull()
    expect(stored?.dispatchedAt).toBeNull()
    expect(stored?.failedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without attempts, proving there is no default', async () => {
    const { attempts: _attempts, ...withoutAttempts } = row()

    await expect(
      db.insert(outboxMessages).values(withoutAttempts as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('carries the partial pending index', async () => {
    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
      indexdef: string
    }>

    const pending = rows.filter((r) => r.indexname === PENDING_INDEX)
    expect(pending).toHaveLength(ONE_INDEX)
    expect(pending[0]?.indexdef).toContain(PENDING_INDEX_PREDICATE)
  })
})
```

Run: `pnpm test:integration -- drizzle-outbox-messages-repository outbox-messages-schema`
Expected: PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/infra/drizzle/schema/outbox-messages.ts \
  src/modules/auth/infra/drizzle/outbox-message-mapper.ts \
  src/modules/auth/infra/drizzle/drizzle-outbox-messages-repository.ts \
  src/modules/auth/infra/drizzle/auth-repositories.ts \
  drizzle/ \
  tests/integration/drizzle-outbox-messages-repository.spec.ts \
  tests/integration/outbox-messages-schema.spec.ts
git commit -m "feat(outbox): add the outbox_messages table and Drizzle repository

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Config — three new env vars

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/config.spec.ts`
- Modify: `.env.example`
- Modify: `src/infra/config/fixtures/test-env.ts`

**Interfaces:**
- Produces: `DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS`, `DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE`, `DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS` constants; `AuthConfig.OUTBOX_DISPATCH_MAX_ATTEMPTS`, `.OUTBOX_DISPATCH_BATCH_SIZE`, `.OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS` — consumed by Task 8 (container wiring).

- [ ] **Step 1: Write the failing test**

Add to `src/modules/auth/config.spec.ts`, alongside the existing prune-retention import and test:

```typescript
// Add to the import from '#modules/auth/config':
  DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE,
  DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS,
  DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS,
```

```typescript
  it('defaults the outbox dispatch and prune settings', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.OUTBOX_DISPATCH_MAX_ATTEMPTS).toBe(DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS)
    expect(config.OUTBOX_DISPATCH_BATCH_SIZE).toBe(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE)
    expect(config.OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS).toBe(
      DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS,
    )
  })

  it('rejects an empty outbox prune retention instead of coercing it to zero', () => {
    expect(() =>
      authEnvSchema.parse({
        ...MINIMAL_ENV,
        OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS: '',
      }),
    ).toThrow()
  })

  it('rejects an empty outbox max attempts instead of coercing it to zero', () => {
    // Zero would mark every row failed on its very first attempt.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, OUTBOX_DISPATCH_MAX_ATTEMPTS: '' }),
    ).toThrow()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/modules/auth/config.spec.ts`
Expected: FAIL — `DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS` etc. are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/modules/auth/config.ts`, right after the three `DEFAULT_*_PRUNE_RETENTION_SECONDS` constants:

```typescript
/**
 * Five attempts before a pending notice gives up and stops being retried
 * (design §3, §8). The interval BETWEEN attempts is whatever the external
 * scheduler invoking `cron.ts` is set to — that already is the backoff
 * (decision 30, §3.1 of the slice 13 design).
 */
export const DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS = 5

/** How many pending rows one dispatch run picks up. */
export const DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE = 100

/**
 * Seven days, same window as `refresh_tokens`: a dispatched or given-up-on
 * notice stays available for a post-mortem before the prune job removes it.
 */
export const DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS = 604_800
```

Add to the `authEnvSchema` object in the same file, right after `PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS`:

```typescript
  // `.int().positive()` for the same reason as every retention above: an
  // empty value coerced to 0 would mark a message failed on its first
  // attempt, or prune it the instant it is dispatched.
  OUTBOX_DISPATCH_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_DISPATCH_MAX_ATTEMPTS),
  OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE),
  OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS),
```

Add to `.env.example`, right after `PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS=86400`:

```
OUTBOX_DISPATCH_MAX_ATTEMPTS=5
OUTBOX_DISPATCH_BATCH_SIZE=100
OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS=604800
```

Add to `src/infra/config/fixtures/test-env.ts`: import the three `DEFAULT_*` constants alongside the existing ones, and add the three keys to the exported fixture object, mirroring `REFRESH_TOKEN_PRUNE_RETENTION_SECONDS`'s line exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/modules/auth/config.spec.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS — confirms the test-env fixture still satisfies `AuthConfig`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts .env.example \
  src/infra/config/fixtures/test-env.ts
git commit -m "feat(outbox): add OUTBOX_DISPATCH_* and OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS config

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Move `change-password`'s notification into the outbox

**Files:**
- Modify: `src/modules/auth/use-cases/change-password.ts`
- Modify: `src/modules/auth/use-cases/change-password.spec.ts`

**Interfaces:**
- Consumes: `OutboxMessage.create` (Task 1), `AuthRepos.outboxMessages` (Task 2), `IIdGenerator` from `#shared/ports/id-generator`.
- Produces: `ChangePasswordUseCase` constructor changes from `(usersRepository, uow, hashProvider, tokenSigner, refreshTokenIssuer, clock, emailSender)` to `(usersRepository, uow, hashProvider, tokenSigner, refreshTokenIssuer, clock, idGenerator)` — consumed by Task 8 (container wiring).

- [ ] **Step 1: Update the failing test**

In `src/modules/auth/use-cases/change-password.spec.ts`:

Replace the `SEND_EMAIL_CALL`/`sentEmails`/`emailSender` scaffolding with an `outboxMessages` tracking hook on `trackedRepos`, and swap the last constructor argument. Concretely:

- Remove the `SEND_EMAIL_CALL` constant, the `sentEmails: EmailMessage[]` variable, the `emailSender: IEmailSender` variable, and the whole `it('still returns a session when the notification cannot be delivered', ...)` test — that test no longer applies: the use case never calls a sender directly, so nothing about delivery can fail the request. Also remove the now-unused `BestEffortEmailSender`/`ErrorLogger`/`silentLogger`/`NOTIFICATION_FAILURE_MESSAGE` importsand declarations.
- Add `const SAVE_OUTBOX_CALL = 'saveOutboxMessage'` next to the other call-log constants.
- Add `outboxMessages: InMemoryOutboxMessagesRepository` alongside `usersRepository`/`refreshTokensRepository` in the `beforeEach`, and add its tracked entry to `trackedRepos`:

```typescript
    outboxMessages: {
      save: (message) => {
        callLog.push(SAVE_OUTBOX_CALL)
        return outboxMessages.save(message)
      },
      findPendingBatch: (limit) => outboxMessages.findPendingBatch(limit),
      markDispatched: (id, at) => outboxMessages.markDispatched(id, at),
      recordFailure: (id, at, error, maxAttempts) =>
        outboxMessages.recordFailure(id, at, error, maxAttempts),
      deleteDispatchedOrFailedBefore: (cutoff) =>
        outboxMessages.deleteDispatchedOrFailedBefore(cutoff),
    },
```

- Swap the constructor's last argument from `emailSender` to `{ generate: () => GENERATED_ID }` (an `IIdGenerator` double — `GENERATED_ID` already exists in the file for the refresh token issuer's double; reuse the same constant) in every `new ChangePasswordUseCase(...)` call site in the file.
- Update the ordering test's name and body:

```typescript
  it('writes the outbox row INSIDE the transaction, before it commits', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog).toEqual([
      COMPARE_CALL,
      HASH_CALL,
      // Everything below this line runs inside the transaction; everything
      // above it must not.
      UOW_CALL,
      UPDATE_CALL,
      REVOKE_ALL_CALL,
      SAVE_TOKEN_CALL,
      // The outbox row, before the commit: a crash right after this line still
      // loses nothing, because the row and the state change are one fact.
      SAVE_OUTBOX_CALL,
      COMMIT_CALL,
    ])
  })

  it('enqueues the password-changed notice for the outbox to dispatch later', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(outboxMessages.messages.map((message) => message.toEmailMessage())).toEqual([
      passwordChangedEmail(Email.fromTrusted(EMAIL)),
    ])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/modules/auth/use-cases/change-password.spec.ts`
Expected: FAIL — `ChangePasswordUseCase` still takes `emailSender`, and its callback does not touch `outboxMessages`.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/auth/use-cases/change-password.ts`:

```typescript
// Replace this import:
import type { IEmailSender } from '#shared/ports/email-sender'
// with:
import type { IIdGenerator } from '#shared/ports/id-generator'

// Add this import, alongside the other entity import:
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
```

Replace the constructor's last parameter:

```typescript
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}
```

Replace the `uow` call and the post-commit send:

```typescript
    await this.uow(async ({ users, refreshTokens, outboxMessages }) => {
      await users.updatePasswordHash(user.id, passwordHash, now)

      // BEFORE the insert, always. `revokeAllForUser` revokes every row of this
      // user whose `revoked_at` is null — inserting first would let it catch
      // the token minted one line below, which would be born revoked. The
      // endpoint would answer 200 and the very next refresh would answer 401.
      await refreshTokens.revokeAllForUser(user.id, now)

      await refreshTokens.save(issued.entity)

      // The notice, in the SAME transaction as the state it describes: a
      // crash right after this still loses nothing (design §5).
      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: passwordChangedEmail(user.email),
          now,
        }),
      )
    })

    return {
```

(Delete the old `// After the commit, like every other send...` comment and the `await this.emailSender.send(passwordChangedEmail(user.email))` line entirely — the `return` block right after it stays.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/modules/auth/use-cases/change-password.spec.ts`
Expected: PASS

Run: `pnpm lint && pnpm typecheck`
Expected: PASS — no unused imports left (`IEmailSender`, `BestEffortEmailSender` etc. in the spec file).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/change-password.ts src/modules/auth/use-cases/change-password.spec.ts
git commit -m "refactor(outbox): move change-password's notice into the outbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Move `reset-password`'s notification into the outbox

**Files:**
- Modify: `src/modules/auth/use-cases/reset-password.ts`
- Modify: `src/modules/auth/use-cases/reset-password.spec.ts`
- Modify: `tests/integration/reset-password.spec.ts`

**Interfaces:**
- Consumes: same as Task 5.
- Produces: `ResetPasswordUseCase` constructor changes from `(usersRepository, passwordResetTokens, uow, hashProvider, tokenDigest, clock, emailSender)` to `(usersRepository, passwordResetTokens, uow, hashProvider, tokenDigest, clock, idGenerator)` — consumed by Task 8.

- [ ] **Step 1: Update the failing tests**

In `src/modules/auth/use-cases/reset-password.spec.ts`:

Remove the `BestEffortEmailSender`/`ErrorLogger` import, the `EmailMessage`/`IEmailSender` import (replace with `IIdGenerator`), the `SEND_EMAIL_CALL` constant, the `NOTIFICATION_FAILURE_MESSAGE` constant, the `silentLogger` double, the `sentEmails`/`emailSender` variables, and the whole `it('still resolves when the completion email cannot be delivered', ...)` test at the end of the file — it no longer applies, since nothing about SMTP delivery can affect this use case's return value once the notice is only enqueued.

```typescript
// Replace:
import {
  BestEffortEmailSender,
  type ErrorLogger,
} from '#infra/providers/best-effort-email-sender'
// ... (PasswordResetToken / User / errors / in-memory repos unchanged) ...
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

// with:
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
// (keep every other existing import as-is)
import type { IIdGenerator } from '#shared/ports/id-generator'
```

```typescript
// Replace this call-log constant:
const SEND_EMAIL_CALL = 'sendEmail'
// with:
const SAVE_OUTBOX_CALL = 'saveOutboxMessage'

// Delete entirely:
const NOTIFICATION_FAILURE_MESSAGE = 'delivery unavailable'
const silentLogger: ErrorLogger = { error: () => {} }
```

```typescript
// Replace:
let sentEmails: EmailMessage[]
// with:
let outboxMessagesRepository: InMemoryOutboxMessagesRepository
```

```typescript
// Replace the makeUseCase helper's last parameter and its body:
const makeUseCase = (idGenerator: IIdGenerator) =>
  new ResetPasswordUseCase(
    usersRepository,
    { findByHash: findByHashSpy },
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: async () => false, dummyHash: DUMMY_HASH },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    { now: () => NOW },
    idGenerator,
  )
```

In the `beforeEach`, replace `sentEmails = []` with `outboxMessagesRepository = new InMemoryOutboxMessagesRepository()`, add an `outboxMessages` entry to `trackedRepos` right after `passwordResetTokens`:

```typescript
    outboxMessages: {
      save: (message) => {
        callLog.push(SAVE_OUTBOX_CALL)
        return outboxMessagesRepository.save(message)
      },
      findPendingBatch: (limit) => outboxMessagesRepository.findPendingBatch(limit),
      markDispatched: (id, at) => outboxMessagesRepository.markDispatched(id, at),
      recordFailure: (id, at, error, maxAttempts) =>
        outboxMessagesRepository.recordFailure(id, at, error, maxAttempts),
      deleteDispatchedOrFailedBefore: (cutoff) =>
        outboxMessagesRepository.deleteDispatchedOrFailedBefore(cutoff),
    },
```

and replace the bottom of `beforeEach`:

```typescript
// Replace:
  emailSender = {
    send: async (message) => {
      callLog.push(SEND_EMAIL_CALL)
      sentEmails.push(message)
    },
  }

  useCase = makeUseCase(emailSender)
// with:
  useCase = makeUseCase({ generate: () => 'generated-outbox-id' })
```

Update the two tests that reference the old send call:

```typescript
  it('hashes, consumes, writes the password, revokes every session, then enqueues the notice — in that order', async () => {
    storeUser()

    await reset()

    expect(callLog).toEqual([
      HASH_CALL,
      UOW_CALL,
      CONSUME_CALL,
      UPDATE_CALL,
      REVOKE_ALL_CALL,
      // The outbox row, INSIDE the transaction: a crash right after this line
      // still loses nothing, because the row and the state change are one fact.
      SAVE_OUTBOX_CALL,
      COMMIT_CALL,
    ])
    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
  })
```

```typescript
  it('enqueues the reset-completed notice for the outbox to dispatch later', async () => {
    storeUser()

    await reset()

    expect(outboxMessagesRepository.messages.map((m) => m.toEmailMessage())).toEqual([
      passwordResetCompletedEmail(Email.fromTrusted(EMAIL)),
    ])
  })
```

And in `it('rejects when it loses the consume race, ...')`, replace the trailing `expect(sentEmails).toEqual([])` with `expect(outboxMessagesRepository.messages).toEqual([])`.

In `tests/integration/reset-password.spec.ts`, replace the notification test:

```typescript
// Remove from the mailpit import list: latestMessage, waitForMessageCount
// (keep clearMailpit, extractResetToken if still used elsewhere in the file).

// Add:
import { eq } from 'drizzle-orm'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
```

```typescript
  it('enqueues a "password was reset" notice in the outbox after success', async () => {
    const token = await forgotAndFetchToken()
    await resetWith(token)

    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, PASSWORD_RESET_COMPLETED_SUBJECT))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.dispatchedAt).toBeNull()
  })
```

Check whether `TWO_MESSAGES`/`ONE_MESSAGE` constants in this file are still used elsewhere (the `forgotAndFetchToken` helper likely still waits for the verification-style token e-mail via mailpit, which stays unchanged since `passwordResetEmail` is out of outbox scope) — keep whichever constants are still referenced, remove only what becomes dead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/modules/auth/use-cases/reset-password.spec.ts`
Expected: FAIL — same shape of failure as Task 5.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/auth/use-cases/reset-password.ts`, apply the same pattern as Task 5 Step 3:

```typescript
// Replace:
import type { IEmailSender } from '#shared/ports/email-sender'
// with:
import type { IIdGenerator } from '#shared/ports/id-generator'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
```

```typescript
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}
```

```typescript
    await this.uow(async ({ users, refreshTokens, passwordResetTokens, outboxMessages }) => {
      if (!(await passwordResetTokens.consume(token.id, now))) {
        throw new PasswordResetFailedError()
      }

      await users.updatePasswordHash(token.userId, passwordHash, now)
      await refreshTokens.revokeAllForUser(token.userId, now)

      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: passwordResetCompletedEmail(user.email),
          now,
        }),
      )
    })
```

Delete the trailing `await this.emailSender.send(passwordResetCompletedEmail(user.email))` line and its comment (the method now ends right after the `uow` call, since it returns `void`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/modules/auth/use-cases/reset-password.spec.ts`
Expected: PASS

Run: `pnpm test:integration -- reset-password`
Expected: PASS (requires the local Postgres + Mailpit stack up via `pnpm db:up`)

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/reset-password.ts src/modules/auth/use-cases/reset-password.spec.ts \
  tests/integration/reset-password.spec.ts
git commit -m "refactor(outbox): move reset-password's notice into the outbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Move `sign-in-with-google`'s link notification into the outbox

**Files:**
- Modify: `src/modules/auth/use-cases/sign-in-with-google.ts`
- Modify: `src/modules/auth/use-cases/sign-in-with-google.spec.ts`
- Modify: `tests/integration/sign-in-with-google.spec.ts`

**Interfaces:**
- Consumes: same as Task 5. `SignInWithGoogleUseCase` already has `idGenerator` — no new constructor parameter needed there, only removal of `emailSender`.
- Produces: `SignInWithGoogleUseCase` constructor drops its last parameter (`emailSender: IEmailSender`) — consumed by Task 8.

- [ ] **Step 1: Update the failing tests**

In `src/modules/auth/use-cases/sign-in-with-google.spec.ts`, this file's `uowSpy` builds its `repos: AuthRepos` inline (not through a separately-named `trackedRepos` constant like Tasks 5/6), and its call log only records coarse steps (`VERIFY`, `COMPARE`, `UOW`, `COMMIT`, and today `SEND_EMAIL`) — there is no existing "delivery cannot fail the request" test in this file to remove.

```typescript
// Replace:
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
// with:
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
```

```typescript
// Replace this call-log constant:
const SEND_EMAIL = 'sendEmail'
// with:
const SAVE_OUTBOX = 'saveOutbox'
```

```typescript
// Replace:
let sentEmails: EmailMessage[]
// with:
let outboxMessagesRepository: InMemoryOutboxMessagesRepository
```

```typescript
// Delete the module-level emailSender constant entirely:
const emailSender: IEmailSender = {
  send: async (message) => {
    callLog.push(SEND_EMAIL)
    sentEmails.push(message)
  },
}
```

Add a small tracked wrapper right below the `refreshTokenIssuer` declaration (module scope, since `callLog` is reset per-test but the wrapper only needs to read the current `outboxMessagesRepository`, itself reassigned in `beforeEach`):

```typescript
const trackedOutboxMessages = (): IOutboxMessagesRepository => ({
  save: (message) => {
    callLog.push(SAVE_OUTBOX)
    return outboxMessagesRepository.save(message)
  },
  findPendingBatch: (limit) => outboxMessagesRepository.findPendingBatch(limit),
  markDispatched: (id, at) => outboxMessagesRepository.markDispatched(id, at),
  recordFailure: (id, at, error, maxAttempts) =>
    outboxMessagesRepository.recordFailure(id, at, error, maxAttempts),
  deleteDispatchedOrFailedBefore: (cutoff) =>
    outboxMessagesRepository.deleteDispatchedOrFailedBefore(cutoff),
})
```

In `beforeEach`: replace `sentEmails = []` with `outboxMessagesRepository = new InMemoryOutboxMessagesRepository()`, add `outboxMessages: trackedOutboxMessages(),` to the `repos: AuthRepos` object built inside `uowSpy` (right after `federatedIdentities: federatedIdentitiesRepository,`), and drop the constructor's last argument:

```typescript
// Replace the closing of the `new SignInWithGoogleUseCase(...)` call:
    hashProvider,
    idGenerator,
    clock,
    emailSender,
  )
// with:
    hashProvider,
    idGenerator,
    clock,
  )
```

Update the one test that exercises this notice:

```typescript
  it('links on the right password: identity + refresh token + outbox row in one uow, before the commit', async () => {
    storePasswordUser()

    const result = await useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
    expect(federatedIdentitiesRepository.rows).toHaveLength(1)
    expect(federatedIdentitiesRepository.rows[0]?.userId).toBe(USER_ID)
    expect(refreshTokensRepository.tokens).toHaveLength(1)
    expect(usersRepository.users).toHaveLength(1)
    expect(outboxMessagesRepository.messages.map((m) => m.toEmailMessage())).toEqual([
      googleAccountLinkedEmail(Email.fromTrusted(EMAIL)),
    ])
    expect(callLog).toEqual([VERIFY, COMPARE, UOW, SAVE_OUTBOX, COMMIT])
  })
```

In `tests/integration/sign-in-with-google.spec.ts`:

```typescript
// Add:
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
```

Replace this line in `it('links to the password account when the right password is supplied, and emails a warning', ...)`:

```typescript
    await waitForMessageCount(ONE_MESSAGE)
```

with:

```typescript
    const rows = await db.select().from(outboxMessages)
    expect(rows).toHaveLength(ONE_MESSAGE)
    expect(rows[0]?.dispatchedAt).toBeNull()
```

Leave every other `waitForMessageCount`/mailpit usage in this file untouched — they cover the register-path verification e-mail, which stays outside the outbox.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/modules/auth/use-cases/sign-in-with-google.spec.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `src/modules/auth/use-cases/sign-in-with-google.ts`:

```typescript
// Remove:
import type { IEmailSender } from '#shared/ports/email-sender'
// Add, alongside the other entity imports:
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
```

Remove the constructor's last parameter (`private readonly emailSender: IEmailSender,`).

Replace the link branch's `uow` call and the line after it:

```typescript
    await this.uow(async ({ federatedIdentities, refreshTokens, outboxMessages }) => {
      await federatedIdentities.save(link)
      await refreshTokens.save(issued.entity)
      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: googleAccountLinkedEmail(existing.email),
          now,
        }),
      )
    })

    return {
```

(Delete the old `// After the commit, best-effort:` comment and the `await this.emailSender.send(googleAccountLinkedEmail(existing.email))` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/modules/auth/use-cases/sign-in-with-google.spec.ts`
Expected: PASS

Run: `pnpm test:integration -- sign-in-with-google`
Expected: PASS

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/sign-in-with-google.ts src/modules/auth/use-cases/sign-in-with-google.spec.ts \
  tests/integration/sign-in-with-google.spec.ts
git commit -m "refactor(outbox): move sign-in-with-google's link notice into the outbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `DispatchOutboxMessagesUseCase` + `PruneOutboxMessagesUseCase`

**Files:**
- Create: `src/modules/auth/use-cases/dispatch-outbox-messages.ts`
- Create: `src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts`
- Create: `src/modules/auth/use-cases/prune-outbox-messages.ts`
- Create: `src/modules/auth/use-cases/prune-outbox-messages.spec.ts`

**Interfaces:**
- Consumes: `IOutboxMessagesRepository` (Task 2), `IEmailSender` from `#shared/ports/email-sender`, `IClock` from `#shared/ports/clock`.
- Produces: `DISPATCH_OUTBOX_MESSAGES_JOB = 'dispatch-outbox-messages'`, `DispatchOutboxMessagesUseCase` (`execute(): Promise<{ dispatched: number; failed: number }>`); `PRUNE_OUTBOX_MESSAGES_JOB = 'prune-outbox-messages'`, `PruneOutboxMessagesUseCase` (`execute(): Promise<{ rowsDeleted: number }>`) — consumed by Task 9 (container/`CronJob` wiring).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts
import { beforeEach, describe, expect, it } from 'vitest'
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
const NONE = 0
const ONE = 1
const TWO = 2
const THREE = 3

const message = (to: string): EmailMessage => ({ to, subject: 'subject', text: 'text' })

let repository: InMemoryOutboxMessagesRepository
let sentTo: string[]
let failing: Set<string>
let emailSender: IEmailSender
let useCase: DispatchOutboxMessagesUseCase

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
  sentTo = []
  failing = new Set()

  emailSender = {
    send: async (m) => {
      if (failing.has(m.to)) throw new Error(`smtp refused ${m.to}`)
      sentTo.push(m.to)
    },
  }

  useCase = new DispatchOutboxMessagesUseCase(
    repository,
    emailSender,
    { now: () => NOW },
    MAX_ATTEMPTS,
    BATCH_SIZE,
  )
})

const seed = async (...recipients: string[]) => {
  for (const to of recipients) {
    await repository.save(OutboxMessage.create({ id: to, message: message(to), now: NOW }))
  }
}

describe('DispatchOutboxMessagesUseCase', () => {
  it('names its job', () => {
    expect(DISPATCH_OUTBOX_MESSAGES_JOB).toBe('dispatch-outbox-messages')
  })

  it('reports zero/zero on an empty batch, without calling the sender', async () => {
    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: NONE })
  })

  it('marks a successfully sent message dispatched', async () => {
    await seed('ok@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: ONE, failed: NONE })
    expect(sentTo).toEqual(['ok@example.com'])
    expect(await repository.findPendingBatch(BATCH_SIZE)).toHaveLength(NONE)
  })

  it('records a failure without marking the row failed, below the cap', async () => {
    failing.add('bad@example.com')
    await seed('bad@example.com')

    const result = await useCase.execute()

    expect(result).toEqual({ dispatched: NONE, failed: ONE })
    const [pending] = await repository.findPendingBatch(BATCH_SIZE)
    expect(pending?.attempts).toBe(ONE)
    expect(pending?.failedAt).toBeNull()
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
      { now: () => NOW },
      MAX_ATTEMPTS,
      SMALL_BATCH_SIZE,
    )

    const result = await smallBatchUseCase.execute()

    expect(result).toEqual({ dispatched: SMALL_BATCH_SIZE, failed: NONE })
    expect(await repository.findPendingBatch(THREE)).toHaveLength(ONE)
  })
})
```

```typescript
// src/modules/auth/use-cases/prune-outbox-messages.spec.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import {
  PRUNE_OUTBOX_MESSAGES_JOB,
  PruneOutboxMessagesUseCase,
} from '#modules/auth/use-cases/prune-outbox-messages'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const ONE = 1
const NONE = 0

let repository: InMemoryOutboxMessagesRepository
let useCase: PruneOutboxMessagesUseCase

beforeEach(() => {
  repository = new InMemoryOutboxMessagesRepository()
  useCase = new PruneOutboxMessagesUseCase(repository, { now: () => NOW }, RETENTION_MS)
})

describe('PruneOutboxMessagesUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_OUTBOX_MESSAGES_JOB).toBe('prune-outbox-messages')
  })

  it('deletes a dispatched row past the retention window and reports the count', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    await repository.save(
      OutboxMessage.create({
        id: 'old',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: new Date(cutoff - ONE_MINUTE_MS),
      }),
    )
    await repository.markDispatched('old', new Date(cutoff - ONE_MINUTE_MS))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: ONE })
  })

  it('never deletes a still-pending row, however old', async () => {
    await repository.save(
      OutboxMessage.create({
        id: 'ancient-but-pending',
        message: { to: 'a@example.com', subject: 's', text: 't' },
        now: new Date(NOW.getTime() - RETENTION_MS * 2),
      }),
    )

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: NONE })
    expect(await repository.findPendingBatch(ONE)).toHaveLength(ONE)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts src/modules/auth/use-cases/prune-outbox-messages.spec.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/modules/auth/use-cases/dispatch-outbox-messages.ts
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'

/** The job id the scheduler and the run log key on. */
export const DISPATCH_OUTBOX_MESSAGES_JOB = 'dispatch-outbox-messages'

export interface DispatchResult {
  dispatched: number
  failed: number
}

/**
 * Sends every pending outbox row for real, one at a time, outside any
 * transaction: a failure on one row must not block or roll back the others
 * (same isolation `runJobs` gives two different `CronJob`s).
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
  ) {}

  async execute(): Promise<DispatchResult> {
    const pending = await this.outboxMessages.findPendingBatch(this.batchSize)
    let dispatched = 0
    let failed = 0

    for (const message of pending) {
      const now = this.clock.now()
      try {
        await this.emailSender.send(message.toEmailMessage())
        await this.outboxMessages.markDispatched(message.id, now)
        dispatched++
      } catch (error) {
        await this.outboxMessages.recordFailure(
          message.id,
          now,
          error instanceof Error ? error.message : String(error),
          this.maxAttempts,
        )
        failed++
      }
    }

    return { dispatched, failed }
  }
}
```

```typescript
// src/modules/auth/use-cases/prune-outbox-messages.ts
import type { IOutboxMessagesRepository } from '#modules/auth/repositories/outbox-messages-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_OUTBOX_MESSAGES_JOB = 'prune-outbox-messages'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Deletes outbox rows that were dispatched or given up on longer than the
 * retention window ago. Mirrors `PruneExpiredRefreshTokensUseCase` — same
 * cutoff arithmetic, same never-touch-a-live-row guarantee.
 */
export class PruneOutboxMessagesUseCase {
  constructor(
    private readonly outboxMessages: IOutboxMessagesRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.outboxMessages.deleteDispatchedOrFailedBefore(cutoff)
    return { rowsDeleted }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts src/modules/auth/use-cases/prune-outbox-messages.spec.ts`
Expected: PASS (8 + 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/dispatch-outbox-messages.ts \
  src/modules/auth/use-cases/dispatch-outbox-messages.spec.ts \
  src/modules/auth/use-cases/prune-outbox-messages.ts \
  src/modules/auth/use-cases/prune-outbox-messages.spec.ts
git commit -m "feat(outbox): add DispatchOutboxMessagesUseCase and PruneOutboxMessagesUseCase

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Wire it all into `container.ts` — two new `CronJob`s, three updated use cases

**Files:**
- Modify: `src/modules/auth/container.ts`
- Modify: `src/main/container.ts`
- Modify: `tests/integration/cron.spec.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–8.
- Produces: `makeAuthContainer(...)` publishes two more entries in `jobs`; `changePassword`/`resetPassword`/`signInWithGoogle` are constructed with `idGenerator` instead of `emailSender`/`bestEffortEmailSender`; `makeAuthContainer` drops its now-unused `logger: ErrorLogger` parameter entirely (its only use was building `bestEffortEmailSender`).

- [ ] **Step 1: Update the failing integration test**

In `tests/integration/cron.spec.ts`:

```typescript
// Add these imports:
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { DISPATCH_OUTBOX_MESSAGES_JOB } from '#modules/auth/use-cases/dispatch-outbox-messages'
import { PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB } from '#modules/auth/use-cases/prune-expired-password-reset-tokens'
import { PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB } from '#modules/auth/use-cases/prune-expired-pending-registrations'
import { PRUNE_OUTBOX_MESSAGES_JOB } from '#modules/auth/use-cases/prune-outbox-messages'
```

Update `EXPECTED_JOBS` from `3` to `5`, and add `await db.delete(outboxMessages)` to the top of `beforeEach` (before the other four deletes, since nothing references it via foreign key, order does not matter — but staying consistent with "clear everything, then seed" keeps the file readable).

The first test, `'with no selector, prunes the long-dead rows of every table and keeps the recent ones'`, currently asserts `outcomes.map(o => o.metrics?.rowsDeleted)` as a fixed-order array of three `1`s. That assertion no longer holds shape once a `dispatched`/`failed`-shaped job joins the list. Replace it with a lookup by job name instead of position:

```typescript
  it('with no selector, prunes the long-dead rows of every table and keeps the recent ones', async () => {
    await seedDeadAndRecentRows()

    const outcomes = await runCron(env, SILENT_LOGGER)

    expect(outcomes).toHaveLength(EXPECTED_JOBS)
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
    expect(cronExitCode(outcomes)).toBe(CRON_EXIT_OK)

    const rowsDeletedFor = (job: string) =>
      outcomes.find((outcome) => outcome.name.endsWith(job))?.metrics?.rowsDeleted

    expect(rowsDeletedFor(PRUNE_EXPIRED_REFRESH_TOKENS_JOB)).toBe(ROWS_DELETED_PER_JOB)
    expect(rowsDeletedFor(PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB)).toBe(
      ROWS_DELETED_PER_JOB,
    )
    expect(rowsDeletedFor(PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB)).toBe(
      ROWS_DELETED_PER_JOB,
    )
    expect(rowsDeletedFor(PRUNE_OUTBOX_MESSAGES_JOB)).toBe(NONE)

    const dispatchOutcome = outcomes.find((outcome) =>
      outcome.name.endsWith(DISPATCH_OUTBOX_MESSAGES_JOB),
    )
    expect(dispatchOutcome?.metrics).toEqual({ dispatched: NONE, failed: NONE })

    expect(await db.select().from(refreshTokens)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(SURVIVORS_PER_TABLE)
  })
```

Add a `const NONE = 0` near the other numeric constants. The second test (`'with a qualified selector, runs that job alone...'`) and the fourth (`'refuses an unknown selector...'`) need no change. The third test (`'with a module selector, runs every job of that module'`) already just checks `outcomes).toHaveLength(EXPECTED_JOBS)`, which the `EXPECTED_JOBS = 5` update covers.

Add one new test proving the dispatch job actually sends and marks a row dispatched, using the real SMTP transport (Mailpit, already the fixture every other integration test relies on):

```typescript
  it('dispatches a pending outbox row for real and marks it dispatched', async () => {
    await db.insert(outboxMessages).values({
      id: randomUUID(),
      to: EMAIL,
      subject: 'Your password was changed',
      text: 'Your password was just changed.',
      attempts: 0,
      createdAt: new Date(),
    })

    const outcomes = await runCron(
      env,
      SILENT_LOGGER,
      `${AUTH_MODULE}${JOB_NAME_SEPARATOR}${DISPATCH_OUTBOX_MESSAGES_JOB}`,
    )

    expect(outcomes).toHaveLength(ONE_JOB)
    expect(outcomes[0]?.metrics).toEqual({ dispatched: 1, failed: NONE })
    const [row] = await db.select().from(outboxMessages)
    expect(row?.dispatchedAt).not.toBeNull()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- cron.spec.ts`
Expected: FAIL — `makeContainer`/`container.auth.jobs` only has 3 jobs; `DISPATCH_OUTBOX_MESSAGES_JOB`/`PRUNE_OUTBOX_MESSAGES_JOB` are not exported yet from where the test imports them (they already exist from Task 8 — this failure is specifically "expected 5 jobs, got 3").

- [ ] **Step 3: Write minimal implementation**

In `src/modules/auth/container.ts`:

```typescript
// Add to the destructure from authRepositories(db):
  const {
    users: usersRepository,
    refreshTokens: refreshTokensRepository,
    pendingRegistrations: pendingRegistrationsRepository,
    passwordResetTokens: passwordResetTokensRepository,
    federatedIdentities: federatedIdentitiesRepository,
    outboxMessages: outboxMessagesRepository,
  } = authRepositories(db)
```

```typescript
// Add these imports near the other use-case imports, alphabetically:
import {
  DISPATCH_OUTBOX_MESSAGES_JOB,
  DispatchOutboxMessagesUseCase,
} from './use-cases/dispatch-outbox-messages.js'
import {
  PRUNE_OUTBOX_MESSAGES_JOB,
  PruneOutboxMessagesUseCase,
} from './use-cases/prune-outbox-messages.js'
```

Remove the now-entirely-unused `BestEffortEmailSender`/`ErrorLogger` import line:

```typescript
// Delete this import entirely:
import {
  BestEffortEmailSender,
  type ErrorLogger,
} from '#infra/providers/best-effort-email-sender'
```

Drop `logger` from `makeAuthContainer`'s signature — it was ONLY ever used to build `bestEffortEmailSender`, so once that is gone it is a dead parameter:

```typescript
// Replace:
export function makeAuthContainer(
  db: Database,
  config: AuthContainerConfig,
  runner: TransactionRunner,
  logger: ErrorLogger,
) {
// with:
export function makeAuthContainer(
  db: Database,
  config: AuthContainerConfig,
  runner: TransactionRunner,
) {
```

And in `src/main/container.ts`, drop the now-extra argument at the call site:

```typescript
// Replace:
  return { auth: makeAuthContainer(db, env, runner, logger) }
// with:
  return { auth: makeAuthContainer(db, env, runner) }
```

(`makeContainer`'s own `logger: AppLogger` parameter stays — it is still used for `createTransactionRunner(db, logger)` on the line above.)

Remove the `bestEffortEmailSender` construction:

```typescript
// Delete this block entirely:
  /**
   * The shared best-effort wrapper: used by the password-change and
   * password-reset notifications, where the state has already changed and a
   * failed send must not fail the request. Everything else gets the bare
   * sender, so an undeliverable verification code still fails loudly.
   */
  const bestEffortEmailSender = new BestEffortEmailSender(emailSender, logger)
```

Add the two new use cases, right after `pruneExpiredPasswordResetTokens`:

```typescript
  const dispatchOutboxMessages = new DispatchOutboxMessagesUseCase(
    outboxMessagesRepository,
    emailSender,
    clock,
    config.OUTBOX_DISPATCH_MAX_ATTEMPTS,
    config.OUTBOX_DISPATCH_BATCH_SIZE,
  )
  const pruneOutboxMessages = new PruneOutboxMessagesUseCase(
    outboxMessagesRepository,
    clock,
    config.OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
  )
```

Add the two jobs to the `jobs` array:

```typescript
    {
      name: DISPATCH_OUTBOX_MESSAGES_JOB,
      run: async () => {
        const { dispatched, failed } = await dispatchOutboxMessages.execute()
        return { dispatched, failed }
      },
    },
    {
      name: PRUNE_OUTBOX_MESSAGES_JOB,
      run: async () => {
        const { rowsDeleted } = await pruneOutboxMessages.execute()
        return { rowsDeleted }
      },
    },
```

Update the three use-case call sites, replacing their `bestEffortEmailSender`/nothing argument with `idGenerator`:

```typescript
    signInWithGoogle: new SignInWithGoogleUseCase(
      googleIdentityVerifier,
      usersRepository,
      federatedIdentitiesRepository,
      refreshTokensRepository,
      uow,
      refreshTokenIssuer,
      tokenSigner,
      hashProvider,
      idGenerator,
      clock,
    ),
```

```typescript
    changePassword: new ChangePasswordUseCase(
      usersRepository,
      uow,
      hashProvider,
      tokenSigner,
      refreshTokenIssuer,
      clock,
      idGenerator,
    ),
```

```typescript
    resetPassword: new ResetPasswordUseCase(
      usersRepository,
      passwordResetTokensRepository,
      uow,
      hashProvider,
      tokenDigest,
      clock,
      idGenerator,
    ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:integration -- cron.spec.ts`
Expected: PASS (5 tests)

Run: `pnpm test:integration` (full integration suite — confirms `login`, `register`, `change-password`, `reset-password`, `sign-in-with-google`, `verify-email`, `forgot-password` integration specs all still pass with the rewired container)
Expected: PASS

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/container.ts src/main/container.ts tests/integration/cron.spec.ts
git commit -m "feat(outbox): wire the dispatch and prune jobs, drop the per-use-case email senders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Documentation

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TODO.md`

`docs/STRUCTURE.md` needs no change: its §2 tree is generic (`entities/`,
`use-cases/`, `repositories/`, `infra/drizzle/schema/` — "one file per table"
— `infra/in-memory/`), and every outbox file lands inside a category already
documented there. Confirmed by inspection — unlike slice 13, which converted
`cron.ts`/`run-cron.ts` from "aspiracional" to real in that same tree, nothing
here is currently marked aspirational.

**Interfaces:** None — docs only, no code consumes these.

- [ ] **Step 1: `DECISIONS.md`**

Add a row to the decisions index table (find the table with rows `| 30 | ... |`, `| 31 | ... |`, `| 32 | ... |` near the top of the file):

```
| 33 | Outbox transacional | Escopado aos três avisos pós-commit; estado por timestamp nulável; retry com teto simples (sem backoff explícito); tabela no módulo `auth` |
```

Add a new numbered section at the end of the file, following the exact shape of decision 32's section (title, then prose paragraphs with **bold** lead-ins):

```markdown
### 33 — Outbox transacional: três avisos pós-commit, estado por timestamp, retry com teto simples

Fecha o furo "crash entre o `COMMIT` e o envio SMTP perde o e-mail em silêncio",
para os três avisos que o encerram: `passwordChangedEmail`,
`passwordResetCompletedEmail`, `googleAccountLinkedEmail`.

**Escopo deliberadamente parcial.** `verificationEmail` e `passwordResetEmail`
seguem fora — carregam segredo em texto claro, e colocar a linha em repouso no
banco até o despacho é exatamente o motivo que adiou o outbox inteiro na fatia
10. `accountAlreadyExistsEmail` também fica fora: sem escrita transacional
precedente, não há buraco de atomicidade ali para fechar.

**Estado por timestamp nulável, não enum.** `dispatched_at`/`failed_at` seguem
o mesmo idioma de `consumed_at`/`revoked_at`.

**Retry: contador simples com teto, sem backoff explícito.** O intervalo do
scheduler externo que já invoca `cron.ts` (decisão 30) cumpre esse papel.

**Rejeitados:** um outbox genérico em `shared/`, antes de um segundo módulo
para validar a forma certa (YAGNI); um worker de longa duração com
LISTEN/NOTIFY do Postgres em vez do poll one-shot do `cron.ts` (contradiria a
decisão 16 e o modelo one-shot da decisão 30).

Desenho completo em
[`2026-09-15-transactional-outbox-design.md`](superpowers/specs/2026-09-15-transactional-outbox-design.md).
```

- [ ] **Step 2: `TODO.md`**

Replace the "Outbox transacional" row in the urgency table:

```
| ~~Outbox transacional~~ | — | **fechada por esta fatia.** `outbox_messages` no módulo `auth`; os três avisos pós-commit (senha alterada, senha resetada, Google vinculado) são gravados dentro da mesma transação que muda o estado; `CronJob`s de dispatch e poda. Decisão 33; spec `2026-09-15-transactional-outbox-design.md` |
```

Update the opening summary blockquote (the `> **Fatia 16 ...** entregou ...` paragraph) following the exact style of the fatia 13/14/15 paragraphs already there, and update the "O que eu faria a seguir" closing section to point at "throttle de `confirm` por e-mail" as the next item, per §12 of the spec.

- [ ] **Step 3: Review the diffs**

Run: `git diff docs/DECISIONS.md docs/TODO.md`
Expected: every added line reads correctly in context; no leftover `~~strikethrough~~` inconsistency, no broken table row.

- [ ] **Step 4: Commit**

```bash
git add docs/DECISIONS.md docs/TODO.md
git commit -m "docs(outbox): record decision 33 and close out the TODO entry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After Task 10

Run the full suite once more end to end (`pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`) before moving to `finishing-a-development-branch` — this plan does not open a feature branch itself; per this repo's `CLAUDE.md` skill-chaining rule, branch creation and the architecture-audit / PR flow belong to that skill and `finish-with-review-pr`, invoked once every task above is checked off.
