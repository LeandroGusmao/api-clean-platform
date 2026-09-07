# Password Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /auth/password/forgot` and `POST /auth/password/reset` so a user who forgot their password (or whose account was taken) has a way back in.

**Architecture:** A new `password_reset_tokens` table holds one live 256-bit opaque token per account (`unique(user_id)`), digested with sha256 and looked up through `unique(token_hash)` — the same infrastructure the refresh token uses. `forgot` is a single race-free upsert (`INSERT ... ON CONFLICT (user_id) DO UPDATE ... WHERE issued_at <= cooldownCutoff`) followed by a deferred email send, no transaction. `reset` looks the token up, hashes the new password outside any transaction, then in one transaction consumes the token, writes the password hash, and revokes every session — and answers `204` with no auto-login.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify + `fastify-type-provider-zod`, Zod, Drizzle ORM `1.0.0-rc.4` on Postgres, argon2 via `IHashProvider`, Vitest (projects: `unit`, `integration`), Mailpit for the integration mail fixture.

**Spec:** [`docs/superpowers/specs/2026-09-07-password-recovery-design.md`](../specs/2026-09-07-password-recovery-design.md) — read it first; every task argues from a section of it.

## Global Constraints

- **Language:** all code (identifiers, strings, logs, errors) and all comments in **English**. Markdown docs may be Portuguese.
- **No magic strings/numbers:** every literal is a named `UPPER_SNAKE_CASE` constant, declared close to use (or in a module `constants.ts` if shared). Exception: schema declaration files may spell table/column/index **names** inline — but a name **read from another file** (like a unique-index name the repository matches on) becomes an exported constant in the schema file. Every non-name literal in a schema file still follows the rule.
- **Comments** explain the code they sit on — no task/branch/review narrative, no re-arguing what a spec already says, no describing another module's behaviour. Put a short comment on the line it governs.
- **Timestamps** never come from `new Date()` in the pure layer or a schema default: every instant comes from the injected `IClock`. Schema files carry **no** column defaults for timestamps (see `refresh-tokens.ts`, `pending-registrations.ts`).
- **`code` on an `AppError` is public contract** (SCREAMING_SNAKE_CASE, stable). `message` is not.
- **Tests must be falsifiable.** Assert the whole call log with `toEqual`, not `toContain` / ordered `indexOf` pairs. Delete-then-verify: a deleted step must break the test.
- **Model escalation:** if the session model is not Opus and the same error survives 3 fix attempts, or the same file is rewritten twice, or the same command fails 4+ times identically — stop and escalate per `CLAUDE.md`.
- **Run each gate alone and read its exit code.** `pnpm lint`, `pnpm typecheck`, `pnpm build` separately. A single unit file: `pnpm vitest run --project unit <file>`. A single integration file: `pnpm vitest run --project integration <file>` (needs `docker compose up -d`).
- **`node` on PATH may be older than `engines`.** If a gate complains about the Node version: `export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"`.
- **Commit after every task** (frequent commits). Never push, never open a PR — that is the finishing skill's job.

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/modules/auth/infra/drizzle/schema/password-reset-tokens.ts` | The `password_reset_tokens` table + the exported `token_hash` unique-index name constant. |
| `src/modules/auth/entities/password-reset-token.ts` | `PasswordResetToken` entity: `create`, `fromTrusted`, `isUsable`, getters. Immutable, `#` fields. |
| `src/modules/auth/entities/password-reset-token.spec.ts` | Unit test for the entity. |
| `src/modules/auth/errors/password-reset-failed-error.ts` | `PasswordResetFailedError extends BusinessRuleError` → 422, one generic failure. |
| `src/modules/auth/repositories/password-reset-tokens-repository.ts` | `IPasswordResetTokensRepository` interface: `issueOrRefresh`, `findByHash`, `consume`. |
| `src/modules/auth/infra/drizzle/password-reset-token-mapper.ts` | Row → entity (`toDomainPasswordResetToken`). |
| `src/modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository.ts` | Drizzle adapter + `PasswordResetTokenHashCollisionError`. |
| `src/modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository.ts` | In-memory adapter for use-case unit tests. |
| `src/modules/auth/services/password-reset-issuer.ts` | `PasswordResetIssuer`: mints the opaque token, returns digest + deferred send. |
| `src/modules/auth/services/password-reset-issuer.spec.ts` | Unit test for the issuer. |
| `src/modules/auth/use-cases/request-password-reset.ts` | `RequestPasswordResetUseCase` (the `forgot` flow). |
| `src/modules/auth/use-cases/request-password-reset.spec.ts` | Unit test. |
| `src/modules/auth/use-cases/reset-password.ts` | `ResetPasswordUseCase` (the `reset` flow). |
| `src/modules/auth/use-cases/reset-password.spec.ts` | Unit test. |
| `src/modules/auth/infra/http/endpoints/forgot-password.ts` | `POST /password/forgot` route. |
| `src/modules/auth/infra/http/endpoints/reset-password.ts` | `POST /password/reset` route. |
| `tests/integration/password-reset-tokens-schema.spec.ts` | Table shape: columns, NOT NULL, both unique indexes, FK cascade. |
| `tests/integration/drizzle-password-reset-tokens-repository.spec.ts` | Adapter behaviour + concurrency against real Postgres. |
| `tests/integration/forgot-password.spec.ts` | `POST /auth/password/forgot` end to end, against real SMTP. |
| `tests/integration/reset-password.spec.ts` | `POST /auth/password/reset` end to end. |
| `drizzle/<generated>_create_password_reset_tokens/` | The 4th migration (generated, then renamed to the project convention). |

**Modified files:**

| Path | Change |
|---|---|
| `src/modules/auth/notifications/verification-email.ts` → `emails.ts` | `git mv`; add `passwordResetEmail` and `passwordResetCompletedEmail`. |
| `src/modules/auth/use-cases/register-user.ts` | Import path `verification-email` → `emails`. |
| `src/modules/auth/use-cases/change-password.ts` | Import path `verification-email` → `emails`. |
| `src/modules/auth/use-cases/change-password.spec.ts` | Import path `verification-email` → `emails`. |
| `src/modules/auth/repositories/unit-of-work.ts` | `AuthRepos` gains `passwordResetTokens`. |
| `src/modules/auth/infra/drizzle/auth-repositories.ts` | Construct `DrizzlePasswordResetTokensRepository`. |
| `src/modules/auth/config.ts` | Six new constants + `authEnvSchema` entries. |
| `src/modules/auth/config.spec.ts` | Assert the six new defaults. |
| `src/modules/auth/container.ts` | Wire the issuer, both use cases, both rate-limit objects; rename `passwordChangedEmailSender` → `bestEffortEmailSender`. |
| `src/modules/auth/infra/http/routes.ts` | Register the two new routes. |
| `tests/integration/setup/mailpit.ts` | Add `extractResetToken`. |
| `src/modules/auth/README.md` | Endpoints table + "Recuperação de senha" flow section. |
| `docs/TODO.md` | Mark password recovery done. |
| `docs/DECISIONS.md` | Record the four new decisions. |

---

## Task 1: Config constants and env schema

**Files:**
- Modify: `src/modules/auth/config.ts`
- Test: `src/modules/auth/config.spec.ts`

**Interfaces:**
- Produces: six constants — `DEFAULT_PASSWORD_RESET_TTL_SECONDS` (1800), `DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS` (60), `DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS` (10), `DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS` (60), `DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS` (10), `DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS` (60). Six `authEnvSchema` keys of the same names without the `DEFAULT_` prefix: `PASSWORD_RESET_TTL_SECONDS`, `PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS`, `PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS`, `PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS`, `PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS`, `PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS`.

- [ ] **Step 1: Read the existing pattern**

Read `src/modules/auth/config.ts` in full and `src/modules/auth/config.spec.ts` in full. Every new entry mirrors the `EMAIL_VERIFICATION_*` / `REGISTER_RATE_LIMIT_*` entries exactly: a `DEFAULT_` constant with a doc comment, then a `z.coerce.number().int().positive().default(DEFAULT_...)` schema field with the "reject zero is what rejects an empty value" comment.

- [ ] **Step 2: Write the failing test**

Add to `src/modules/auth/config.spec.ts` (match the file's existing style for how defaults are asserted — likely `authEnvSchema.parse({ JWT_SECRET: ... })` then reading the field):

```ts
it('defaults the password recovery knobs', () => {
  const config = authEnvSchema.parse({ JWT_SECRET: VALID_JWT_SECRET })

  expect(config.PASSWORD_RESET_TTL_SECONDS).toBe(1800)
  expect(config.PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS).toBe(60)
  expect(config.PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS).toBe(10)
  expect(config.PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS).toBe(60)
  expect(config.PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS).toBe(10)
  expect(config.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS).toBe(60)
})

it('rejects a zero TTL for the reset token', () => {
  expect(() =>
    authEnvSchema.parse({ JWT_SECRET: VALID_JWT_SECRET, PASSWORD_RESET_TTL_SECONDS: '0' }),
  ).toThrow()
})
```

Use whatever the file already calls its valid-secret fixture; if there is none, add `const VALID_JWT_SECRET = 'x'.repeat(32)`.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/config.spec.ts`
Expected: FAIL — `PASSWORD_RESET_TTL_SECONDS` is `undefined`.

- [ ] **Step 4: Add the constants**

In `src/modules/auth/config.ts`, after the `EMAIL_VERIFY_RESEND_RATE_LIMIT_*` block:

```ts
/**
 * 30 minutes. The token is 256 bits of entropy, so brute force is not the
 * threat the TTL answers — it caps how long a reset link left in an inbox
 * stays live. Longer than the six-digit code's 15 minutes on purpose.
 */
export const DEFAULT_PASSWORD_RESET_TTL_SECONDS = 1800

/**
 * One minute between reset emails for the same account. Without it, `forgot` is
 * a way to fill a stranger's inbox from an anonymous request.
 */
export const DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS = 60

/**
 * `forgot` sends mail to an arbitrary address from an anonymous request — a
 * spam amplifier, like `register`. Its own pair, not a shared one: a field
 * named for one route and used by another is a comment that lies.
 */
export const DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * `reset` carries a token guess. Same shape as `confirm`: it counts requests,
 * not failures, and sits far above human retry and far below anything useful
 * to an attacker.
 */
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS = 60
```

Then add to `authEnvSchema`, each with the standard comment:

```ts
  // `.positive()` for the reason every value here carries it: a value of zero
  // would expire the token before it could be used, and rejecting zero is what
  // rejects an empty value.
  PASSWORD_RESET_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_TTL_SECONDS),
  PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS),
  PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS),
  PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/config.spec.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

Run `pnpm lint`, then `pnpm typecheck`. Both green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts
git commit -m "feat(auth): config knobs for password recovery"
```

---

## Task 2: The `password_reset_tokens` table and migration

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/password-reset-tokens.ts`
- Create: `drizzle/<generated>_create_password_reset_tokens/` (via `pnpm db:generate`)
- Test: `tests/integration/password-reset-tokens-schema.spec.ts`

**Interfaces:**
- Produces: `export const passwordResetTokens` (Drizzle table) with columns `id`, `userId`, `tokenHash`, `issuedAt`, `expiresAt`, `consumedAt`, `createdAt`. `export const PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX = 'password_reset_tokens_token_hash_unique'`.

- [ ] **Step 1: Write the schema file**

`src/modules/auth/infra/drizzle/schema/password-reset-tokens.ts`:

