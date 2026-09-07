# Poda de tokens expirados (`cron.ts`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the codebase the `main/cron.ts` one-shot entrypoint decision 10 reserved, a per-module cron-job registry, and three pure use-cases that prune expired rows from `refresh_tokens`, `pending_registrations` and `password_reset_tokens`.

**Architecture:** Each module publishes `jobs: CronJob[]` on its container slice. `main/run-cron.ts` builds the framework-free graph (`makeContainer`), runs every job in order isolating failures, and returns structured outcomes; `main/cron.ts` is the thin shell that logs them and sets the process exit code. The prune logic is a pure use-case per table — `cutoff = clock.now() - retention`, then a new `deleteExpiredBefore(cutoff)` repository method that issues one unconditional `DELETE ... WHERE expires_at <= $cutoff`.

**Tech Stack:** TypeScript (Node ≥24.19, ESM, `nodenext`), Drizzle ORM 1.0.0-rc.4 on `pg`, Vitest 4 (projects: `unit` = `src/**/*.spec.ts`, `integration` = `tests/integration/**/*.spec.ts`), Zod 4, Biome, dependency-cruiser for boundary enforcement.

**Spec:** [`docs/superpowers/specs/2026-09-07-token-pruning-cron-design.md`](../specs/2026-09-07-token-pruning-cron-design.md)

## Global Constraints

- **English only** in code, identifiers, strings, comments. Portuguese is allowed only in `*.md`.
- **No magic strings/numbers.** Extract to named `UPPER_SNAKE_CASE` constants, declared close to use (or in a shared `constants.ts` when crossing modules). Schema declaration files are the only exception, and only for table/column/index name strings.
- **Comments explain the code, not the process.** Never write "slice 13 added…", "the review found…", "measured, not assumed". Cite the spec by section (`§3.4`) instead of re-arguing it. Keep comments local to the file.
- **Node** `>=24.19.0 <25`, **pnpm** `>=11.7.0`.
- **Imports:** between top-level dirs use `#modules/*`, `#shared/*`, `#infra/*`, `#main/*`; within the same folder use a relative path with a `.js` extension. Never a bare relative path across folders.
- **Boundary rule** (dependency-cruiser, `pnpm check:boundaries`): `pure` (`use-cases/`, `repositories/`, `shared/**`, …) may import only `pure`; `module-infra` may import `pure` + `global-infra` + its own module's infra; `composition` (`src/modules/*/container.ts`, `src/main/**`) may import anything. The check must end with `modules cruised !== 0`.
- **Clock (R7):** the pure layer never calls `new Date()` with no argument. `new Date(millisNumber)` is deterministic and allowed. "Now" comes from the injected `IClock`.
- **Retention** is configured in **seconds** (env var) and converted to **milliseconds** in `container.ts` with the existing `MILLISECONDS_PER_SECOND` constant. The use-case receives `retentionMs`.
- **Prune predicate is exactly `expires_at <= cutoff`** — never also `revoked_at`/`consumed_at` (spec §3.4).
- **TDD**: failing test first, watch it fail, minimal implementation, watch it pass, commit. Falsify every test: prove the `DELETE` does **not** remove a live row.
- Run `pnpm lint` and `pnpm typecheck` before every commit; they must be clean.

---

## File Structure

**Create:**
- `src/shared/ports/cron-job.ts` — the `CronJob` contract (pure, cross-module).
- `src/modules/auth/use-cases/prune-expired-refresh-tokens.ts` (+ `.spec.ts`)
- `src/modules/auth/use-cases/prune-expired-pending-registrations.ts` (+ `.spec.ts`)
- `src/modules/auth/use-cases/prune-expired-password-reset-tokens.ts` (+ `.spec.ts`)
- `src/main/run-cron.ts` (+ `src/main/run-cron.spec.ts`)
- `src/main/cron.ts`
- `tests/integration/cron.spec.ts`

**Modify:**
- `src/modules/auth/repositories/{refresh-tokens,pending-registrations,password-reset-tokens}-repository.ts` — add `deleteExpiredBefore`.
- `src/modules/auth/infra/drizzle/drizzle-{refresh-tokens,pending-registrations,password-reset-tokens}-repository.ts` — implement it.
- `src/modules/auth/infra/in-memory/in-memory-{refresh-tokens,pending-registrations,password-reset-tokens}-repository.ts` — implement it.
- `src/modules/auth/repositories/noop-auth-repos.ts` — add the no-op member to the three shapes.
- `src/modules/auth/config.ts` — three `*_PRUNE_RETENTION_SECONDS` vars + three `DEFAULT_*` constants.
- `src/modules/auth/config.spec.ts` — cases for the new vars.
- `src/infra/config/fixtures/test-env.ts` — the three new keys.
- `.env.example` — the three new vars, documented.
- `src/modules/auth/container.ts` — build the three use-cases, expose `jobs`.
- `tests/integration/drizzle-{refresh-tokens,pending-registrations,password-reset-tokens}-repository.spec.ts` — a `deleteExpiredBefore` case each.
- `docs/DECISIONS.md`, `docs/STRUCTURE.md`, `docs/TODO.md`.

---

## Task 1: `deleteExpiredBefore` repository capability

**Files:**
- Modify: `src/modules/auth/repositories/refresh-tokens-repository.ts`
- Modify: `src/modules/auth/repositories/pending-registrations-repository.ts`
- Modify: `src/modules/auth/repositories/password-reset-tokens-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Test: `tests/integration/drizzle-refresh-tokens-repository.spec.ts`
- Test: `tests/integration/drizzle-pending-registrations-repository.spec.ts`
- Test: `tests/integration/drizzle-password-reset-tokens-repository.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `IRefreshTokensRepository.deleteExpiredBefore(cutoff: Date): Promise<number>`, and the identical method on `IPendingRegistrationsRepository` and `IPasswordResetTokensRepository`. Returns the number of rows deleted. Later tasks (use-cases) depend on this signature and on the in-memory adapters honoring it.