```ts
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One live single-use token proving control of an email address for an account
 * that ALREADY exists. 256 bits of opaque entropy, digested with sha256; the
 * plaintext lives only in the email being sent.
 *
 * NO column defaults, like `refresh-tokens.ts`: Postgres stores `timestamptz`
 * in microseconds and a JS `Date` in milliseconds, and `isUsable` compares
 * instants — so every timestamp comes from `IClock`.
 *
 * `unique(user_id)` — one live token per account. It is the arbiter of the
 * `INSERT ... ON CONFLICT (user_id)` the `forgot` use case runs, so a fresh
 * `forgot` supersedes the previous token in place. `issued_at` moves on every
 * supersede; `created_at` is immutable, for prune order and audit. `consumed_at`
 * marks a redeemed reset.
 */

/**
 * Exported because the repository reads it: a `23505` carrying THIS constraint
 * is not a database error, it is a security alarm — 32 bytes of `randomBytes`
 * do not collide, so what produces it in practice is a token generator that
 * regressed to something predictable. The primary key raises `23505` too, and
 * that one keeps bubbling as an ordinary persistence failure. Same reasoning as
 * `REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX`; once a name is read from another
 * file it stops appearing once and becomes a constant.
 */
export const PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX =
  'password_reset_tokens_token_hash_unique'

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** sha256 of the opaque token. Never the token itself. */
  tokenHash: text('token_hash').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [
  // One live token per account — the ON CONFLICT target of `forgot`. Spelled
  // inline: the name appears exactly once.
  uniqueIndex('password_reset_tokens_user_id_unique').on(table.userId),
  // The `reset` lookup path. Named via the constant above because the
  // repository matches a 23505 against it.
  uniqueIndex(PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX).on(table.tokenHash),
])
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Then rename the generated folder/files to the project convention — inspect `drizzle/` (existing: `20260907134711_create_pending_registrations`) and follow the same `<timestamp>_create_password_reset_tokens` shape. Open the generated `.sql` and confirm it: creates only `password_reset_tokens`, with `user_id` `REFERENCES users(id) ON DELETE CASCADE`, and two `CREATE UNIQUE INDEX` statements (`..._user_id_unique`, `..._token_hash_unique`). No other table touched.

- [ ] **Step 3: Apply it to the test database**

Run: `docker compose up -d` then the project's test-migrate step (see `tests/integration/setup/migrate-test-database.ts` — it may run automatically in `pnpm test:integration` global setup; if there is a script like `pnpm db:migrate:test`, run it, otherwise the integration runner applies it).

- [ ] **Step 4: Write the failing schema test**

`tests/integration/password-reset-tokens-schema.spec.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would keep this suite green through a rename that
// breaks the database.
const TABLE_NAME = 'password_reset_tokens'
const USER_ID_UNIQUE_INDEX = 'password_reset_tokens_user_id_unique'
const TOKEN_HASH_UNIQUE_INDEX = 'password_reset_tokens_token_hash_unique'
const NOT_NULL_VIOLATION = '23502'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

const HASH_LENGTH = 64
const TOKEN_HASH = 'a'.repeat(HASH_LENGTH)
const OTHER_TOKEN_HASH = 'b'.repeat(HASH_LENGTH)
const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'argon2-does-not-matter-here'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const ISSUED_AT = new Date('2026-09-07T00:00:00.000Z')
const EXPIRES_AT = new Date('2026-09-07T00:30:00.000Z')
const CREATED_AT = new Date('2026-09-07T00:00:00.000Z')

const ONE_INDEX = 1

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
  await db.delete(passwordResetTokens)
  await db.delete(users)
  const [created] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })
  userId = created?.id ?? ''
})

const row = (overrides: Partial<typeof passwordResetTokens.$inferInsert> = {}) => ({
  id: ROW_ID,
  userId,
  tokenHash: TOKEN_HASH,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  ...overrides,
})