**Prerequisite:** the integration Postgres must be up — `docker compose up -d postgres-test` (port 5433). `pnpm test:integration` applies migrations via global setup.

- [ ] **Step 1: Write the failing integration test for the refresh-tokens adapter**

Add to `tests/integration/drizzle-refresh-tokens-repository.spec.ts`, inside the top-level `describe`. It reuses the file's existing `token(familyId, hash, id)` helper, `db`, `repo`, `NOW`, and `userId` from `beforeEach`. Add these constants near the other `const`s at the top of the file:

```ts
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const EXPECTED_PRUNED = 1
const EXPECTED_SURVIVORS = 1
```

Test body:

```ts
it('deletes only rows whose expires_at is at or before the cutoff, and reports the count', async () => {
  const cutoff = new Date(NOW.getTime() - RETENTION_MS)

  // Dead well before the cutoff — must go.
  const deadToken = RefreshToken.fromTrusted({
    id: nextId(),
    userId,
    tokenHash: 'a'.repeat(HASH_LENGTH),
    familyId: FAMILY_A,
    expiresAt: new Date(cutoff.getTime() - ONE_HOUR_MS),
    revokedAt: null,
    replacedBy: null,
    createdAt: new Date(cutoff.getTime() - ONE_HOUR_MS),
  })
  // Expired, but inside the retention window — must stay.
  const recentToken = RefreshToken.fromTrusted({
    id: nextId(),
    userId,
    tokenHash: 'b'.repeat(HASH_LENGTH),
    familyId: FAMILY_A,
    expiresAt: new Date(cutoff.getTime() + ONE_HOUR_MS),
    revokedAt: null,
    replacedBy: null,
    createdAt: new Date(cutoff.getTime() + ONE_HOUR_MS),
  })
  await repo.save(deadToken)
  await repo.save(recentToken)

  const deleted = await repo.deleteExpiredBefore(cutoff)

  expect(deleted).toBe(EXPECTED_PRUNED)
  const survivors = await db.select().from(refreshTokens)
  expect(survivors).toHaveLength(EXPECTED_SURVIVORS)
  expect(survivors[0]?.id).toBe(recentToken.id)
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:integration -- drizzle-refresh-tokens-repository`
Expected: FAIL — `repo.deleteExpiredBefore is not a function` (and a TS error: property missing on the interface).

- [ ] **Step 3: Add the method to the three contracts**

In `src/modules/auth/repositories/refresh-tokens-repository.ts`, add to the `IRefreshTokensRepository` interface:

```ts
  /**
   * Full sweep for the cron. Deletes every row whose `expires_at` is at or
   * before `cutoff`; the use case passes `clock.now() - retention`, so a dead
   * row lingers one retention window and stays available for a post-mortem
   * (design §3.4). Returns the deleted-row count for the run log.
   *
   * An unconditional `DELETE`: no transaction, no lock, no ordering. The three
   * prune tables share no invariant, and `replaced_by` carries no FK
   * (decision 11) exactly so a chain need not be deleted in order.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
```

Add the same method (same doc comment, trimmed of the `replaced_by` sentence) to `IPendingRegistrationsRepository` in `pending-registrations-repository.ts` and `IPasswordResetTokensRepository` in `password-reset-tokens-repository.ts`.

- [ ] **Step 4: Implement it in the three Drizzle adapters**

`src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts` — add `lte` to the `drizzle-orm` import (`import { and, eq, isNull, lte, sql } from 'drizzle-orm'`), add a module constant next to `SINGLE_ROW`:

```ts
/** What `rowCount` means when the driver surfaces `null`. */
const NO_ROW_AFFECTED = 0
```

and add the method to `DrizzleRefreshTokensRepository`:

```ts
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(refreshTokens)
      .where(lte(refreshTokens.expiresAt, cutoff))

    return result.rowCount ?? NO_ROW_AFFECTED
  }
```

`drizzle-pending-registrations-repository.ts` already imports `lte` and defines `NO_ROW_AFFECTED`. Add:

```ts
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(pendingRegistrations)
      .where(lte(pendingRegistrations.expiresAt, cutoff))

    return result.rowCount ?? NO_ROW_AFFECTED
  }
```

`drizzle-password-reset-tokens-repository.ts` already imports `lte` and defines `NO_ROW_AFFECTED`. Add:

```ts
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(passwordResetTokens)
      .where(lte(passwordResetTokens.expiresAt, cutoff))

    return result.rowCount ?? NO_ROW_AFFECTED
  }
```

- [ ] **Step 5: Implement it in the three in-memory adapters**

`in-memory-refresh-tokens-repository.ts` (array field is `tokens`):

```ts
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const survivors = this.tokens.filter((token) => token.expiresAt > cutoff)
    const deleted = this.tokens.length - survivors.length
    this.tokens.length = 0
    this.tokens.push(...survivors)
    return deleted
  }
```

`in-memory-pending-registrations-repository.ts` (array field is `rows`) — same body with `this.rows` and `each.expiresAt > cutoff`. `in-memory-password-reset-tokens-repository.ts` (array field is `rows`) — same. Boundary: `expiresAt > cutoff` survives, so `expiresAt === cutoff` is deleted — matches the Drizzle `lte`.

- [ ] **Step 6: Keep `noop-auth-repos.ts` compiling**

In `src/modules/auth/repositories/noop-auth-repos.ts`, add to each of the `refreshTokens`, `pendingRegistrations` and `passwordResetTokens` objects:

```ts
      deleteExpiredBefore: async () => 0,
```

(`0` is the emptiest value the `Promise<number>` signature allows, matching the file's existing `async () => false` / `async () => []` style.)

- [ ] **Step 7: Run the refresh-tokens integration test, verify it passes**

Run: `pnpm test:integration -- drizzle-refresh-tokens-repository`
Expected: PASS.

- [ ] **Step 8: Add the analogous failing test to the pending-registrations adapter**

In `tests/integration/drizzle-pending-registrations-repository.spec.ts`, add near the top constants:

```ts
const RETENTION_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const PRUNED_COUNT = 1
const SURVIVOR_COUNT = 1
```

and this test inside the `describe`, reusing `db`, `repo`, `NOW`, `EMAIL`, `TTL_SECONDS`, `MILLISECONDS_PER_SECOND`, `ZERO`:

```ts
it('deletes only rows expired at or before the cutoff, and reports the count', async () => {
  const cutoff = new Date(NOW.getTime() - RETENTION_MS)
  const deadIssuedAt = new Date(cutoff.getTime() - TTL_SECONDS * MILLISECONDS_PER_SECOND - HOUR_MS)
  const liveIssuedAt = new Date(NOW.getTime() - HOUR_MS)

  await repo.save(
    PendingRegistration.fromTrusted({
      id: ID_OLDER,
      email: Email.create(EMAIL),
      codeHash: DIGEST_A,
      attempts: ZERO,
      codeIssuedAt: deadIssuedAt,
      expiresAt: new Date(deadIssuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: deadIssuedAt,
    }),
  )
  await repo.save(
    PendingRegistration.fromTrusted({
      id: ID_NEWER,
      email: Email.create(EMAIL),
      codeHash: DIGEST_B,
      attempts: ZERO,
      codeIssuedAt: liveIssuedAt,
      expiresAt: new Date(liveIssuedAt.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
      createdAt: liveIssuedAt,
    }),
  )

  const deleted = await repo.deleteExpiredBefore(cutoff)

  expect(deleted).toBe(PRUNED_COUNT)
  const survivors = await db.select().from(pendingRegistrations)
  expect(survivors).toHaveLength(SURVIVOR_COUNT)
  expect(survivors[0]?.id).toBe(ID_NEWER)
})
```

Run: `pnpm test:integration -- drizzle-pending-registrations-repository` — expect the new test PASS (the method already exists from Step 4; this test is the falsification that a live row survives). If it fails, fix the adapter, not the test.

- [ ] **Step 9: Add the analogous test to the password-reset-tokens adapter**

In `tests/integration/drizzle-password-reset-tokens-repository.spec.ts`, add near the top constants:

```ts
const RETENTION_MS = 24 * 60 * 60 * 1000
const GAP_MS = 60 * 60 * 1000
const PRUNED = 1
const KEPT = 1
```

and this test, reusing `db`, `repo`, `userId`, `NOW`, `DIGEST_A`, `DIGEST_B`, `ID_FIRST`, `ID_SECOND`, `insertOtherUser`:

```ts
it('deletes only rows expired at or before the cutoff, and reports the count', async () => {
  const cutoff = new Date(NOW.getTime() - RETENTION_MS)
  const otherUserId = await insertOtherUser()
  const deadAt = new Date(cutoff.getTime() - GAP_MS)
  const liveAt = new Date(cutoff.getTime() + GAP_MS)

  await db.insert(passwordResetTokens).values({
    id: ID_FIRST,
    userId,
    tokenHash: DIGEST_A,
    issuedAt: deadAt,
    expiresAt: deadAt,
    consumedAt: null,
    createdAt: deadAt,
  })
  await db.insert(passwordResetTokens).values({
    id: ID_SECOND,
    userId: otherUserId,
    tokenHash: DIGEST_B,
    issuedAt: liveAt,
    expiresAt: liveAt,
    consumedAt: null,
    createdAt: liveAt,
  })

  const deleted = await repo.deleteExpiredBefore(cutoff)

  expect(deleted).toBe(PRUNED)
  const survivors = await db.select().from(passwordResetTokens)
  expect(survivors).toHaveLength(KEPT)
  expect(survivors[0]?.id).toBe(ID_SECOND)
})
```

Run: `pnpm test:integration -- drizzle-password-reset-tokens-repository` — expect PASS.

- [ ] **Step 10: Full check + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:integration && pnpm check:boundaries`
Expected: all green; `check:boundaries` reports a non-zero module count and no violations.

```bash
git add src/modules/auth/repositories src/modules/auth/infra tests/integration/drizzle-refresh-tokens-repository.spec.ts tests/integration/drizzle-pending-registrations-repository.spec.ts tests/integration/drizzle-password-reset-tokens-repository.spec.ts
git commit -m "feat(auth): add deleteExpiredBefore to the three token repositories

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: The three prune use-cases

**Files:**
- Create: `src/modules/auth/use-cases/prune-expired-refresh-tokens.ts`
- Create: `src/modules/auth/use-cases/prune-expired-refresh-tokens.spec.ts`
- Create: `src/modules/auth/use-cases/prune-expired-pending-registrations.ts`
- Create: `src/modules/auth/use-cases/prune-expired-pending-registrations.spec.ts`
- Create: `src/modules/auth/use-cases/prune-expired-password-reset-tokens.ts`
- Create: `src/modules/auth/use-cases/prune-expired-password-reset-tokens.spec.ts`

**Interfaces:**
- Consumes: `deleteExpiredBefore(cutoff: Date): Promise<number>` on the three repo contracts (Task 1); `IClock` from `#shared/ports/clock` (`now(): Date`).
- Produces:
  - `PruneExpiredRefreshTokensUseCase` — `constructor(refreshTokens: IRefreshTokensRepository, clock: IClock, retentionMs: number)`, `execute(): Promise<{ rowsDeleted: number }>`; exported const `PRUNE_EXPIRED_REFRESH_TOKENS_JOB = 'prune-expired-refresh-tokens'`.
  - `PruneExpiredPendingRegistrationsUseCase` — `constructor(pendingRegistrations: IPendingRegistrationsRepository, clock: IClock, retentionMs: number)`; exported const `PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB = 'prune-expired-pending-registrations'`.
  - `PruneExpiredPasswordResetTokensUseCase` — `constructor(passwordResetTokens: IPasswordResetTokensRepository, clock: IClock, retentionMs: number)`; exported const `PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB = 'prune-expired-password-reset-tokens'`.
  - All three share the return type `interface PruneResult { rowsDeleted: number }`, exported from each file.

- [ ] **Step 1: Write the failing unit test for the refresh-tokens use-case**

Create `src/modules/auth/use-cases/prune-expired-refresh-tokens.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import {
  PruneExpiredRefreshTokensUseCase,
  PRUNE_EXPIRED_REFRESH_TOKENS_JOB,
} from '#modules/auth/use-cases/prune-expired-refresh-tokens'

const NOW = new Date('2026-09-07T12:00:00.000Z')
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'

const at = (id: string, expiresAt: Date) =>
  RefreshToken.fromTrusted({
    id,
    userId: USER_ID,
    tokenHash: `digest:${id}`,
    familyId: FAMILY_ID,
    expiresAt,
    revokedAt: null,
    replacedBy: null,
    createdAt: expiresAt,
  })

let repository: InMemoryRefreshTokensRepository
let useCase: PruneExpiredRefreshTokensUseCase

beforeEach(() => {
  repository = new InMemoryRefreshTokensRepository()
  useCase = new PruneExpiredRefreshTokensUseCase(repository, { now: () => NOW }, RETENTION_MS)
})

describe('PruneExpiredRefreshTokensUseCase', () => {
  it('names its job', () => {
    expect(PRUNE_EXPIRED_REFRESH_TOKENS_JOB).toBe('prune-expired-refresh-tokens')
  })

  it('deletes tokens whose expiry is at or before now minus the retention window', async () => {
    const cutoff = NOW.getTime() - RETENTION_MS
    repository.tokens.push(
      at('dead', new Date(cutoff - ONE_MINUTE_MS)),
      at('exactly-on-cutoff', new Date(cutoff)),
      at('inside-window', new Date(cutoff + ONE_MINUTE_MS)),
    )

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: 2 })
    expect(repository.tokens.map((token) => token.id)).toEqual(['inside-window'])
  })

  it('reports zero when nothing is old enough', async () => {
    repository.tokens.push(at('fresh', new Date(NOW.getTime() + ONE_MINUTE_MS)))

    const result = await useCase.execute()

    expect(result).toEqual({ rowsDeleted: 0 })
    expect(repository.tokens).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:unit -- prune-expired-refresh-tokens`
Expected: FAIL — cannot resolve `#modules/auth/use-cases/prune-expired-refresh-tokens`.

- [ ] **Step 3: Write the use-case**

Create `src/modules/auth/use-cases/prune-expired-refresh-tokens.ts`:

```ts
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IClock } from '#shared/ports/clock'

/** The job id the scheduler and the run log key on. */
export const PRUNE_EXPIRED_REFRESH_TOKENS_JOB = 'prune-expired-refresh-tokens'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Deletes refresh tokens dead longer than the retention window — `expires_at <=
 * clock.now() - retention`. The window keeps a dead row available for a
 * post-mortem; the predicate and the trade-off are design §3.4.
 */
export class PruneExpiredRefreshTokensUseCase {
  constructor(
    private readonly refreshTokens: IRefreshTokensRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.refreshTokens.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm test:unit -- prune-expired-refresh-tokens`
Expected: PASS (all three cases).

- [ ] **Step 5: Write the pending-registrations use-case + spec**

Create `src/modules/auth/use-cases/prune-expired-pending-registrations.ts` — identical shape, swapping the dependency and the constant:

```ts
import type { IPendingRegistrationsRepository } from '#modules/auth/repositories/pending-registrations-repository'
import type { IClock } from '#shared/ports/clock'

export const PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB = 'prune-expired-pending-registrations'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Full sweep of abandoned pending registrations. The opportunistic prune in
 * `deleteExpiredByEmail` only reaches addresses with new traffic; this covers
 * the rest. Predicate and window: design §3.4.
 */
export class PruneExpiredPendingRegistrationsUseCase {
  constructor(
    private readonly pendingRegistrations: IPendingRegistrationsRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.pendingRegistrations.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
```

Create `src/modules/auth/use-cases/prune-expired-pending-registrations.spec.ts` — copy the refresh-tokens spec, replacing: import path and class/const names; the repository with `InMemoryPendingRegistrationsRepository` (array field `rows`); the seed helper with `PendingRegistration.fromTrusted({ id, email: Email.create('joao@example.com'), codeHash: \`digest:${id}\`, attempts: 0, codeIssuedAt: expiresAt, expiresAt, consumedAt: null, createdAt: expiresAt })`; `repository.tokens` → `repository.rows`. Keep the same three cases and the same `RETENTION_MS = 24 * 60 * 60 * 1000`. Add `import { PendingRegistration } from '#modules/auth/entities/pending-registration'` and `import { Email } from '#modules/auth/value-objects/email'`.

- [ ] **Step 6: Write the password-reset-tokens use-case + spec**

Create `src/modules/auth/use-cases/prune-expired-password-reset-tokens.ts`:

```ts
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IClock } from '#shared/ports/clock'

export const PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB = 'prune-expired-password-reset-tokens'

export interface PruneResult {
  rowsDeleted: number
}

/**
 * Full sweep of spent and abandoned reset tokens. `issueOrRefresh` only ever
 * supersedes the one live row per account; nothing else clears the table.
 * Predicate and window: design §3.4.
 */
export class PruneExpiredPasswordResetTokensUseCase {
  constructor(
    private readonly passwordResetTokens: IPasswordResetTokensRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<PruneResult> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.passwordResetTokens.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
```

Create `src/modules/auth/use-cases/prune-expired-password-reset-tokens.spec.ts` — copy the refresh-tokens spec, replacing: import path and class/const names; the repository with `InMemoryPasswordResetTokensRepository` (array field `rows`); the seed helper with `PasswordResetToken.fromTrusted({ id, userId: USER_ID, tokenHash: \`digest:${id}\`, issuedAt: expiresAt, expiresAt, consumedAt: null, createdAt: expiresAt })`; `repository.tokens` → `repository.rows`. Same three cases, `RETENTION_MS = 24 * 60 * 60 * 1000`. Add `import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'`.

- [ ] **Step 7: Full check + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm check:boundaries`
Expected: all green.

```bash
git add src/modules/auth/use-cases/prune-expired-refresh-tokens.ts src/modules/auth/use-cases/prune-expired-refresh-tokens.spec.ts src/modules/auth/use-cases/prune-expired-pending-registrations.ts src/modules/auth/use-cases/prune-expired-pending-registrations.spec.ts src/modules/auth/use-cases/prune-expired-password-reset-tokens.ts src/modules/auth/use-cases/prune-expired-password-reset-tokens.spec.ts
git commit -m "feat(auth): add the three expired-token prune use-cases

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Retention configuration

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/config.spec.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: three keys on `AuthConfig` (and therefore on `Env`) — `REFRESH_TOKEN_PRUNE_RETENTION_SECONDS`, `PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS`, `PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS`, all `number`, positive integers, with defaults `604800`, `86400`, `86400`. Exported constants `DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS`, `DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS`, `DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS`. Task 4's `container.ts` reads these keys.

- [ ] **Step 1: Write the failing config tests**

Add to `src/modules/auth/config.spec.ts` (extend the import from `#modules/auth/config` with the three new `DEFAULT_*` names):

```ts
it('defaults the refresh-token prune retention to seven days', () => {
  const result = authEnvSchema.safeParse({ JWT_SECRET: VALID_SECRET })

  expect(result.success).toBe(true)
  expect(result.data?.REFRESH_TOKEN_PRUNE_RETENTION_SECONDS).toBe(
    DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS,
  )
})

it('rejects an empty prune retention instead of coercing it to zero', () => {
  // A retention of zero deletes rows the instant they expire, taking the
  // post-mortem window with them.
  const result = authEnvSchema.safeParse({
    JWT_SECRET: VALID_SECRET,
    PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS: '',
  })

  expect(result.success).toBe(false)
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm test:unit -- config.spec`
Expected: FAIL — `DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS` is not exported; `data.REFRESH_TOKEN_PRUNE_RETENTION_SECONDS` is `undefined`.

- [ ] **Step 3: Add the constants and schema keys**

In `src/modules/auth/config.ts`, near the other `DEFAULT_*` declarations, add:

```ts
/** 7 days — dead refresh tokens stay this long past expiry for a post-mortem (design §3.4). */
export const DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS = 604_800

/** 24 hours — abandoned pending registrations stay this long past expiry (design §3.4). */
export const DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS = 86_400

/** 24 hours — spent reset tokens stay this long past expiry (design §3.4). */
export const DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS = 86_400
```

Inside `authEnvSchema` (before the closing `})`), add:

```ts
  // `.int().positive()` for the reason every value here carries it: bare
  // `z.coerce.number()` turns an empty value into 0, and a retention of zero
  // prunes a row the moment it expires.
  REFRESH_TOKEN_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS),
  PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS),
  PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS),
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test:unit -- config.spec`
Expected: PASS.

- [ ] **Step 5: Fill the `Env` fixture**

`src/infra/config/fixtures/test-env.ts` builds a complete `Env` literal, so it will not typecheck until the three keys are present. Add to its `#modules/auth/config` import the three `DEFAULT_*` names, and add to the `TEST_ENV` object:

```ts
  REFRESH_TOKEN_PRUNE_RETENTION_SECONDS: DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS,
  PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS:
    DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS,
  PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS:
    DEFAULT_PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS,
```

- [ ] **Step 6: Document them in `.env.example`**

Append to `.env.example`:

```bash
# How long a dead token row survives past expiry before the cron prunes it
# (docs/superpowers/specs/2026-09-07-token-pruning-cron-design.md §3.4). Seconds.
# A longer window is a bigger post-mortem trail and a bigger table.
REFRESH_TOKEN_PRUNE_RETENTION_SECONDS=604800
PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS=86400
PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS=86400
```

- [ ] **Step 7: Full check + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green (unit + integration).

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts src/infra/config/fixtures/test-env.ts .env.example
git commit -m "feat(auth): add per-table prune retention config

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `CronJob` port, container wiring, and the `cron.ts` entrypoint

**Files:**
- Create: `src/shared/ports/cron-job.ts`
- Create: `src/main/run-cron.ts`
- Create: `src/main/run-cron.spec.ts`
- Create: `src/main/cron.ts`
- Create: `tests/integration/cron.spec.ts`
- Modify: `src/modules/auth/container.ts`

**Interfaces:**
- Consumes: the three use-case classes and `PRUNE_EXPIRED_*_JOB` constants (Task 2); the three `*_PRUNE_RETENTION_SECONDS` config keys (Task 3); `makeContainer(db, env, logger)` from `src/main/container.ts`; `createDatabase(env): { db, pool }` from `#infra/database/client`; `createLogger(env)` and type `AppLogger` from `#infra/observability/logger`; `MILLISECONDS_PER_SECOND` already declared in `container.ts`.
- Produces:
  - `interface CronJob { readonly name: string; run(): Promise<Record<string, number>> }` at `#shared/ports/cron-job`.
  - `AuthContainer` gains `jobs: CronJob[]`.
  - `src/main/run-cron.ts` exports: `interface JobOutcome { name: string; durationMs: number; metrics?: Record<string, number>; error?: unknown }`; `runJobs(jobs: readonly CronJob[]): Promise<JobOutcome[]>`; `cronExitCode(outcomes: readonly JobOutcome[]): number`; `runCron(env: Env, logger: AppLogger): Promise<JobOutcome[]>`; `const CRON_EXIT_OK = 0`; `const CRON_EXIT_JOB_FAILED = 1`.

- [ ] **Step 1: Write the `CronJob` port**

Create `src/shared/ports/cron-job.ts`:

```ts
/**
 * A unit of scheduled maintenance a module publishes for the `cron.ts`
 * entrypoint to run. The runner does not read `run`'s result shape — it merges
 * the object into the run-log line — so a prune job returns `{ rowsDeleted }`
 * and a future outbox-dispatch job returns its own counters.
 */
export interface CronJob {
  /** Stable identifier the scheduler and the run log key on. kebab-case. */
  readonly name: string
  run(): Promise<Record<string, number>>
}
```

- [ ] **Step 2: Write the failing unit test for `runJobs` / `cronExitCode`**

Create `src/main/run-cron.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CronJob } from '#shared/ports/cron-job'
import {
  CRON_EXIT_JOB_FAILED,
  CRON_EXIT_OK,
  cronExitCode,
  runJobs,
} from './run-cron.js'

const okJob = (name: string, rowsDeleted: number): CronJob => ({
  name,
  run: async () => ({ rowsDeleted }),
})

const throwingJob = (name: string): CronJob => ({
  name,
  run: async () => {
    throw new Error(`${name} blew up`)
  },
})

describe('runJobs', () => {
  it('runs every job in order and returns one outcome per job', async () => {
    const outcomes = await runJobs([okJob('first', 3), okJob('second', 0)])

    expect(outcomes.map((outcome) => outcome.name)).toEqual(['first', 'second'])
    expect(outcomes[0]?.metrics).toEqual({ rowsDeleted: 3 })
    expect(outcomes[1]?.metrics).toEqual({ rowsDeleted: 0 })
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
  })

  it('records a throwing job and still runs the ones after it', async () => {
    const outcomes = await runJobs([throwingJob('bad'), okJob('good', 1)])

    expect(outcomes[0]?.name).toBe('bad')
    expect(outcomes[0]?.error).toBeInstanceOf(Error)
    expect(outcomes[0]?.metrics).toBeUndefined()
    expect(outcomes[1]?.name).toBe('good')
    expect(outcomes[1]?.metrics).toEqual({ rowsDeleted: 1 })
  })
})

describe('cronExitCode', () => {
  it('is OK when every outcome succeeded', () => {
    expect(cronExitCode([{ name: 'a', durationMs: 1, metrics: { rowsDeleted: 0 } }])).toBe(
      CRON_EXIT_OK,
    )
  })

  it('is the failure code when any outcome carries an error', () => {
    expect(
      cronExitCode([
        { name: 'a', durationMs: 1, metrics: {} },
        { name: 'b', durationMs: 1, error: new Error('x') },
      ]),
    ).toBe(CRON_EXIT_JOB_FAILED)
  })
})
```

- [ ] **Step 3: Run, verify failure**

Run: `pnpm test:unit -- run-cron`
Expected: FAIL — cannot resolve `./run-cron.js`.

- [ ] **Step 4: Write `run-cron.ts`**

Create `src/main/run-cron.ts`:

```ts
import { performance } from 'node:perf_hooks'
import type { Env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import type { CronJob } from '#shared/ports/cron-job'
import { makeContainer } from './container.js'

export const CRON_EXIT_OK = 0
export const CRON_EXIT_JOB_FAILED = 1

export interface JobOutcome {
  name: string
  durationMs: number
  /** Present when the job returned. Merged into the run log. */
  metrics?: Record<string, number>
  /** Present when the job threw. */
  error?: unknown
}

/**
 * Runs each job in order, isolating failures: a job that throws is recorded and
 * the next still runs. Split from `runCron` so the loop is unit-testable with no
 * database. Serial and not parallel — a one-shot has no deadline, and serial
 * keeps database load predictable and the log readable (design §5.1).
 */
export async function runJobs(jobs: readonly CronJob[]): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = []
  for (const job of jobs) {
    const start = performance.now()
    try {
      const metrics = await job.run()
      outcomes.push({ name: job.name, durationMs: performance.now() - start, metrics })
    } catch (error) {
      outcomes.push({ name: job.name, durationMs: performance.now() - start, error })
    }
  }
  return outcomes
}

export function cronExitCode(outcomes: readonly JobOutcome[]): number {
  return outcomes.some((outcome) => outcome.error !== undefined)
    ? CRON_EXIT_JOB_FAILED
    : CRON_EXIT_OK
}

/**
 * Builds the framework-free graph (decision 10), runs every module's cron jobs,
 * and closes the pool. Does not log or call `process.exit` — `cron.ts` owns
 * both, so this stays a function returning data.
 */
export async function runCron(env: Env, logger: AppLogger): Promise<JobOutcome[]> {
  const { db, pool } = createDatabase(env)
  try {
    const container = makeContainer(db, env, logger)
    return await runJobs([...container.auth.jobs])
  } finally {
    await pool.end()
  }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm test:unit -- run-cron`
Expected: PASS (four cases).

- [ ] **Step 6: Wire `jobs` into the auth container**

In `src/modules/auth/container.ts`:

Add imports next to the other use-case imports:

```ts
import {
  PruneExpiredPasswordResetTokensUseCase,
  PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB,
} from './use-cases/prune-expired-password-reset-tokens.js'
import {
  PruneExpiredPendingRegistrationsUseCase,
  PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB,
} from './use-cases/prune-expired-pending-registrations.js'
import {
  PruneExpiredRefreshTokensUseCase,
  PRUNE_EXPIRED_REFRESH_TOKENS_JOB,
} from './use-cases/prune-expired-refresh-tokens.js'
```

and the type import at the top of the file:

```ts
import type { CronJob } from '#shared/ports/cron-job'
```

Inside `makeAuthContainer`, after the existing use-case wiring and before `return {`:

```ts
  const pruneExpiredRefreshTokens = new PruneExpiredRefreshTokensUseCase(
    refreshTokensRepository,
    clock,
    config.REFRESH_TOKEN_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
  )
  const pruneExpiredPendingRegistrations = new PruneExpiredPendingRegistrationsUseCase(
    pendingRegistrationsRepository,
    clock,
    config.PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
  )
  const pruneExpiredPasswordResetTokens = new PruneExpiredPasswordResetTokensUseCase(
    passwordResetTokensRepository,
    clock,
    config.PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
  )

  /**
   * What this module hands the `cron.ts` entrypoint. `run` returns
   * `{ rowsDeleted }`, which satisfies `CronJob`'s `Record<string, number>`.
   */
  const jobs: CronJob[] = [
    { name: PRUNE_EXPIRED_REFRESH_TOKENS_JOB, run: () => pruneExpiredRefreshTokens.execute() },
    {
      name: PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB,
      run: () => pruneExpiredPendingRegistrations.execute(),
    },
    {
      name: PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB,
      run: () => pruneExpiredPasswordResetTokens.execute(),
    },
  ]
```

Add `jobs,` to the returned object (near `uow,` / `closeEmailTransport`).

- [ ] **Step 7: Write `cron.ts`**

Create `src/main/cron.ts`:

```ts
import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import { cronExitCode, runCron } from './run-cron.js'

const CRON_JOB_DONE = 'cron job done'
const CRON_JOB_FAILED = 'cron job failed'
const CRON_RUN_COMPLETE = 'cron run complete'

const logger = createLogger(env)
const outcomes = await runCron(env, logger)

for (const outcome of outcomes) {
  if (outcome.error !== undefined) {
    logger.error(
      { job: outcome.name, durationMs: outcome.durationMs, err: outcome.error },
      CRON_JOB_FAILED,
    )
  } else {
    logger.info(
      { job: outcome.name, durationMs: outcome.durationMs, ...outcome.metrics },
      CRON_JOB_DONE,
    )
  }
}

const exitCode = cronExitCode(outcomes)
logger.info({ jobs: outcomes.length, exitCode }, CRON_RUN_COMPLETE)
process.exit(exitCode)
```

- [ ] **Step 8: Write the failing end-to-end integration test**

Create `tests/integration/cron.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import type { AppLogger } from '#infra/observability/logger'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { cronExitCode, CRON_EXIT_OK, runCron } from '#main/run-cron'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const HASH_LENGTH = 64
const EXPECTED_JOBS = 3
const ROWS_DELETED_PER_JOB = 1
const SURVIVORS_PER_TABLE = 1

const DAY_MS = 24 * 60 * 60 * 1000
const LONG_AGO_MS = 8 * DAY_MS
const RECENTLY_MS = 60 * 60 * 1000

/** Only `makeContainer` needs it; the cron run logs nothing itself. */
const SILENT_LOGGER = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as AppLogger

let db: Database
let pool: Pool
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(pendingRegistrations)
  await db.delete(passwordResetTokens)
  await db.delete(users)
  const [created] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })
  userId = created?.id ?? ''
})

const ago = (ms: number) => new Date(Date.now() - ms)

describe('runCron', () => {
  it('prunes the long-dead rows of every table and keeps the recent ones', async () => {
    const dead = ago(LONG_AGO_MS)
    const recent = ago(RECENTLY_MS)

    await db.insert(refreshTokens).values([
      { id: crypto.randomUUID(), userId, tokenHash: 'a'.repeat(HASH_LENGTH), familyId: crypto.randomUUID(), expiresAt: dead, createdAt: dead },
      { id: crypto.randomUUID(), userId, tokenHash: 'b'.repeat(HASH_LENGTH), familyId: crypto.randomUUID(), expiresAt: recent, createdAt: recent },
    ])
    await db.insert(pendingRegistrations).values([
      { id: crypto.randomUUID(), email: EMAIL, codeHash: 'x', attempts: 0, codeIssuedAt: dead, expiresAt: dead, createdAt: dead },
      { id: crypto.randomUUID(), email: EMAIL, codeHash: 'y', attempts: 0, codeIssuedAt: recent, expiresAt: recent, createdAt: recent },
    ])
    await db.insert(passwordResetTokens).values([
      { id: crypto.randomUUID(), userId, tokenHash: 'c'.repeat(HASH_LENGTH), issuedAt: dead, expiresAt: dead, createdAt: dead },
      { id: crypto.randomUUID(), userId, tokenHash: 'd'.repeat(HASH_LENGTH), issuedAt: recent, expiresAt: recent, createdAt: recent },
    ])

    const outcomes = await runCron(env, SILENT_LOGGER)

    expect(outcomes).toHaveLength(EXPECTED_JOBS)
    expect(outcomes.every((outcome) => outcome.error === undefined)).toBe(true)
    expect(outcomes.map((outcome) => outcome.metrics?.rowsDeleted)).toEqual([
      ROWS_DELETED_PER_JOB,
      ROWS_DELETED_PER_JOB,
      ROWS_DELETED_PER_JOB,
    ])
    expect(cronExitCode(outcomes)).toBe(CRON_EXIT_OK)

    expect(await db.select().from(refreshTokens)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(SURVIVORS_PER_TABLE)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(SURVIVORS_PER_TABLE)
  })
})
```

- [ ] **Step 9: Run it, verify it fails, then passes**

Run: `pnpm test:integration -- cron`
Expected: FAIL first if run before Step 6/7 land — after this task's edits it must PASS. If `crypto.randomUUID` is flagged by lint or unavailable, `import { randomUUID } from 'node:crypto'` and use that.

- [ ] **Step 10: Full check + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries && pnpm build`
Expected: all green. `pnpm build` must emit `dist/main/cron.js`.

Manual smoke (optional, requires the dev database up and `.env`): `node --conditions=development --env-file-if-exists=.env --import tsx src/main/cron.ts` — prints three "cron job done" lines and exits 0.

```bash
git add src/shared/ports/cron-job.ts src/main/run-cron.ts src/main/run-cron.spec.ts src/main/cron.ts src/modules/auth/container.ts tests/integration/cron.spec.ts
git commit -m "feat: add the cron.ts entrypoint and per-module job registry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `docs/STRUCTURE.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1–4.
- Produces: nothing code depends on.

- [ ] **Step 1: Add decision 30 to `docs/DECISIONS.md`**

Add a row to the "Decisões fechadas" table (§2):

```
| 30 | Cron / poda | `cron.ts` one-shot + scheduler externo; registry de jobs por módulo; poda com janela de retenção por tabela |
```

Add the full section after decision 29, following the house format (what was decided, **why**, **descartado** list). Cover, from spec §3: one-shot + external scheduler (rejected: long process with `node-cron`, `pg_cron`); per-module job registry (rejected: single `pruneExpired()` method, `argv` job name); use-case per table (rejected: one use-case for three, thunk in the container); retention window per table (rejected: delete-on-expiry, single global retention); predicate `expires_at <= cutoff` only (rejected: also `revoked_at`/`consumed_at`). Include the "how to schedule in production" note: k8s `CronJob` running `node dist/main/cron.js`, or a `crontab` line; in dev the prune only runs when invoked by hand — `node --conditions=development --env-file-if-exists=.env --import tsx src/main/cron.ts`.

- [ ] **Step 2: Update `docs/STRUCTURE.md`**

In §2's `src/main/` tree, `cron.ts` and `worker.ts` are shown as siblings of `http.ts` — add `run-cron.ts` next to `cron.ts`, and add `shared/ports/cron-job.ts` to the `shared/` listing. Add one line under the tree: `cron.ts` is one-shot (roda e sai), agendado pela plataforma; `worker.ts` segue aspiracional. Note that §4's boundary table is unchanged — the new files fall under globs that already exist (`src/main/**` = composition, `src/shared/**` = pure).

- [ ] **Step 3: Update `docs/TODO.md`**

In the "O resto, em ordem decrescente de urgência" table, strike the "Poda de tokens expirados" row (mark it done with a short note and the spec link, matching how earlier done items are shown). In the closing "O que eu faria a seguir" section, drop the paragraph that calls the prune the most urgent debt; keep OAuth as the next big block and note the transactional outbox is now unblocked — it is one more `CronJob`.

- [ ] **Step 4: Commit**

```bash
git add docs/DECISIONS.md docs/STRUCTURE.md docs/TODO.md
git commit -m "docs(cron): record decision 30 and close the pruning debt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §1 entrypoint `cron.ts` | Task 4 |
| §1 registry de jobs por módulo | Task 4 (`CronJob`, `container.jobs`, `runJobs`) |
| §1 três use-cases de poda | Task 2 |
| §3.1 one-shot + scheduler externo | Task 4 (`cron.ts` shell, `process.exit`), Task 5 (decision + how-to) |
| §3.2 registry por módulo | Task 4 |
| §3.3 use-case puro por tabela | Task 2 |
| §3.4 janela de retenção por tabela, predicado `expires_at <= cutoff` | Task 1 (predicate), Task 2 (cutoff arithmetic), Task 3 (config) |
| §3.5 outbox fora de escopo | not built (correct) |
| §4.1 `CronJob` em `shared/ports/` | Task 4 Step 1 |
| §4.2 os três use-cases + `const` de nome | Task 2 |
| §4.3 método nos três contratos | Task 1 Step 3 |
| §4.4 seis implementações + `NO_ROW_AFFECTED` | Task 1 Steps 4–5 |
| §4.5 `container.ts` monta e expõe `jobs` | Task 4 Step 6 |
| §5.1 `run-cron.ts` (`runJobs`, `cronExitCode`, `runCron`), série, isola falha | Task 4 Steps 2–5 |
| §5.2 `cron.ts` casca, sem erro fatal próprio | Task 4 Step 7 |
| §5.3 fronteira sem exceção nova | Task 1/2/4 boundary checks |
| §6 três env vars + `DEFAULT_*` + `.int().positive()` | Task 3 |
| §7 unit ×3, integração de repo ×3, `cron.spec.ts` + negativo | Task 1 (repo integ), Task 2 (unit), Task 4 (`run-cron.spec.ts` negativo, `cron.spec.ts` e2e) |
| §9 emendas DECISIONS/STRUCTURE/TODO | Task 5 |

The §7 "negativo" (a job that throws) is covered as a `runJobs` unit case in Task 4 Step 2 rather than inside `cron.spec.ts`, because `runCron` reads `container.auth.jobs` and a fake failing job cannot be injected into it — the isolation logic lives in `runJobs`, which takes an explicit list. Noted in spec §5.1.

**2. Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N" — the near-identical use-cases and specs in Task 2 are spelled out in full for the first (refresh) and given as explicit, itemised diffs from it for the other two.

**3. Type consistency:** `deleteExpiredBefore(cutoff: Date): Promise<number>` — identical across Task 1 (contracts, adapters, noop) and Task 2 (use-case call sites). `PruneResult { rowsDeleted: number }` returned by every use-case and consumed as `metrics` in `JobOutcome`. `CronJob.run(): Promise<Record<string, number>>` — `{ rowsDeleted: number }` is assignable. `runCron(env, logger)` signature matches its callers in `cron.ts` and `cron.spec.ts`. `CRON_EXIT_OK` / `CRON_EXIT_JOB_FAILED` names identical in `run-cron.ts`, `run-cron.spec.ts`, `cron.spec.ts`. Job-name constants (`PRUNE_EXPIRED_REFRESH_TOKENS_JOB` etc.) defined in Task 2, imported in Task 4 Step 6.

---

## Execution Handoff

See the skill's handoff prompt below.