describe('password_reset_tokens table', () => {
  it('stores a row with all seven columns', async () => {
    await db.insert(passwordResetTokens).values(row())
    const [stored] = await db.select().from(passwordResetTokens)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.userId).toBe(userId)
    expect(stored?.tokenHash).toBe(TOKEN_HASH)
    expect(stored?.issuedAt).toEqual(ISSUED_AT)
    expect(stored?.expiresAt).toEqual(EXPIRES_AT)
    expect(stored?.consumedAt).toBeNull()
    expect(stored?.createdAt).toEqual(CREATED_AT)
  })

  it('rejects an insert without issued_at, proving there is no default', async () => {
    const { issuedAt: _drop, ...withoutIssuedAt } = row()
    await expect(
      db.insert(passwordResetTokens).values(withoutIssuedAt as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('allows only one row per user', async () => {
    await db.insert(passwordResetTokens).values(row())
    await expect(
      db.insert(passwordResetTokens).values(row({ id: OTHER_ROW_ID, tokenHash: OTHER_TOKEN_HASH })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('rejects a token_hash already used by another row', async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'maria@example.com', passwordHash: PASSWORD_HASH })
      .returning({ id: users.id })
    await db.insert(passwordResetTokens).values(row())
    await expect(
      db.insert(passwordResetTokens).values(
        row({ id: OTHER_ROW_ID, userId: otherUser?.id ?? '' }),
      ),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('rejects a row for a user that does not exist', async () => {
    await expect(
      db.insert(passwordResetTokens).values(row({ userId: MISSING_USER_ID })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } })
  })

  it('deletes the token when its user is deleted', async () => {
    await db.insert(passwordResetTokens).values(row())
    await db.delete(users)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(0)
  })

  it('carries both unique indexes', async () => {
    const result = await db.execute(
      sql`select indexname from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
    }>
    expect(rows.filter((r) => r.indexname === USER_ID_UNIQUE_INDEX)).toHaveLength(ONE_INDEX)
    expect(rows.filter((r) => r.indexname === TOKEN_HASH_UNIQUE_INDEX)).toHaveLength(ONE_INDEX)
  })
})
```

- [ ] **Step 5: Run it**

Run: `pnpm vitest run --project integration tests/integration/password-reset-tokens-schema.spec.ts`
Expected: PASS (the schema and migration are already in place from steps 1–3). If a test fails, fix the schema file and regenerate the migration.

- [ ] **Step 6: Gates**

`pnpm lint`, `pnpm typecheck`, `pnpm build`. All green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/drizzle/schema/password-reset-tokens.ts drizzle/ tests/integration/password-reset-tokens-schema.spec.ts
git commit -m "feat(auth): password_reset_tokens table and migration"
```

---

## Task 3: The `PasswordResetToken` entity

**Files:**
- Create: `src/modules/auth/entities/password-reset-token.ts`
- Test: `src/modules/auth/entities/password-reset-token.spec.ts`

**Interfaces:**
- Produces:
  - `interface CreatePasswordResetTokenProps { id: string; userId: string; tokenHash: string; now: Date; ttlSeconds: number }`
  - `interface TrustedPasswordResetTokenProps { id: string; userId: string; tokenHash: string; issuedAt: Date; expiresAt: Date; consumedAt: Date | null; createdAt: Date }`
  - `class PasswordResetToken` with `static create(props: CreatePasswordResetTokenProps): PasswordResetToken`, `static fromTrusted(props: TrustedPasswordResetTokenProps): PasswordResetToken`, `isUsable(now: Date): boolean`, and getters `id`, `userId`, `tokenHash`, `issuedAt`, `expiresAt`, `consumedAt`, `createdAt` (dates returned as copies).

- [ ] **Step 1: Write the failing test**

`src/modules/auth/entities/password-reset-token.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const TOKEN_HASH = 'digest:opaque'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 1800
const MILLISECONDS_PER_SECOND = 1000
const EXPIRES_AT = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)
const ONE_MS = 1

const build = (overrides: Partial<Parameters<typeof PasswordResetToken.fromTrusted>[0]> = {}) =>
  PasswordResetToken.fromTrusted({
    id: ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  })

describe('PasswordResetToken', () => {
  it('is born unconsumed with expiry derived from the clock and the ttl', () => {
    const token = PasswordResetToken.create({
      id: ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    })

    expect(token.consumedAt).toBeNull()
    expect(token.issuedAt).toEqual(NOW)
    expect(token.createdAt).toEqual(NOW)
    expect(token.expiresAt).toEqual(EXPIRES_AT)
  })

  it('is usable strictly before expiry', () => {
    expect(build().isUsable(new Date(EXPIRES_AT.getTime() - ONE_MS))).toBe(true)
  })

  it('is not usable at the expiry instant (an instant that has arrived is spent)', () => {
    expect(build().isUsable(EXPIRES_AT)).toBe(false)
  })

  it('is not usable once consumed, even before expiry', () => {
    expect(build({ consumedAt: NOW }).isUsable(NOW)).toBe(false)
  })

  it('does not leak the digest through JSON.stringify', () => {
    expect(JSON.stringify(build())).toBe('{}')
  })

  it('returns copies of its dates, not the stored instances', () => {
    const token = build()
    token.issuedAt.setFullYear(1999)
    expect(token.issuedAt).toEqual(NOW)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/entities/password-reset-token.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the entity**

`src/modules/auth/entities/password-reset-token.ts` — model it on `entities/pending-registration.ts` (read that file), minus `attempts` and `matches`:

```ts
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreatePasswordResetTokenProps {
  id: string
  userId: string
  /** The digest, never the raw token. See `ITokenDigest`. */
  tokenHash: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted row. See `PendingRegistration.fromTrusted`. */
export interface TrustedPasswordResetTokenProps {
  id: string
  userId: string
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

/**
 * One outstanding reset token for an account that already exists. It carries no
 * password: the new password arrives in the reset request. State lives in `#`
 * private fields, non-enumerable at runtime, so `JSON.stringify(token)` is `{}`
 * and the digest cannot escape through an accidental `reply.send` or a stray
 * log. The plaintext token is NEVER here — it exists only in the email.
 */
export class PasswordResetToken {
  readonly #id: string
  readonly #userId: string
  readonly #tokenHash: string
  readonly #issuedAt: Date
  readonly #expiresAt: Date
  readonly #consumedAt: Date | null
  readonly #createdAt: Date

  private constructor(props: TrustedPasswordResetTokenProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#tokenHash = props.tokenHash
    this.#issuedAt = cloneDate(props.issuedAt)
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#consumedAt = cloneNullableDate(props.consumedAt)
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born unconsumed. `expiresAt` comes from the injected clock plus the ttl,
   * not a column default: `isUsable` compares instants and both sides must
   * share a source.
   */
  static create(props: CreatePasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken({
      id: props.id,
      userId: props.userId,
      tokenHash: props.tokenHash,
      issuedAt: props.now,
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      consumedAt: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedPasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props)
  }

  /**
   * Usable = not consumed and not expired. Inclusive at the expiry boundary,
   * like `PendingRegistration.isUsable`: an instant that has arrived is spent.
   */
  isUsable(now: Date): boolean {
    return this.#consumedAt === null && this.#expiresAt.getTime() > now.getTime()
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get tokenHash(): string {
    return this.#tokenHash
  }

  get issuedAt(): Date {
    return cloneDate(this.#issuedAt)
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/entities/password-reset-token.spec.ts`
Expected: PASS.

- [ ] **Step 5: Gates**

`pnpm lint`, `pnpm typecheck`. Green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/entities/password-reset-token.ts src/modules/auth/entities/password-reset-token.spec.ts
git commit -m "feat(auth): PasswordResetToken entity"
```

---

## Task 4: Repository contract, mapper, Drizzle adapter

**Files:**
- Create: `src/modules/auth/repositories/password-reset-tokens-repository.ts`
- Create: `src/modules/auth/infra/drizzle/password-reset-token-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository.ts`
- Test: `tests/integration/drizzle-password-reset-tokens-repository.spec.ts`

**Interfaces:**
- Consumes: `PasswordResetToken` (Task 3), `passwordResetTokens` + `PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX` (Task 2).
- Produces:
  ```ts
  interface IssueOrRefreshParams {
    id: string
    userId: string
    tokenHash: string
    issuedAt: Date
    expiresAt: Date
    cooldownCutoff: Date
  }
  interface IPasswordResetTokensRepository {
    issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean>
    findByHash(tokenHash: string): Promise<PasswordResetToken | null>
    consume(id: string, at: Date): Promise<boolean>
  }
  ```
  `class DrizzlePasswordResetTokensRepository` implementing it. `class PasswordResetTokenHashCollisionError extends Error` (NOT an `AppError`).
  `toDomainPasswordResetToken(row): PasswordResetToken`.

- [ ] **Step 1: Write the interface**

`src/modules/auth/repositories/password-reset-tokens-repository.ts`:

```ts
import type { PasswordResetToken } from '#modules/auth/entities/password-reset-token'

export interface IssueOrRefreshParams {
  /** Used only on the INSERT path — the first `forgot` for this account. */
  id: string
  userId: string
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  /** `issued_at` must be at or before this for a refresh to fire. */
  cooldownCutoff: Date
}

export interface IPasswordResetTokensRepository {
  /**
   * One statement: insert the account's first reset token, or refresh the
   * existing row in place — but only when its `issued_at` is at or before
   * `cooldownCutoff`. `INSERT ... ON CONFLICT (user_id) DO UPDATE SET
   * token_hash = ?, issued_at = ?, expires_at = ?, consumed_at = NULL WHERE
   * password_reset_tokens.issued_at <= ?`.
   *
   * Returns whether a row was written: `false` means the caller is inside the
   * cooldown and sends nothing. The cooldown is in the `DO UPDATE` `WHERE`, not
   * a prior read, so two concurrent `forgot` for one account cannot both mint —
   * Postgres serializes the upsert on the `user_id` unique index.
   */
  issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean>

  /**
   * The `reset` lookup, by the `token_hash` unique index. Returns `null` for a
   * digest that matches no row. Does NOT filter expiry or `consumed_at`:
   * usability is the entity's judgement against the injected clock.
   */
  findByHash(tokenHash: string): Promise<PasswordResetToken | null>

  /**
   * Burns the token: `UPDATE ... SET consumed_at = ? WHERE id = ? AND
   * consumed_at IS NULL`. Returns whether THIS call is the one that burned it —
   * of two concurrent resets redeeming the same token, one loses the
   * conditional update and the caller turns that into the same generic failure.
   */
  consume(id: string, at: Date): Promise<boolean>
}
```

- [ ] **Step 2: Write the mapper**

`src/modules/auth/infra/drizzle/password-reset-token-mapper.ts`:

```ts
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type { passwordResetTokens } from './schema/password-reset-tokens.js'

type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect

/**
 * Row to entity. Rehydrates rather than validates — see
 * `PasswordResetToken.fromTrusted`. There is no entity-to-row direction:
 * `issueOrRefresh` writes columns directly because the ON CONFLICT path has no
 * entity to map.
 */
export const toDomainPasswordResetToken = (
  row: PasswordResetTokenRow,
): PasswordResetToken =>
  PasswordResetToken.fromTrusted({
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  })
```

- [ ] **Step 3: Write the failing integration test**

`tests/integration/drizzle-password-reset-tokens-repository.spec.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { DrizzlePasswordResetTokensRepository } from '#modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = 'argon2-irrelevant'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const TTL_SECONDS = 1800
const MILLISECONDS_PER_SECOND = 1000
const EXPIRES_AT = new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND)
const COOLDOWN_MS = 60_000

const ID_FIRST = '11111111-1111-4111-8111-111111111111'
const ID_SECOND = '22222222-2222-4222-8222-222222222222'
const DIGEST_A = 'digest:aaa'
const DIGEST_B = 'digest:bbb'

const CONCURRENT = 8
const ONE_WINNER = 1

let db: Database
let pool: Pool
let repo: DrizzlePasswordResetTokensRepository
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzlePasswordResetTokensRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(passwordResetTokens)
  await db.delete(users)
  const [created] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id })
  userId = created?.id ?? ''
})

const params = (overrides: Partial<Parameters<typeof repo.issueOrRefresh>[0]> = {}) => ({
  id: ID_FIRST,
  userId,
  tokenHash: DIGEST_A,
  issuedAt: NOW,
  expiresAt: EXPIRES_AT,
  cooldownCutoff: new Date(NOW.getTime() - COOLDOWN_MS),
  ...overrides,
})

describe('DrizzlePasswordResetTokensRepository', () => {
  it('inserts the first token and returns true', async () => {
    expect(await repo.issueOrRefresh(params())).toBe(true)

    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.tokenHash).toBe(DIGEST_A)
    expect(row?.consumedAt).toBeNull()
  })

  it('refreshes an existing row in place once the cooldown has elapsed', async () => {
    await repo.issueOrRefresh(params())

    // The prior issue is two minutes old — older than the one-minute cutoff.
    const later = new Date(NOW.getTime() + 2 * COOLDOWN_MS)
    const wrote = await repo.issueOrRefresh(
      params({
        id: ID_SECOND,
        tokenHash: DIGEST_B,
        issuedAt: later,
        expiresAt: new Date(later.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
        cooldownCutoff: new Date(later.getTime() - COOLDOWN_MS),
      }),
    )

    expect(wrote).toBe(true)
    const rows = await db.select().from(passwordResetTokens)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(ID_FIRST) // same row, updated in place
    expect(rows[0]?.tokenHash).toBe(DIGEST_B)
    expect(rows[0]?.issuedAt).toEqual(later)
    expect(rows[0]?.consumedAt).toBeNull()
  })

  it('does not write and returns false inside the cooldown', async () => {
    await repo.issueOrRefresh(params())

    const wrote = await repo.issueOrRefresh(
      params({ id: ID_SECOND, tokenHash: DIGEST_B }), // same NOW, cutoff is NOW - 60s
    )

    expect(wrote).toBe(false)
    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.tokenHash).toBe(DIGEST_A) // untouched
  })

  it('un-consumes on a refresh, so a fresh forgot revives the flow', async () => {
    await repo.issueOrRefresh(params())
    await repo.consume(ID_FIRST, NOW)

    const later = new Date(NOW.getTime() + 2 * COOLDOWN_MS)
    await repo.issueOrRefresh(
      params({
        tokenHash: DIGEST_B,
        issuedAt: later,
        expiresAt: new Date(later.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
        cooldownCutoff: new Date(later.getTime() - COOLDOWN_MS),
      }),
    )

    const [row] = await db.select().from(passwordResetTokens)
    expect(row?.consumedAt).toBeNull()
  })

  it('lets exactly one of many concurrent first-time issues win', async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_unused, index) =>
        repo.issueOrRefresh(params({ id: `${index}0000000-0000-4000-8000-000000000000` })),
      ),
    )

    expect(results.filter(Boolean)).toHaveLength(CONCURRENT) // every call either inserts or refreshes
    expect(await db.select().from(passwordResetTokens)).toHaveLength(1)
  })

  it('findByHash matches by digest and returns null for an absent one', async () => {
    await repo.issueOrRefresh(params())

    expect((await repo.findByHash(DIGEST_A))?.userId).toBe(userId)
    expect(await repo.findByHash(DIGEST_B)).toBeNull()
  })

  it('lets exactly one of two concurrent consumes win', async () => {
    await repo.issueOrRefresh(params())

    const outcomes = await Promise.all([
      repo.consume(ID_FIRST, NOW),
      repo.consume(ID_FIRST, NOW),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(ONE_WINNER)
  })
})
```

> Note on the concurrency test: with `ON CONFLICT ... WHERE`, a losing racer whose `WHERE` fails returns `false`. On a fresh table all racers with the SAME `cooldownCutoff = NOW - 60s` and an existing row issued at `NOW` would see `issued_at (NOW) <= NOW - 60s` == false, so only the very first (the INSERT) returns `true`. If the assertion `results.filter(Boolean)).toHaveLength(CONCURRENT)` fails, change it to `toHaveLength(1)` — the point the test pins is **one row**, not how many calls reported a write. Decide which invariant you want and make the assertion exact.

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run --project integration tests/integration/drizzle-password-reset-tokens-repository.spec.ts`
Expected: FAIL — `DrizzlePasswordResetTokensRepository` not found.

- [ ] **Step 5: Implement the adapter**

`src/modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository.ts` — read `drizzle-refresh-tokens-repository.ts` and `drizzle-pending-registrations-repository.ts` first; mirror their `toPersistenceError` / collision-detection shape.

```ts
import { and, eq, isNull, lte } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { findDriverError, toPersistenceError } from '#infra/database/driver-error'
import type { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type {
  IPasswordResetTokensRepository,
  IssueOrRefreshParams,
} from '#modules/auth/repositories/password-reset-tokens-repository'
import { toDomainPasswordResetToken } from './password-reset-token-mapper.js'
import {
  PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX,
  passwordResetTokens,
} from './schema/password-reset-tokens.js'

/** How many rows a conditional write affected when nothing matched its WHERE. */
const NO_ROW_AFFECTED = 0
/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505'

const HASH_COLLISION_ERROR_NAME = 'PasswordResetTokenHashCollisionError'
const HASH_COLLISION_MESSAGE =
  'two password reset tokens produced the same sha256 digest: the opaque token ' +
  'generator has almost certainly regressed, and issued tokens may be predictable'

/**
 * Deliberately NOT an `AppError`, like `RefreshTokenHashCollisionError`: this is
 * a defect, not one of the semantic categories. It falls through to the error
 * handler's generic branch and answers 500, and carries no `code` because there
 * is nothing a client could do with it. What it adds over the `PersistenceError`
 * this would otherwise be is the DIAGNOSIS.
 */
export class PasswordResetTokenHashCollisionError extends Error {
  constructor() {
    super(HASH_COLLISION_MESSAGE)
    this.name = HASH_COLLISION_ERROR_NAME
  }
}

function isTokenHashCollision(error: unknown): boolean {
  const driverError = findDriverError(error)
  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX
  )
}

export class DrizzlePasswordResetTokensRepository
  implements IPasswordResetTokensRepository
{
  constructor(private readonly db: Database) {}

  async issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean> {
    try {
      const result = await this.db
        .insert(passwordResetTokens)
        .values({
          id: params.id,
          userId: params.userId,
          tokenHash: params.tokenHash,
          issuedAt: params.issuedAt,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: params.issuedAt,
        })
        .onConflictDoUpdate({
          target: passwordResetTokens.userId,
          set: {
            tokenHash: params.tokenHash,
            issuedAt: params.issuedAt,
            expiresAt: params.expiresAt,
            consumedAt: null,
          },
          // Only refresh when the previous issue is older than the cooldown.
          setWhere: lte(passwordResetTokens.issuedAt, params.cooldownCutoff),
        })

      return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
    } catch (error) {
      // 32 bytes of randomBytes do not collide in practice; if this fires the
      // generator has regressed. Named before the generic branch.
      if (isTokenHashCollision(error)) throw new PasswordResetTokenHashCollisionError()

      // Never re-throw what the driver gave us: Drizzle glues every bound
      // parameter into its message, and this insert binds the digest.
      throw toPersistenceError(error)
    }
  }

  async findByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const [row] = await this.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))

    return row === undefined ? null : toDomainPasswordResetToken(row)
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: at })
      .where(
        and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.consumedAt)),
      )

    // Its TS type is `number | null`; treat `null` as "matched nothing" so
    // single use fails CLOSED.
    return (result.rowCount ?? NO_ROW_AFFECTED) !== NO_ROW_AFFECTED
  }
}
```

- [ ] **Step 6: Verify the `onConflictDoUpdate` key name against the installed Drizzle**

Run: `pnpm typecheck`.
If it errors on `setWhere`, open `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts` and search for `onConflictDoUpdate` — find whether the update condition key is `setWhere`, `where`, or split into `targetWhere` / `setWhere`. Adjust the call. The condition must land on the `DO UPDATE ... WHERE` (the SET clause), NOT on the conflict target. If the typed API cannot express it, fall back to `sql`:
```ts
import { sql } from 'drizzle-orm'
// ...
.onConflictDoUpdate({
  target: passwordResetTokens.userId,
  set: { tokenHash: params.tokenHash, issuedAt: params.issuedAt, expiresAt: params.expiresAt, consumedAt: null },
  setWhere: sql`${passwordResetTokens.issuedAt} <= ${params.cooldownCutoff}`,
})
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm vitest run --project integration tests/integration/drizzle-password-reset-tokens-repository.spec.ts`
Expected: PASS. Fix the adapter (or the concurrency assertion per the note in Step 3) until green.

- [ ] **Step 8: Gates**

`pnpm lint`, `pnpm typecheck`, `pnpm build`. Green.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/repositories/password-reset-tokens-repository.ts src/modules/auth/infra/drizzle/password-reset-token-mapper.ts src/modules/auth/infra/drizzle/drizzle-password-reset-tokens-repository.ts tests/integration/drizzle-password-reset-tokens-repository.spec.ts
git commit -m "feat(auth): password reset tokens repository"
```

---

## Task 5: Rename the email module and add the two templates

**Files:**
- Rename: `src/modules/auth/notifications/verification-email.ts` → `src/modules/auth/notifications/emails.ts`
- Modify: `src/modules/auth/use-cases/register-user.ts`, `src/modules/auth/use-cases/change-password.ts`, `src/modules/auth/use-cases/change-password.spec.ts` (import paths)
- Modify: `src/modules/auth/notifications/emails.ts` (add two functions)

**Interfaces:**
- Produces: `passwordResetEmail(to: Email, token: string, ttlSeconds: number): EmailMessage`, `passwordResetCompletedEmail(to: Email): EmailMessage`, both exported from `#modules/auth/notifications/emails`.

- [ ] **Step 1: Rename and fix imports**

```bash
git mv src/modules/auth/notifications/verification-email.ts src/modules/auth/notifications/emails.ts
```

Then grep and update every importer:

```bash
grep -rn "notifications/verification-email" src/ tests/
```

Change each `#modules/auth/notifications/verification-email` to `#modules/auth/notifications/emails`. Known importers: `src/modules/auth/use-cases/register-user.ts`, `src/modules/auth/use-cases/change-password.ts`, `src/modules/auth/use-cases/change-password.spec.ts`. Update the file's own top-of-file comment if it names "verification".

- [ ] **Step 2: Run the full unit suite to confirm the rename is clean**

Run: `pnpm vitest run --project unit`
Expected: PASS (same count as before). Then `pnpm typecheck` — green.

- [ ] **Step 3: Commit the rename on its own**

```bash
git add -A
git commit -m "refactor(auth): notifications/verification-email.ts -> emails.ts"
```

- [ ] **Step 4: Write the failing test for the templates**

Create `src/modules/auth/notifications/emails.spec.ts` (there is no existing spec for this file; add one):

```ts
import { describe, expect, it } from 'vitest'
import {
  passwordResetCompletedEmail,
  passwordResetEmail,
} from '#modules/auth/notifications/emails'
import { Email } from '#modules/auth/value-objects/email'

const TO = Email.fromTrusted('joao@example.com')
const TOKEN = 'a-256-bit-opaque-token-value-base64url-xyz'
const TTL_SECONDS = 1800
const TTL_MINUTES = 30

describe('passwordResetEmail', () => {
  it('addresses the owner and carries the raw token and the ttl in minutes', () => {
    const message = passwordResetEmail(TO, TOKEN, TTL_SECONDS)

    expect(message.to).toBe(TO.value)
    expect(message.text).toContain(TOKEN)
    expect(message.text).toContain(String(TTL_MINUTES))
  })
})

describe('passwordResetCompletedEmail', () => {
  it('tells the owner every session was signed out and how to react', () => {
    const message = passwordResetCompletedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('reset')
    expect(message.text.toLowerCase()).toContain('sign')
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 6: Add the templates**

In `src/modules/auth/notifications/emails.ts`, alongside the existing subjects and functions:

```ts
const PASSWORD_RESET_SUBJECT = 'Reset your password'
const PASSWORD_RESET_COMPLETED_SUBJECT = 'Your password was reset'

/**
 * Sent for `POST /auth/password/forgot` when the address has an account. It
 * carries the reset token; the response itself is a bare 202, so this mail is
 * the channel that diverges, and it reaches only whoever owns the address.
 */
export function passwordResetEmail(
  to: Email,
  token: string,
  ttlSeconds: number,
): EmailMessage {
  const minutes = Math.round(ttlSeconds / SECONDS_PER_MINUTE)

  return {
    to: to.value,
    subject: PASSWORD_RESET_SUBJECT,
    text:
      `Use this token to reset your password: ${token}\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n\n` +
      'If you did not ask to reset your password, ignore this message — ' +
      'nothing has changed.',
  }
}

/**
 * Sent after a successful reset. Every session was revoked; if the owner did
 * not do this, running the recovery flow again locks out whoever did.
 */
export function passwordResetCompletedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: PASSWORD_RESET_COMPLETED_SUBJECT,
    text:
      'Your password was just reset through the account recovery flow, and ' +
      'every session was signed out.\n\n' +
      'If this was not you, reset your password again immediately to sign out ' +
      'whoever did.',
  }
}
```

`SECONDS_PER_MINUTE` already exists in the file. `Email` and `EmailMessage` are already imported.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: PASS.

- [ ] **Step 8: Gates**

`pnpm lint`, `pnpm typecheck`. Green.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/notifications/emails.ts src/modules/auth/notifications/emails.spec.ts
git commit -m "feat(auth): password reset email templates"
```

---

## Task 6: The error and the issuer

**Files:**
- Create: `src/modules/auth/errors/password-reset-failed-error.ts`
- Create: `src/modules/auth/services/password-reset-issuer.ts`
- Test: `src/modules/auth/services/password-reset-issuer.spec.ts`

**Interfaces:**
- Consumes: `passwordResetEmail` (Task 5), `ITokenGenerator`, `ITokenDigest`, `IEmailSender` (shared ports), `Email` value object.
- Produces:
  - `class PasswordResetFailedError extends BusinessRuleError` with `code = 'PASSWORD_RESET_FAILED'`, message `'Password reset failed'`.
  - `type DeliverPasswordReset = () => Promise<void>`
  - `class PasswordResetIssuer` with `constructor(emailSender, tokenGenerator, tokenDigest, ttlSeconds)` and `issue(email: Email): { tokenHash: string; deliver: DeliverPasswordReset }`.

- [ ] **Step 1: Write the error**

`src/modules/auth/errors/password-reset-failed-error.ts` — model on `errors/email-verification-failed-error.ts`:

```ts
import { BusinessRuleError } from '#shared/errors/app-error'

const PASSWORD_RESET_FAILED_CODE = 'PASSWORD_RESET_FAILED'
const PASSWORD_RESET_FAILED_MESSAGE = 'Password reset failed'

/**
 * Every failure mode of a reset: unknown token, expired, already consumed, and
 * losing the race to a concurrent reset. ONE error for all of them, for the
 * reason `email-verification-failed-error.ts` documents — separate branches
 * drift apart at the first maintenance and the oracle comes back.
 *
 * `BusinessRuleError` -> 422: the body is well formed, a rule failed.
 */
export class PasswordResetFailedError extends BusinessRuleError {
  readonly code = PASSWORD_RESET_FAILED_CODE

  constructor() {
    super(PASSWORD_RESET_FAILED_MESSAGE)
  }
}
```

- [ ] **Step 2: Write the failing issuer test**

`src/modules/auth/services/password-reset-issuer.spec.ts` — model on `services/email-verification-issuer.spec.ts` (read it):

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { PasswordResetIssuer } from '#modules/auth/services/password-reset-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const EMAIL = Email.fromTrusted('joao@example.com')
const OPAQUE_TOKEN = 'opaque-256-bit-token'
const DIGEST_PREFIX = 'digest:'
const TTL_SECONDS = 1800
const PASSWORD_RESET_SUBJECT = 'Reset your password'

let sent: EmailMessage[]
let emailSender: IEmailSender
let issuer: PasswordResetIssuer

beforeEach(() => {
  sent = []
  emailSender = {
    send: async (message) => {
      sent.push(message)
    },
  }
  issuer = new PasswordResetIssuer(
    emailSender,
    { opaque: () => OPAQUE_TOKEN, numericCode: () => '000000' },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    TTL_SECONDS,
  )
})

describe('PasswordResetIssuer', () => {
  it('returns the digest of a freshly minted opaque token and defers the send', () => {
    const { tokenHash, deliver } = issuer.issue(EMAIL)

    expect(tokenHash).toBe(`${DIGEST_PREFIX}${OPAQUE_TOKEN}`)
    // Nothing sent yet — the caller persists first, then awaits deliver().
    expect(sent).toHaveLength(0)
    expect(typeof deliver).toBe('function')
  })

  it('sends the reset email with the RAW token when deliver() is awaited', async () => {
    const { deliver } = issuer.issue(EMAIL)

    await deliver()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL.value)
    expect(sent[0]?.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(sent[0]?.text).toContain(OPAQUE_TOKEN)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/services/password-reset-issuer.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the issuer**

`src/modules/auth/services/password-reset-issuer.ts`:

```ts
import { passwordResetEmail } from '#modules/auth/notifications/emails'
import type { Email } from '#modules/auth/value-objects/email'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** The send, deferred. Calling it is what puts an email on the wire. */
export type DeliverPasswordReset = () => Promise<void>

/**
 * Mints a 256-bit opaque reset token and returns its digest plus the deferred
 * send. Nothing here persists or sends: the `forgot` use case writes the digest
 * onto a `password_reset_tokens` row and awaits `deliver()` after the write
 * (§8 of the unit of work design — the `register` variant, no transaction).
 */
export class PasswordResetIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly ttlSeconds: number,
  ) {}

  issue(email: Email): { tokenHash: string; deliver: DeliverPasswordReset } {
    const token = this.tokenGenerator.opaque()

    return {
      tokenHash: this.tokenDigest.hash(token),
      deliver: () =>
        this.emailSender.send(passwordResetEmail(email, token, this.ttlSeconds)),
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/services/password-reset-issuer.spec.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

`pnpm lint`, `pnpm typecheck`. Green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/errors/password-reset-failed-error.ts src/modules/auth/services/password-reset-issuer.ts src/modules/auth/services/password-reset-issuer.spec.ts
git commit -m "feat(auth): PasswordResetFailedError and PasswordResetIssuer"
```

---

## Task 7: `RequestPasswordResetUseCase` (the `forgot` flow) + in-memory adapter

**Files:**
- Create: `src/modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository.ts`
- Create: `src/modules/auth/use-cases/request-password-reset.ts`
- Test: `src/modules/auth/use-cases/request-password-reset.spec.ts`

**Interfaces:**
- Consumes: `IPasswordResetTokensRepository` (Task 4), `PasswordResetToken` (Task 3), `PasswordResetIssuer` (Task 6), `IUsersRepository`, `IClock`, `IIdGenerator`, `Email`.
- Produces:
  - `class InMemoryPasswordResetTokensRepository implements IPasswordResetTokensRepository` with a public `readonly rows: PasswordResetToken[]`.
  - `interface RequestPasswordResetCommand { email: string }`
  - `class RequestPasswordResetUseCase` with `constructor(usersRepository: Pick<IUsersRepository, 'findByEmail'>, passwordResetTokens: Pick<IPasswordResetTokensRepository, 'issueOrRefresh'>, issuer: PasswordResetIssuer, clock: IClock, idGenerator: IIdGenerator, resendCooldownMs: number, ttlSeconds: number)` and `execute(command: RequestPasswordResetCommand): Promise<void>`.

- [ ] **Step 1: Write the in-memory adapter**

`src/modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository.ts` — model on `in-memory-pending-registrations-repository.ts`:

```ts
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import type {
  IPasswordResetTokensRepository,
  IssueOrRefreshParams,
} from '#modules/auth/repositories/password-reset-tokens-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * NO row lock and NO conditional-update race: a unit test runs one call at a
 * time. Atomicity is proved against real Postgres in
 * `tests/integration/drizzle-password-reset-tokens-repository.spec.ts`.
 */
export class InMemoryPasswordResetTokensRepository
  implements IPasswordResetTokensRepository
{
  readonly rows: PasswordResetToken[] = []

  async issueOrRefresh(params: IssueOrRefreshParams): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.userId === params.userId)

    if (index === -1) {
      this.rows.push(
        PasswordResetToken.fromTrusted({
          id: params.id,
          userId: params.userId,
          tokenHash: params.tokenHash,
          issuedAt: params.issuedAt,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: params.issuedAt,
        }),
      )
      return true
    }

    const existing = this.rows[index]
    if (existing === undefined) return false
    // Mirrors the adapter's `WHERE issued_at <= cooldownCutoff`.
    if (existing.issuedAt.getTime() > params.cooldownCutoff.getTime()) return false

    this.rows[index] = PasswordResetToken.fromTrusted({
      id: existing.id,
      userId: existing.userId,
      tokenHash: params.tokenHash,
      issuedAt: params.issuedAt,
      expiresAt: params.expiresAt,
      consumedAt: null,
      createdAt: existing.createdAt,
    })
    return true
  }

  async findByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) => row.id === id && row.consumedAt === null,
    )
    if (index === -1) return false

    const row = this.rows[index]
    if (row === undefined) return false

    this.rows[index] = PasswordResetToken.fromTrusted({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      consumedAt: at,
      createdAt: row.createdAt,
    })
    return true
  }
}
```

- [ ] **Step 2: Write the failing use-case test**

`src/modules/auth/use-cases/request-password-reset.spec.ts` — model on `use-cases/register-user.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidEmailError } from '#modules/auth/errors/invalid-email-error'
import { InMemoryPasswordResetTokensRepository } from '#modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import { PasswordResetIssuer } from '#modules/auth/services/password-reset-issuer'
import { RequestPasswordResetUseCase } from '#modules/auth/use-cases/request-password-reset'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

const USER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const GENERATED_ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const EMAIL = 'joao@example.com'
const MIXED_CASE_EMAIL = '  JOAO@Example.COM  '
const INVALID_EMAIL = 'not-an-email'
const UNKNOWN_EMAIL = 'nobody@example.com'
const PASSWORD_HASH = 'hashed:whatever'
const OPAQUE_TOKEN = 'opaque-256-bit-token'
const DIGEST_PREFIX = 'digest:'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const TTL_SECONDS = 1800
const RESEND_COOLDOWN_MS = 60_000
const PASSWORD_RESET_SUBJECT = 'Reset your password'

const ISSUE_OR_REFRESH = 'issueOrRefresh'
const EMAIL_SEND = 'email.send'

const clock: IClock = { now: () => NOW }
const idGenerator: IIdGenerator = { generate: () => GENERATED_ID }

let callLog: string[]
let sent: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let resetRepo: InMemoryPasswordResetTokensRepository
let emailSender: IEmailSender
let issuer: PasswordResetIssuer
let useCase: RequestPasswordResetUseCase

function trackedRepo(): Pick<IPasswordResetTokensRepository, 'issueOrRefresh'> {
  return {
    issueOrRefresh: (params) => {
      callLog.push(ISSUE_OR_REFRESH)
      return resetRepo.issueOrRefresh(params)
    },
  }
}

function storeUser(): void {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: PASSWORD_HASH,
      emailVerifiedAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

beforeEach(() => {
  callLog = []
  sent = []
  usersRepository = new InMemoryUsersRepository()
  resetRepo = new InMemoryPasswordResetTokensRepository()
  emailSender = {
    send: async (message) => {
      callLog.push(EMAIL_SEND)
      sent.push(message)
    },
  }
  issuer = new PasswordResetIssuer(
    emailSender,
    { opaque: () => OPAQUE_TOKEN, numericCode: () => '000000' },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    TTL_SECONDS,
  )
  useCase = new RequestPasswordResetUseCase(
    usersRepository,
    trackedRepo(),
    issuer,
    clock,
    idGenerator,
    RESEND_COOLDOWN_MS,
    TTL_SECONDS,
  )
})

describe('RequestPasswordResetUseCase', () => {
  it('writes a token then sends the email, for an address with an account', async () => {
    storeUser()

    await useCase.execute({ email: EMAIL })

    // Whole log: kills a deleted send, a send before the write, and a spurious extra call.
    expect(callLog).toEqual([ISSUE_OR_REFRESH, EMAIL_SEND])
    expect(resetRepo.rows).toHaveLength(1)
    expect(resetRepo.rows[0]?.userId).toBe(USER_ID)
    expect(resetRepo.rows[0]?.tokenHash).toBe(`${DIGEST_PREFIX}${OPAQUE_TOKEN}`)
    expect(sent[0]?.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(sent[0]?.text).toContain(OPAQUE_TOKEN)
  })

  it('takes the id from the generator and the timestamps from the clock', async () => {
    storeUser()

    await useCase.execute({ email: EMAIL })

    expect(resetRepo.rows[0]?.id).toBe(GENERATED_ID)
    expect(resetRepo.rows[0]?.issuedAt).toEqual(NOW)
    expect(resetRepo.rows[0]?.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * 1000),
    )
  })

  it('does nothing at all for an address with no account', async () => {
    await useCase.execute({ email: UNKNOWN_EMAIL })

    expect(callLog).toEqual([])
    expect(resetRepo.rows).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('sends nothing when issueOrRefresh reports the cooldown is still active', async () => {
    storeUser()
    // Pre-seed a fresh row so the in-memory adapter's cooldown branch refuses.
    await resetRepo.issueOrRefresh({
      id: GENERATED_ID,
      userId: USER_ID,
      tokenHash: `${DIGEST_PREFIX}earlier`,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
      cooldownCutoff: new Date(NOW.getTime() - RESEND_COOLDOWN_MS),
    })
    callLog.length = 0

    await useCase.execute({ email: EMAIL })

    expect(callLog).toEqual([ISSUE_OR_REFRESH]) // attempted, refused, no send
    expect(sent).toHaveLength(0)
    expect(resetRepo.rows[0]?.tokenHash).toBe(`${DIGEST_PREFIX}earlier`)
  })

  it('normalizes the email and uses the STORED address for the send', async () => {
    storeUser()

    await useCase.execute({ email: MIXED_CASE_EMAIL })

    expect(sent[0]?.to).toBe(EMAIL)
  })

  it('resolves with nothing, the same way, whether or not the address has an account', async () => {
    storeUser()
    const withAccount = await useCase.execute({ email: EMAIL })
    const withoutAccount = await useCase.execute({ email: UNKNOWN_EMAIL })

    expect(withAccount).toBe(withoutAccount)
    expect(withAccount).toBeUndefined()
  })

  it('rejects an invalid email before any lookup', async () => {
    await expect(useCase.execute({ email: INVALID_EMAIL })).rejects.toBeInstanceOf(
      InvalidEmailError,
    )
    expect(callLog).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('passes issueOrRefresh a cooldownCutoff of now minus the cooldown', async () => {
    storeUser()
    let seenCutoff: Date | undefined
    const spyRepo: Pick<IPasswordResetTokensRepository, 'issueOrRefresh'> = {
      issueOrRefresh: (params) => {
        seenCutoff = params.cooldownCutoff
        return resetRepo.issueOrRefresh(params)
      },
    }
    const spied = new RequestPasswordResetUseCase(
      usersRepository,
      spyRepo,
      issuer,
      clock,
      idGenerator,
      RESEND_COOLDOWN_MS,
      TTL_SECONDS,
    )

    await spied.execute({ email: EMAIL })

    expect(seenCutoff).toEqual(new Date(NOW.getTime() - RESEND_COOLDOWN_MS))
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/request-password-reset.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the use case**

`src/modules/auth/use-cases/request-password-reset.ts` — model on `use-cases/register-user.ts`:

```ts
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type {
  DeliverPasswordReset,
  PasswordResetIssuer,
} from '#modules/auth/services/password-reset-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. The value object validates it. */
export interface RequestPasswordResetCommand {
  email: string
}

const MILLISECONDS_PER_SECOND = 1000

/**
 * Nothing truthful to send. A no-op rather than an absent value, so every
 * branch ends in the same `await deliver()` and none can start to differ.
 */
const NO_DELIVERY: DeliverPasswordReset = async () => {}

/**
 * Starts password recovery for an address. Writes (or refreshes in place) the
 * account's single reset token and emails it. Never opens a transaction — a
 * single upsert, like `register`.
 *
 * It answers the same way whether the address has an account, is inside the
 * resend cooldown, or has no account at all: what differs is the email, and
 * only its owner can read it. The order is normative — value object first so a
 * bad payload never reaches a repository; the send after the write (§8).
 */
export class RequestPasswordResetUseCase {
  constructor(
    /** `Pick`, and the narrowing IS the rule (§9): this path only reads. */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly passwordResetTokens: Pick<
      IPasswordResetTokensRepository,
      'issueOrRefresh'
    >,
    private readonly issuer: PasswordResetIssuer,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
    private readonly ttlSeconds: number,
  ) {}

  async execute(command: RequestPasswordResetCommand): Promise<void> {
    const email = Email.create(command.email)

    // Read ONCE — the same instant stamps issued_at and expires_at.
    const now = this.clock.now()

    const deliver = await this.#planDelivery(email, now)

    // One call for every branch — the control flow is what makes the responses
    // indistinguishable.
    await deliver()
  }

  async #planDelivery(email: Email, now: Date): Promise<DeliverPasswordReset> {
    const user = await this.usersRepository.findByEmail(email)
    if (user === null) return NO_DELIVERY

    // The STORED address, not the request's: the lookup matched through
    // Postgres `lower()` while `Email.create` folds with JavaScript's
    // `toLowerCase()`, and the two can disagree on exotic codepoints.
    const { tokenHash, deliver } = this.issuer.issue(user.email)

    const wrote = await this.passwordResetTokens.issueOrRefresh({
      id: this.idGenerator.generate(),
      userId: user.id,
      tokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * MILLISECONDS_PER_SECOND),
      cooldownCutoff: new Date(now.getTime() - this.resendCooldownMs),
    })

    // wrote === false: inside the cooldown. The minted token is discarded —
    // random bytes plus a digest, noise — the same way `confirm` discards its
    // decoy hash on a no-match.
    return wrote ? deliver : NO_DELIVERY
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/request-password-reset.spec.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

`pnpm lint`, `pnpm typecheck`. Green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/in-memory/in-memory-password-reset-tokens-repository.ts src/modules/auth/use-cases/request-password-reset.ts src/modules/auth/use-cases/request-password-reset.spec.ts
git commit -m "feat(auth): RequestPasswordResetUseCase"
```

---

## Task 8: `ResetPasswordUseCase` (the `reset` flow)

**Files:**
- Create: `src/modules/auth/use-cases/reset-password.ts`
- Test: `src/modules/auth/use-cases/reset-password.spec.ts`

**Interfaces:**
- Consumes: `IPasswordResetTokensRepository` (Task 4), `PasswordResetFailedError` (Task 6), `passwordResetCompletedEmail` (Task 5), `IUsersRepository`, `IAuthUnitOfWork` + `AuthRepos` (Task 9 adds `passwordResetTokens` to `AuthRepos` — this task's test stubs the callback repos so it does not depend on Task 9 being merged, but the type must compile; do Task 9's `AuthRepos` change FIRST if typecheck complains — see note), `IHashProvider`, `ITokenDigest`, `IClock`, `Email`.
- Produces:
  - `interface ResetPasswordCommand { token: string; newPassword: string }`
  - `class ResetPasswordUseCase` with `constructor(usersRepository: Pick<IUsersRepository, 'findById'>, passwordResetTokens: Pick<IPasswordResetTokensRepository, 'findByHash'>, uow: IAuthUnitOfWork, hashProvider: IHashProvider, tokenDigest: ITokenDigest, clock: IClock, emailSender: IEmailSender)` and `execute(command: ResetPasswordCommand): Promise<void>`.

> **Ordering note:** `ResetPasswordUseCase.execute` calls `this.uow(async ({ users, refreshTokens, passwordResetTokens }) => ...)`. `passwordResetTokens` on the callback's repo bag comes from `AuthRepos`, which Task 9 extends. If `pnpm typecheck` fails here because `AuthRepos` has no `passwordResetTokens`, do Task 9 Step 1 (the `unit-of-work.ts` + `auth-repositories.ts` edit) now, then return. The rest of Task 9 (container wiring) can still come later.

- [ ] **Step 1: Write the failing test**

`src/modules/auth/use-cases/reset-password.spec.ts` — model on `use-cases/change-password.spec.ts` for the `uow` spy + tracked repos pattern:

```ts
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { BestEffortEmailSender, type ErrorLogger } from '#infra/providers/best-effort-email-sender'
import { PasswordResetToken } from '#modules/auth/entities/password-reset-token'
import { User } from '#modules/auth/entities/user'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { PasswordResetFailedError } from '#modules/auth/errors/password-reset-failed-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { passwordResetCompletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { ResetPasswordUseCase } from '#modules/auth/use-cases/reset-password'
import { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const TOKEN_ID = 'a1a1a1a1-1111-4111-8111-111111111111'
const EMAIL = 'joao@example.com'
const RAW_TOKEN = 'opaque-256-bit-token-value'
const DIGEST_PREFIX = 'digest:'
const TOKEN_HASH = `${DIGEST_PREFIX}${RAW_TOKEN}`
const HASH_PREFIX = 'hashed:'
const OLD_HASH = `${HASH_PREFIX}old`
const NEW_PASSWORD = 'ev3n-b3tter!'
const NEW_HASH = `${HASH_PREFIX}${NEW_PASSWORD}`
const WEAK_PASSWORD = 'short'
const NOW = new Date('2026-09-07T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const TTL_SECONDS = 1800

const HASH_CALL = 'hash'
const UOW_CALL = 'uow'
const CONSUME_CALL = 'consume'
const UPDATE_CALL = 'updatePasswordHash'
const REVOKE_ALL_CALL = 'revokeAllForUser'
const COMMIT_CALL = 'commit'
const SEND_EMAIL_CALL = 'sendEmail'

const silentLogger: ErrorLogger = { error: () => {} }

let callLog: string[]
let sentEmails: EmailMessage[]
let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let hashSpy: Mock<IHashProvider['hash']>
let findByHashSpy: Mock<() => Promise<PasswordResetToken | null>>
let consumeResult: boolean
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let emailSender: IEmailSender
let useCase: ResetPasswordUseCase

const storeUser = () => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: OLD_HASH,
      emailVerifiedAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

const storedUser = () => usersRepository.users.find((u) => u.id === USER_ID)

const liveToken = () =>
  PasswordResetToken.fromTrusted({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    consumedAt: null,
    createdAt: NOW,
  })

beforeEach(() => {
  callLog = []
  sentEmails = []
  usersRepository = new InMemoryUsersRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()
  consumeResult = true

  const trackedRepos: AuthRepos = {
    users: {
      save: (u) => usersRepository.save(u),
      findByEmail: (e) => usersRepository.findByEmail(e),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) => {
        callLog.push(UPDATE_CALL)
        return usersRepository.updatePasswordHash(id, passwordHash, updatedAt)
      },
    },
    refreshTokens: {
      save: (t) => refreshTokensRepository.save(t),
      findByHashForUpdate: (h) => refreshTokensRepository.findByHashForUpdate(h),
      markRotated: (id, r, at) => refreshTokensRepository.markRotated(id, r, at),
      revoke: (id, at) => refreshTokensRepository.revoke(id, at),
      revokeFamily: (f, at) => refreshTokensRepository.revokeFamily(f, at),
      revokeAllForUser: (userId, at) => {
        callLog.push(REVOKE_ALL_CALL)
        return refreshTokensRepository.revokeAllForUser(userId, at)
      },
    },
    pendingRegistrations: {
      save: async () => {},
      findUnconsumedByEmail: async () => [],
      reissueCode: async () => {},
      registerFailedAttempt: async () => false,
      consume: async () => false,
      deleteExpiredByEmail: async () => {},
    },
    passwordResetTokens: {
      issueOrRefresh: async () => true,
      findByHash: async () => null,
      consume: async () => {
        callLog.push(CONSUME_CALL)
        return consumeResult
      },
    },
  }

  hashSpy = vi.fn(async (plain: string) => {
    callLog.push(HASH_CALL)
    return `${HASH_PREFIX}${plain}`
  })

  findByHashSpy = vi.fn(async () => liveToken())

  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW_CALL)
    const result = await work(trackedRepos)
    callLog.push(COMMIT_CALL)
    return result
  })

  emailSender = {
    send: async (message) => {
      callLog.push(SEND_EMAIL_CALL)
      sentEmails.push(message)
    },
  }

  useCase = new ResetPasswordUseCase(
    usersRepository,
    { findByHash: findByHashSpy },
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: async () => false, dummyHash: `${HASH_PREFIX}dummy` },
    { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
    { now: () => NOW },
    emailSender,
  )
})

const reset = (overrides: Partial<{ token: string; newPassword: string }> = {}) =>
  useCase.execute({ token: RAW_TOKEN, newPassword: NEW_PASSWORD, ...overrides })

describe('ResetPasswordUseCase', () => {
  it('hashes, consumes, writes the password, revokes every session, then emails — in that order', async () => {
    storeUser()

    await reset()

    expect(callLog).toEqual([
      HASH_CALL,
      UOW_CALL,
      CONSUME_CALL,
      UPDATE_CALL,
      REVOKE_ALL_CALL,
      COMMIT_CALL,
      SEND_EMAIL_CALL,
    ])
    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
  })

  it('looks the token up by its digest', async () => {
    storeUser()
    await reset()
    expect(findByHashSpy).toHaveBeenCalledWith(TOKEN_HASH)
  })

  it('notifies the owner with the reset-completed email', async () => {
    storeUser()
    await reset()
    expect(sentEmails).toEqual([passwordResetCompletedEmail(Email.fromTrusted(EMAIL))])
  })

  it('rejects a weak new password before any lookup or hash', async () => {
    storeUser()
    await expect(reset({ newPassword: WEAK_PASSWORD })).rejects.toBeInstanceOf(
      InvalidPasswordError,
    )
    expect(findByHashSpy).not.toHaveBeenCalled()
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects an unknown token with the generic failure and NO argon2', async () => {
    findByHashSpy.mockResolvedValueOnce(null)
    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(hashSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects an expired token with the generic failure and NO argon2', async () => {
    findByHashSpy.mockResolvedValueOnce(
      PasswordResetToken.fromTrusted({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        issuedAt: new Date(NOW.getTime() - TTL_SECONDS * 1000),
        expiresAt: NOW, // arrived == spent
        consumedAt: null,
        createdAt: new Date(NOW.getTime() - TTL_SECONDS * 1000),
      }),
    )
    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(hashSpy).not.toHaveBeenCalled()
  })

  it('rejects when it loses the consume race, writing neither the password nor a revocation', async () => {
    storeUser()
    consumeResult = false

    await expect(reset()).rejects.toBeInstanceOf(PasswordResetFailedError)
    expect(callLog).toEqual([HASH_CALL, UOW_CALL, CONSUME_CALL]) // no UPDATE, no REVOKE, no COMMIT
    expect(storedUser()?.passwordHash).toBe(OLD_HASH)
  })

  it('still resolves when the completion email cannot be delivered', async () => {
    storeUser()
    const resilient = new ResetPasswordUseCase(
      usersRepository,
      { findByHash: findByHashSpy },
      uowSpy as unknown as IAuthUnitOfWork,
      { hash: hashSpy, compare: async () => false, dummyHash: `${HASH_PREFIX}dummy` },
      { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
      { now: () => NOW },
      new BestEffortEmailSender(
        { send: async () => { throw new Error('smtp down') } },
        silentLogger,
      ),
    )

    await expect(
      resilient.execute({ token: RAW_TOKEN, newPassword: NEW_PASSWORD }),
    ).resolves.toBeUndefined()
    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/reset-password.spec.ts`
Expected: FAIL — module not found (and possibly a typecheck error on `AuthRepos.passwordResetTokens`; if so, apply Task 9 Step 1 now).

- [ ] **Step 3: Implement the use case**

`src/modules/auth/use-cases/reset-password.ts`:

```ts
import { PasswordResetFailedError } from '#modules/auth/errors/password-reset-failed-error'
import { passwordResetCompletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { IPasswordResetTokensRepository } from '#modules/auth/repositories/password-reset-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface ResetPasswordCommand {
  token: string
  newPassword: string
}

/**
 * Redeems a reset token for a new password: replaces the hash, revokes every
 * session, burns the token — all in one transaction — and answers with nothing
 * (§3.3 of the design: the caller is not authenticated, so it goes to login).
 *
 * ONE error for every failure mode, same message: unknown token, expired,
 * consumed, and losing the race to consume. Branches that reported differently
 * would make this a token oracle for an anonymous caller.
 *
 * argon2 runs ONLY on the valid-token branch (§3.5): 256 bits are
 * unguessable, so the timing signal "that token was valid" cannot be exploited,
 * and hashing for every junk request is cost without return.
 */
export class ResetPasswordUseCase {
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
    private readonly passwordResetTokens: Pick<
      IPasswordResetTokensRepository,
      'findByHash'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly emailSender: IEmailSender,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<void> {
    // First, so a bad payload pays neither a lookup nor argon2 — and no token
    // is spent by a request that never tried one.
    const newPassword = Password.create(command.newPassword)

    // Read ONCE — the same instant feeds isUsable, updated_at and every
    // revoked_at.
    const now = this.clock.now()

    const tokenHash = this.tokenDigest.hash(command.token)
    const token = await this.passwordResetTokens.findByHash(tokenHash)

    // Unknown, expired, or already consumed: one throw, no argon2.
    if (token === null || !token.isUsable(now)) throw new PasswordResetFailedError()

    // Reachable only in theory: the FK cascades, so a deleted user takes its
    // token row with it and the check above would have thrown. Generic, not a
    // new error. Needed for the notification.
    const user = await this.usersRepository.findById(token.userId)
    if (user === null) throw new PasswordResetFailedError()

    // argon2, outside the transaction (§8), only here.
    const passwordHash = await this.hashProvider.hash(newPassword.value)

    await this.uow(async ({ users, refreshTokens, passwordResetTokens }) => {
      // Conditional UPDATE. Losing it means a concurrent reset already burned
      // this token — throw INSIDE the callback so the transaction aborts; a
      // `return` would leave state half-written.
      if (!(await passwordResetTokens.consume(token.id, now))) {
        throw new PasswordResetFailedError()
      }

      await users.updatePasswordHash(token.userId, passwordHash, now)
      await refreshTokens.revokeAllForUser(token.userId, now)
    })

    // After the commit, like every send in this module (§8). Best-effort: the
    // password already changed, a 500 here would misinform.
    await this.emailSender.send(passwordResetCompletedEmail(user.email))
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/reset-password.spec.ts`
Expected: PASS.

- [ ] **Step 5: Gates**

`pnpm lint`, `pnpm typecheck`. Green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/use-cases/reset-password.ts src/modules/auth/use-cases/reset-password.spec.ts src/modules/auth/repositories/unit-of-work.ts src/modules/auth/infra/drizzle/auth-repositories.ts
git commit -m "feat(auth): ResetPasswordUseCase"
```

(Include `unit-of-work.ts` / `auth-repositories.ts` only if you applied Task 9 Step 1 here.)

---

## Task 9: Wire `AuthRepos` and the container

**Files:**
- Modify: `src/modules/auth/repositories/unit-of-work.ts`
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Modify: `src/modules/auth/container.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 6, 7, 8, plus the config from Task 1.
- Produces on `AuthContainer`: `forgotPassword: RequestPasswordResetUseCase`, `resetPassword: ResetPasswordUseCase`, `forgotPasswordRateLimit: { max: number; timeWindow: number }`, `resetPasswordRateLimit: { max: number; timeWindow: number }`. `AuthRepos` gains `passwordResetTokens: IPasswordResetTokensRepository`.

- [ ] **Step 1: Extend `AuthRepos` and `authRepositories`**

`src/modules/auth/repositories/unit-of-work.ts` — add the field and a comment in the same style:

```ts
import type { IPasswordResetTokensRepository } from './password-reset-tokens-repository.js'
// ...
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
  pendingRegistrations: IPendingRegistrationsRepository
  /**
   * Here for the same reason as the others: `reset` consumes the token, writes
   * the password hash and revokes every session in one transaction — one fact,
   * all or nothing.
   */
  passwordResetTokens: IPasswordResetTokensRepository
}
```

`src/modules/auth/infra/drizzle/auth-repositories.ts`:

```ts
import { DrizzlePasswordResetTokensRepository } from './drizzle-password-reset-tokens-repository.js'
// ...
export function authRepositories(db: Database): AuthRepos {
  return {
    users: new DrizzleUsersRepository(db),
    refreshTokens: new DrizzleRefreshTokensRepository(db),
    pendingRegistrations: new DrizzlePendingRegistrationsRepository(db),
    passwordResetTokens: new DrizzlePasswordResetTokensRepository(db),
  }
}
```

- [ ] **Step 2: Run the existing unit-of-work and use-case tests**

Run: `pnpm vitest run --project unit` and `pnpm typecheck`.
Expected: PASS. Any use-case spec that builds a full `AuthRepos` literal (e.g. `change-password.spec.ts`, `confirm-email.spec.ts`) now needs a `passwordResetTokens` stub in that literal — add:
```ts
    passwordResetTokens: {
      issueOrRefresh: async () => true,
      findByHash: async () => null,
      consume: async () => false,
    },
```
Fix each failing file, re-run.

- [ ] **Step 3: Commit the repo wiring**

```bash
git add src/modules/auth/repositories/unit-of-work.ts src/modules/auth/infra/drizzle/auth-repositories.ts src/modules/auth/use-cases/*.spec.ts
git commit -m "feat(auth): add passwordResetTokens to AuthRepos"
```

- [ ] **Step 4: Wire the container**

`src/modules/auth/container.ts`:

1. Destructure the new repo:
```ts
  const {
    users: usersRepository,
    refreshTokens: refreshTokensRepository,
    pendingRegistrations: pendingRegistrationsRepository,
    passwordResetTokens: passwordResetTokensRepository,
  } = authRepositories(db)
```
2. Rename the best-effort sender variable and reuse it:
```ts
  // Wrapped so a notification that cannot be delivered still lets the request
  // succeed. Used by the password-change and password-reset notifications;
  // everything else gets the bare sender so an undeliverable code fails loudly.
  const bestEffortEmailSender = new BestEffortEmailSender(emailSender, logger)
```
Replace the two `passwordChangedEmailSender` references (the declaration and the `changePassword` constructor argument) with `bestEffortEmailSender`.
3. Add the issuer next to `emailVerificationIssuer`:
```ts
  const passwordResetIssuer = new PasswordResetIssuer(
    emailSender,
    tokenGenerator,
    tokenDigest,
    config.PASSWORD_RESET_TTL_SECONDS,
  )
```
4. Add the two use cases to the returned object:
```ts
    forgotPassword: new RequestPasswordResetUseCase(
      usersRepository,
      passwordResetTokensRepository,
      passwordResetIssuer,
      clock,
      idGenerator,
      config.PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
      config.PASSWORD_RESET_TTL_SECONDS,
    ),
    resetPassword: new ResetPasswordUseCase(
      usersRepository,
      passwordResetTokensRepository,
      uow,
      hashProvider,
      tokenDigest,
      clock,
      bestEffortEmailSender,
    ),
```
5. Add the two rate-limit objects next to `passwordChangeRateLimit`:
```ts
    /**
     * `forgot` declares its own ceiling, like `register`: an anonymous request
     * that puts mail in an arbitrary inbox is a spam amplifier.
     */
    forgotPasswordRateLimit: {
      max: config.PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
    /**
     * `reset` declares its own ceiling, like `confirm`: a request here carries
     * a token guess.
     */
    resetPasswordRateLimit: {
      max: config.PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
```
6. Add the imports at the top with the other use-case imports:
```ts
import { PasswordResetIssuer } from './services/password-reset-issuer.js'
import { RequestPasswordResetUseCase } from './use-cases/request-password-reset.js'
import { ResetPasswordUseCase } from './use-cases/reset-password.js'
```

- [ ] **Step 5: Gates**

`pnpm lint`, `pnpm typecheck`, `pnpm build`. All green.

- [ ] **Step 6: Run the full existing integration suite (nothing should have regressed)**

Run: `docker compose up -d` then `pnpm vitest run --project integration`.
Expected: PASS (same count as before plus the two new schema/repo suites from Tasks 2 & 4).

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/container.ts
git commit -m "feat(auth): wire password recovery into the container"
```

---

## Task 10: `POST /auth/password/forgot` endpoint

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/forgot-password.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Test: `tests/integration/forgot-password.spec.ts`

**Interfaces:**
- Consumes: `container.forgotPassword`, `container.forgotPasswordRateLimit`.
- Produces: `export const forgotPasswordRoute: FastifyPluginAsync<{ container: AuthContainer }>`.

- [ ] **Step 1: Write the endpoint**

`src/modules/auth/infra/http/endpoints/forgot-password.ts` — model on `endpoints/register.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  ACCEPTED_STATUS,
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_EMAIL,
  TOO_MANY_REQUESTS_STATUS,
} from '#modules/auth/infra/http/constants'
import { MAX_EMAIL_LENGTH } from '#modules/auth/value-objects/email'

const FORGOT_PASSWORD_PATH = '/password/forgot'
const FORGOT_PASSWORD_SUMMARY = 'Start password recovery'
const FORGOT_PASSWORD_DESCRIPTION =
  'Emails a single-use reset token to the address if it has an account. Always ' +
  'answers 202, whether or not the address has an account: a status that ' +
  'distinguished the two would let anyone enumerate accounts. An address with ' +
  'no account receives nothing.'

/**
 * `.strict()` so a stale client sending anything else takes a 400 rather than a
 * 202 that silently drops the field. `email` in the same shape `register`
 * validates it: presence and format at the wire, so a malformed address answers
 * 400 with a per-field `details` array before it reaches `Email.create`.
 */
const bodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .max(MAX_EMAIL_LENGTH)
      .pipe(z.email())
      .meta({ examples: [EXAMPLE_EMAIL] }),
  })
  .strict()

export const forgotPasswordRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    FORGOT_PASSWORD_PATH,
    {
      /**
       * Its own ceiling, like `register`: this route sends mail to an arbitrary
       * address from an anonymous request.
       */
      config: { rateLimit: container.forgotPasswordRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: FORGOT_PASSWORD_SUMMARY,
        description: FORGOT_PASSWORD_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()`, not an omitted entry: the Zod type provider only lets a
          // handler answer a status the schema declares. No transaction here,
          // so no 503.
          [ACCEPTED_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.forgotPassword.execute(request.body)

      return reply.status(ACCEPTED_STATUS).send(null)
    },
  )
}
```

- [ ] **Step 2: Register the route**

`src/modules/auth/infra/http/routes.ts` — add the import and the registration (unauthenticated, no `guard`), next to `changePasswordRoute`:

```ts
import { forgotPasswordRoute } from './endpoints/forgot-password.js'
// ...
  await app.register(forgotPasswordRoute, { container })
```

- [ ] **Step 3: Write the failing integration test**

`tests/integration/forgot-password.spec.ts` — model on `verify-email.spec.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'
import { clearMailpit, latestMessage, messageCount, waitForMessageCount } from './setup/mailpit.js'

const FORGOT_PATH = '/auth/password/forgot'
const POST_METHOD = 'POST'
const ACCEPTED_STATUS_CODE = 202
const BAD_REQUEST_STATUS_CODE = 400

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const UNKNOWN_EMAIL = 'nobody@example.com'
const PASSWORD_RESET_SUBJECT = 'Reset your password'
const SIX_DIGIT_PATTERN = /\b\d{6}\b/
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_-]{32,}/
const ONE_MESSAGE = 1
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
    PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
  })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(passwordResetTokens)
  await db.delete(refreshTokens)
  await db.delete(users)
  await clearMailpit()
})

const forgot = (email: string) =>
  app.inject({ method: POST_METHOD, url: FORGOT_PATH, payload: { email } })

describe('POST /auth/password/forgot, against a real SMTP server', () => {
  it('answers 202 and emails a token for an address with an account', async () => {
    await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

    const response = await forgot(EMAIL)
    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)

    await waitForMessageCount(ONE_MESSAGE)
    const message = await latestMessage()
    expect(message.subject).toBe(PASSWORD_RESET_SUBJECT)
    expect(message.text).toMatch(OPAQUE_TOKEN_PATTERN)
    expect(message.text).not.toMatch(SIX_DIGIT_PATTERN)
  })

  it('answers 202 and emails nothing for an address with no account', async () => {
    const response = await forgot(UNKNOWN_EMAIL)

    expect(response.statusCode).toBe(ACCEPTED_STATUS_CODE)
    expect(await messageCount()).toBe(0)
  })

  it('does not send a second email inside the resend cooldown', async () => {
    await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

    await forgot(EMAIL)
    await waitForMessageCount(ONE_MESSAGE)
    await forgot(EMAIL)

    // The shipped 60s cooldown holds; still exactly one message.
    expect(await messageCount()).toBe(ONE_MESSAGE)
  })

  it('answers 400 to a malformed address', async () => {
    const response = await forgot('not-an-email')
    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
})
```

- [ ] **Step 4: Run it**

Run: `pnpm vitest run --project integration tests/integration/forgot-password.spec.ts`
Expected: PASS.

- [ ] **Step 5: Gates**

`pnpm lint`, `pnpm typecheck`, `pnpm build`. Green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/infra/http/endpoints/forgot-password.ts src/modules/auth/infra/http/routes.ts tests/integration/forgot-password.spec.ts
git commit -m "feat(auth): POST /auth/password/forgot"
```

---

## Task 11: `POST /auth/password/reset` endpoint

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/reset-password.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Modify: `tests/integration/setup/mailpit.ts` (add `extractResetToken`)
- Test: `tests/integration/reset-password.spec.ts`

**Interfaces:**
- Consumes: `container.resetPassword`, `container.resetPasswordRateLimit`.
- Produces: `export const resetPasswordRoute: FastifyPluginAsync<{ container: AuthContainer }>`; `export function extractResetToken(text: string): string` in `mailpit.ts`.

- [ ] **Step 1: Write the endpoint**

`src/modules/auth/infra/http/endpoints/reset-password.ts` — model on `endpoints/confirm-email.ts` (shape check on the opaque token, full policy on the new password):

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_PASSWORD,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const RESET_PASSWORD_PATH = '/password/reset'
const RESET_PASSWORD_SUMMARY = 'Reset a password with a recovery token'
const RESET_PASSWORD_DESCRIPTION =
  'Redeems the token emailed by `forgot`, replaces the password, and revokes ' +
  'every session on every device. Answers 204 with no session: sign in with ' +
  'the new password. One error, `PASSWORD_RESET_FAILED`, for every token ' +
  'failure — unknown, wrong, expired or already used.'

/**
 * Shape only — a base64url string in a generous length band. Whether the token
 * is real, or still usable, is `PASSWORD_RESET_FAILED` territory: one answer for
 * every failure mode. The band is wide because the exact length is an adapter
 * detail (`RandomTokenGenerator` emits base64url of 32 bytes = 43 chars).
 */
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/
const RESET_TOKEN_REASON = 'must be a base64url token'
const EXAMPLE_RESET_TOKEN = 'Yk9wYVF1ZVRva2VuRXhhbXBsZVZhbHVlMTIzNDU2Nzg5'

const bodySchema = z
  .object({
    token: z
      .string()
      .regex(RESET_TOKEN_PATTERN, RESET_TOKEN_REASON)
      .meta({ examples: [EXAMPLE_RESET_TOKEN] }),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH)
      .max(MAX_PASSWORD_LENGTH)
      .regex(PASSWORD_POLICY_PATTERN)
      .meta({ examples: [EXAMPLE_PASSWORD] }),
  })
  .strict()

export const resetPasswordRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    RESET_PASSWORD_PATH,
    {
      config: { rateLimit: container.resetPasswordRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: RESET_PASSWORD_SUMMARY,
        description: RESET_PASSWORD_DESCRIPTION,
        body: bodySchema,
        response: {
          [NO_CONTENT_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNPROCESSABLE_ENTITY_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // Opens a transaction to consume the token: a deadlock that survives
          // the runner's retries surfaces as TransactionConflictError.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.resetPassword.execute(request.body)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}
```

- [ ] **Step 2: Register the route**

`src/modules/auth/infra/http/routes.ts` — import and register next to `forgotPasswordRoute`:

```ts
import { resetPasswordRoute } from './endpoints/reset-password.js'
// ...
  await app.register(resetPasswordRoute, { container })
```

- [ ] **Step 3: Add the Mailpit token extractor**

`tests/integration/setup/mailpit.ts` — add, mirroring `extractVerificationCode` (throws on no match, deliberately):

```ts
const RESET_TOKEN_PATTERN = /reset your password: ([A-Za-z0-9_-]{32,})/
const NO_RESET_TOKEN_MESSAGE =
  'no reset token found in the message text — a helper that returned null ' +
  'here would let a test pass while proving nothing'

/**
 * Extracts the opaque reset token from a message body. Throws when none is
 * found, like `extractVerificationCode`: a `null` here would let a test that
 * never received a token still read as green.
 */
export function extractResetToken(text: string): string {
  const match = text.match(RESET_TOKEN_PATTERN)
  if (match?.[1] === undefined) throw new Error(NO_RESET_TOKEN_MESSAGE)
  return match[1]
}
```

> The regex's literal prefix must match the wording in `passwordResetEmail` (Task 5 Step 6: `Use this token to reset your password: <token>`). If you reworded the template, update this pattern.

- [ ] **Step 4: Write the failing integration test**

`tests/integration/reset-password.spec.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'
import { buildApp } from '#main/app'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'
import {
  clearMailpit,
  extractResetToken,
  latestMessage,
  waitForMessageCount,
} from './setup/mailpit.js'

const FORGOT_PATH = '/auth/password/forgot'
const RESET_PATH = '/auth/password/reset'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const POST_METHOD = 'POST'

const NO_CONTENT_STATUS_CODE = 204
const OK_STATUS_CODE = 200
const BAD_REQUEST_STATUS_CODE = 400
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const PASSWORD_RESET_FAILED_CODE = 'PASSWORD_RESET_FAILED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const MALFORMED_TOKEN = 'too-short'
const WELL_FORMED_UNKNOWN_TOKEN = 'Z'.repeat(43)
const ONE_MESSAGE = 1
const TWO_MESSAGES = 2
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp({
    ...env,
    PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
  })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(passwordResetTokens)
  await db.delete(refreshTokens)
  await db.delete(users)
  await clearMailpit()
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })
})

const forgot = () =>
  app.inject({ method: POST_METHOD, url: FORGOT_PATH, payload: { email: EMAIL } })
const resetWith = (token: string, newPassword = NEW_PASSWORD) =>
  app.inject({ method: POST_METHOD, url: RESET_PATH, payload: { token, newPassword } })
const login = (password: string) =>
  app.inject({ method: POST_METHOD, url: LOGIN_PATH, payload: { email: EMAIL, password } })

/** Runs forgot and returns the token from the email. */
async function forgotAndFetchToken(): Promise<string> {
  await forgot()
  await waitForMessageCount(ONE_MESSAGE)
  return extractResetToken((await latestMessage()).text)
}

describe('POST /auth/password/reset', () => {
  it('changes the password: 204, new password works, old one does not', async () => {
    const token = await forgotAndFetchToken()

    const response = await resetWith(token)
    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)

    expect((await login(PASSWORD)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(NEW_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('revokes every session that existed before the reset', async () => {
    const session = (await login(PASSWORD)).json() as { refreshToken: string }
    const token = await forgotAndFetchToken()

    await resetWith(token)

    const refreshed = await app.inject({
      method: POST_METHOD,
      url: REFRESH_PATH,
      payload: { refreshToken: session.refreshToken },
    })
    expect(refreshed.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('emails a "password was reset" notification after success', async () => {
    const token = await forgotAndFetchToken()
    await resetWith(token)
    await waitForMessageCount(TWO_MESSAGES)
  })

  it('rejects a replay of a spent token with 422 PASSWORD_RESET_FAILED', async () => {
    const token = await forgotAndFetchToken()
    expect((await resetWith(token)).statusCode).toBe(NO_CONTENT_STATUS_CODE)

    const replay = await resetWith(token)
    expect(replay.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(replay.json().error.code).toBe(PASSWORD_RESET_FAILED_CODE)
  })

  it('rejects a well-formed but unknown token with 422', async () => {
    const response = await resetWith(WELL_FORMED_UNKNOWN_TOKEN)
    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(response.json().error.code).toBe(PASSWORD_RESET_FAILED_CODE)
  })

  it('rejects an expired token with 422', async () => {
    const rawToken = 'E'.repeat(43)
    const [account] = await db.select().from(users)
    await db.insert(passwordResetTokens).values({
      id: '9e9e9e9e-9999-4999-8999-999999999999',
      userId: account?.id ?? '',
      tokenHash: new Sha256TokenDigest().hash(rawToken),
      issuedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-01T00:30:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    })

    const response = await resetWith(rawToken)
    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
  })

  it('rejects a malformed token with 400', async () => {
    const response = await resetWith(MALFORMED_TOKEN)
    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
})
```

- [ ] **Step 5: Run it**

Run: `pnpm vitest run --project integration tests/integration/reset-password.spec.ts`
Expected: PASS. If the "expired token" case fails because `db.insert` needs the account id, confirm `arrangeAccount` inserted the user in `beforeEach` and the `db.select().from(users)` reads it back.

- [ ] **Step 6: Full suites**

Run: `pnpm vitest run --project unit` then `pnpm vitest run --project integration`. Both green.
Then `pnpm lint`, `pnpm typecheck`, `pnpm build`. Green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/http/endpoints/reset-password.ts src/modules/auth/infra/http/routes.ts tests/integration/setup/mailpit.ts tests/integration/reset-password.spec.ts
git commit -m "feat(auth): POST /auth/password/reset"
```

---

## Task 12: Documentation

**Files:**
- Modify: `src/modules/auth/README.md`
- Modify: `docs/TODO.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:** none — prose only.

- [ ] **Step 1: Update the module README**

`src/modules/auth/README.md`:
- Add two rows to the endpoints table:
  | `POST /password/forgot` | Inicia a recuperação de senha; envia um token por e-mail | não |
  | `POST /password/reset` | Redefine a senha com o token; encerra **todas** as sessões | não |
- Add a "### Recuperação de senha" section under "### Troca de senha", describing: `forgot` answers `202` always (no account enumeration, unknown address gets nothing); `reset` takes `{ token, newPassword }`, answers `204` with no session (sign in with the new password), revokes every session, one generic `422 PASSWORD_RESET_FAILED`; the token is a 256-bit opaque value, one live per account, superseded on each `forgot`, 30-minute TTL, 60-second resend cooldown.
- Remove "**Recuperação de senha** ("esqueci minha senha")" from the "O que este módulo **não** faz (ainda)" list.
- Add `PASSWORD_RESET_FAILED` to the stable-`code` guarantees.

- [ ] **Step 2: Update `docs/TODO.md`**

Move "Recuperação de senha" from the open slice to done, in the same voice the file uses for slice 11 (a "✅ ... — fechado pela fatia 12" heading). Note the three prune tables now include `password_reset_tokens`. Keep the "O resto" table; update the poda row to mention the third table.

- [ ] **Step 3: Update `docs/DECISIONS.md`**

Add a decision entry (next number in sequence) recording, briefly, with a pointer to the spec:
- reset token is a 256-bit opaque value, not a 6-digit code (spec §3.1 / §12.1);
- `reset` does not auto-login — `204`, sign in again (spec §3.3 / §12.3);
- `forgot` sends nothing to an unknown address (spec §3.4);
- `reset` runs argon2 only on the valid-token branch, a deliberate divergence from `confirm` (spec §3.5 / §12.4);
- `INSERT ... ON CONFLICT` is used for the `forgot` upsert — first use of the pattern in the repo (spec §12.2).
Also update the `## 6` "Login social" note if it references password recovery as "em aberto" / "próxima fatia".

- [ ] **Step 4: Gate**

Run: `pnpm lint` (it may lint Markdown; if not, just confirm the build is unaffected). `pnpm typecheck`, `pnpm build` green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/README.md docs/TODO.md docs/DECISIONS.md
git commit -m "docs(auth): document the password recovery endpoints"
```

---

## Final verification (before finishing the branch)

- [ ] `pnpm lint` — green, read the exit code.
- [ ] `pnpm typecheck` — green.
- [ ] `pnpm build` — green.
- [ ] `pnpm vitest run --project unit` — green; note the count (was 317 across 35 files; expect +~5 files).
- [ ] `pnpm vitest run --project integration` — green (needs `docker compose up -d`); was 126 across 17 files; expect +4 files.
- [ ] `git log --oneline` — one commit per task, messages in English, each ending with the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.
- [ ] Then hand off to `superpowers:finishing-a-development-branch` (which chains into `finish-with-review-pr`: architecture audit → resolve findings → on "Push and Create PR", draft PR with a Mermaid component map).

---

## Self-Review (done by the plan author)

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 opaque token | 2 (schema, no `attempts`), 6 (issuer uses `opaque()`) |
| §3.2 one live token / upsert | 2 (`unique(user_id)`), 4 (`issueOrRefresh`) |
| §3.3 `204`, no auto-login | 11 (endpoint `204`, no `refreshTransport`), 8 (use case returns void) |
| §3.4 silence for unknown address | 7 (`NO_DELIVERY` on `user === null`), 10 (integration) |
| §3.5 argon2 only on valid branch | 8 (`hash` after the `isUsable` guard; tests assert `hashSpy` not called on failure) |
| §4.1 table | 2 |
| §4.2 `issued_at` vs `created_at` | 2 (schema), 4 (`issueOrRefresh` sets `issued_at`, leaves `created_at`) |
| §5.1 entity | 3 |
| §5.2 repo contract | 4 |
| §5.3 `AuthRepos` + uow | 9 |
| §5.4 issuer | 6 |
| §5.5 email rename + templates | 5 |
| §6.1 `forgot` flow | 7 |
| §6.2 `reset` flow | 8 |
| §6.3 no enumeration | 7 + 10 (202 for both, latency not branched) |
| §7.1 endpoints | 10, 11 |
| §7.2 `PasswordResetFailedError` → 422 | 6 (extends `BusinessRuleError`, already wired in `STATUS_BY_CATEGORY`) |
| §8.1 migration | 2 |
| §8.2 container | 9 |
| §8.3 config | 1 |
| §9 renames | 5 (email module), 9 (`bestEffortEmailSender`) |
| §10.1 unit tests | 1, 3, 5, 6, 7, 8 |
| §10.2 integration tests | 2, 4, 10, 11 |
| §12 recorded decisions | 12 |

No gaps.

**Placeholder scan:** none — every code step carries the code; every test step carries the assertions.

**Type consistency:** `issueOrRefresh(params: IssueOrRefreshParams)` used identically in Task 4 (interface, adapter, integration test), Task 7 (in-memory adapter, use case, unit test). `findByHash(tokenHash: string): Promise<PasswordResetToken | null>` consistent across Tasks 4, 7, 8. `consume(id: string, at: Date): Promise<boolean>` matches `IPendingRegistrationsRepository.consume`. `RequestPasswordResetCommand { email }` and `ResetPasswordCommand { token; newPassword }` match the endpoint `bodySchema` shapes (Tasks 10, 11). `PasswordResetFailedError.code === 'PASSWORD_RESET_FAILED'` matches the integration assertions in Task 11. Container keys `forgotPassword` / `resetPassword` / `forgotPasswordRateLimit` / `resetPasswordRateLimit` (Task 9) match the endpoint consumers (Tasks 10, 11).
