# Password Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /auth/password` lets an authenticated user change their own password, revoking every existing session and handing the current device a fresh token pair.

**Architecture:** A use case that runs both argon2 calls (`compare` for the current password, `hash` for the new one) **outside** the transaction, then opens one Unit of Work that writes three things atomically — the new hash in `users`, the revocation of every live refresh token, and the new family's first token. The revocation must run **before** the insert, or the new token is revoked at birth by the very `UPDATE` that revokes the old ones.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Fastify 5 + `fastify-type-provider-zod`, Zod 4, Drizzle ORM `1.0.0-rc.4`, Postgres, Vitest, argon2id, Biome.

**Spec:** [`docs/superpowers/specs/2026-09-03-password-change-design.md`](../specs/2026-09-03-password-change-design.md)

## Global Constraints

- **Language.** All code — identifiers, strings, log messages, error messages — and all comments are **English**. Markdown may be Portuguese.
- **No magic strings or numbers.** Every literal becomes a named `UPPER_SNAKE_CASE` constant, declared close to its use. The schema-declaration exception in `CLAUDE.md` does not apply to any file in this plan.
- **R7 — the clock is injected.** Never `new Date()` in application or domain code. `clock.now()` is read **once** per `execute` and the same value feeds `updated_at`, `revoked_at` and the new token's `created_at`/`expires_at`.
- **`updatedAt` is always passed explicitly** to `updatePasswordHash`. The column carries `$onUpdate`, which fills an *absence* with the system clock (measured — it never overwrites a present value), so omitting it is the one way the injected clock silently stops being the source of truth.
- **Argon2 never runs inside a `uow` callback.** §8 of the Unit of Work design: ~15 ms of CPU with a pooled connection (there are 10) standing still.
- **Never nest `uow` inside `uow`.** §4.2 of the same design — it opens an independent transaction.
- **Verify, don't presume.** Run each gate separately and read its exit code. `pnpm lint | tail -1` returns `tail`'s status, not lint's. `pnpm test:unit -- <file>` does **not** filter — it runs the whole suite.
- **Falsify every test.** After a test goes green, write the mutation it is supposed to kill, confirm it goes red, then revert the mutation. A test that survives its own mutation is not a test.
- **Gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — each run on its own.
- **Integration tests need Postgres:** `docker compose up -d`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/modules/auth/errors/invalid-current-password-error.ts` | The 422 for a wrong current password |
| `src/modules/auth/errors/password-unchanged-error.ts` | The 422 for a new password equal to the current one |
| `src/modules/auth/use-cases/change-password.ts` | Orchestration and the mandatory ordering |
| `src/modules/auth/use-cases/change-password.spec.ts` | Unit tests, colocated (decision 09) |
| `src/modules/auth/infra/http/session-tokens.ts` | The one definition of `{ accessToken, refreshToken? }` |
| `src/modules/auth/infra/http/endpoints/change-password.ts` | Wire contract, rate-limit ceiling, cookie handling |
| `tests/integration/change-password.spec.ts` | End-to-end over HTTP against real Postgres |

**Modified**

| File | Change |
|---|---|
| `src/modules/auth/repositories/users-repository.ts` | `+ updatePasswordHash` |
| `src/modules/auth/infra/drizzle/drizzle-users-repository.ts` | implement it |
| `src/modules/auth/infra/in-memory/in-memory-users-repository.ts` | implement it, rehydrating the frozen entity |
| `src/modules/auth/config.ts` | `+ 2` env vars and their defaults |
| `src/modules/auth/container.ts` | `+ changePassword`, `+ passwordChangeRateLimit` |
| `src/modules/auth/infra/http/constants.ts` | `+ UNPROCESSABLE_ENTITY_STATUS` |
| `src/modules/auth/infra/http/routes.ts` | `+ 1` registration line |
| `src/modules/auth/infra/http/refresh-cookie.ts` | amend the "Only `login` needs it" comment |
| `src/modules/auth/infra/http/endpoints/login.ts` | import the shared schema |
| `src/modules/auth/infra/http/endpoints/refresh.ts` | import the shared schema |
| `src/infra/config/fixtures/test-env.ts` | `+ 2` values |
| `.env.example` | `+ 2` documented variables |
| `tests/integration/drizzle-users-repository.spec.ts` | `+ 3` tests |

**Deliberately untouched:** the `User` entity, `LogoutAllUseCase`, and `schema/users.ts` — including its `$onUpdate`, per §3.1 of the spec.

---

### Task 1: `updatePasswordHash` on the users repository

**Files:**
- Modify: `src/modules/auth/repositories/users-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-users-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-users-repository.ts`
- Test: `tests/integration/drizzle-users-repository.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `IUsersRepository.updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>` — used by Task 2 through the Unit of Work's `repos.users`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/drizzle-users-repository.spec.ts`. Put these constants beside the existing ones at the top of the file:

```ts
const NEW_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$b3RoZXJzYWx0$newhash'
/**
 * Far from any real clock. If the repository ever stops sending the column, the
 * `$onUpdate` fills it with the system clock and the difference is six years —
 * impossible to mistake for a rounding artefact.
 */
const DISTANT_PAST = new Date('2020-01-01T00:00:00.000Z')
```

And this `describe` block at the end of the file:

```ts
describe('updatePasswordHash', () => {
  it('writes the exact updatedAt it is given, not the system clock', async () => {
    await repository.save(makeUser(ID, EMAIL))

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const stored = await repository.findById(ID)
    expect(stored?.updatedAt).toEqual(DISTANT_PAST)
  })

  it('changes only the password columns', async () => {
    await repository.save(makeUser(ID, EMAIL))
    const before = await repository.findById(ID)

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const after = await repository.findById(ID)
    expect(after?.passwordHash).toBe(NEW_PASSWORD_HASH)
    expect(after?.email.value).toBe(before?.email.value)
    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.emailVerifiedAt).toBeNull()
  })

  it('never touches another row', async () => {
    // `id` and `passwordHash` are adjacent positional strings, so transposing
    // them compiles. This is the test that catches it.
    await repository.save(makeUser(ID, EMAIL))
    await repository.save(makeUser(OTHER_ID, OTHER_EMAIL))

    await repository.updatePasswordHash(ID, NEW_PASSWORD_HASH, DISTANT_PAST)

    const other = await repository.findById(OTHER_ID)
    expect(other?.passwordHash).toBe(PASSWORD_HASH)
    expect(other?.updatedAt).not.toEqual(DISTANT_PAST)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose up -d
pnpm test:integration
```

Expected: FAIL — TypeScript reports `Property 'updatePasswordHash' does not exist on type 'DrizzleUsersRepository'`.

- [ ] **Step 3: Add the method to the contract**

In `src/modules/auth/repositories/users-repository.ts`, after `findById`:

```ts
  /**
   * Writes ONLY `password_hash` and `updated_at`.
   *
   * A command with primitives rather than an entity, which is this module's
   * declared shape for updates — every write on `IRefreshTokensRepository` that
   * is not an insert looks the same. It also makes the wrong column
   * inexpressible: this signature has no access to `email`, so writing it is a
   * compile error rather than a review comment.
   *
   * `updatedAt` is passed EXPLICITLY, always. The column carries `$onUpdate`,
   * which fills an absence with the system clock — measured against
   * drizzle-orm 1.0.0-rc.4, it never overwrites a value that is present — so
   * omitting it here is the one way the injected `IClock` stops being the
   * source of truth, and it would fail in silence.
   *
   * Silent about a missing id: the caller has already loaded the user, and
   * turning a deleted row into an error here would duplicate a decision that
   * belongs to the use case.
   */
  updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>
```

- [ ] **Step 4: Implement it in the Drizzle adapter**

In `src/modules/auth/infra/drizzle/drizzle-users-repository.ts`, after `findById`:

```ts
  async updatePasswordHash(
    id: string,
    passwordHash: string,
    updatedAt: Date,
  ): Promise<void> {
    try {
      await this.db.update(users).set({ passwordHash, updatedAt }).where(eq(users.id, id))
    } catch (error) {
      // Same reason as `save`: Drizzle's error glues every bound parameter into
      // its own message, and this statement binds a password hash.
      throw toPersistenceError(error)
    }
  }
```

`eq` and `toPersistenceError` are already imported by this file.

- [ ] **Step 5: Implement it in the in-memory adapter**

In `src/modules/auth/infra/in-memory/in-memory-users-repository.ts`, change the entity import from a type-only import to a value import, because `User.fromTrusted` is now called:

```ts
import { User } from '#modules/auth/entities/user'
```

Then add, after `findById`:

```ts
  async updatePasswordHash(
    id: string,
    passwordHash: string,
    updatedAt: Date,
  ): Promise<void> {
    const current = this.users.find((existing) => existing.id === id)
    if (current === undefined) return

    // The entity is frozen with `#` readonly fields, so there is nothing to
    // mutate: a new one is rehydrated from the old one's getters with the two
    // columns replaced. Same shape as `InMemoryRefreshTokensRepository.#replace`.
    this.users[this.users.indexOf(current)] = User.fromTrusted({
      id: current.id,
      email: current.email,
      passwordHash,
      emailVerifiedAt: current.emailVerifiedAt,
      createdAt: current.createdAt,
      updatedAt,
    })
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test:integration
```

Expected: PASS, including the three new tests.

- [ ] **Step 7: Falsify the tests**

Three mutations, one at a time, reverting each before the next:

1. In the Drizzle adapter, drop `updatedAt` from the `set` object: `set({ passwordHash })`.
   Expected: *"writes the exact updatedAt it is given"* goes RED (it gets today's date, six years off). **This is the test that locks the `$onUpdate` finding.**
2. Change `.where(eq(users.id, id))` to `.where(eq(users.id, passwordHash))`.
   Expected: *"writes the exact updatedAt"* goes RED — no row matched.
3. Add `email: 'mutated@example.com'` to the `set` object.
   Expected: *"changes only the password columns"* goes RED.

If any mutation stays green, the test is decorative — fix the test, not the mutation.

- [ ] **Step 8: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/repositories/users-repository.ts \
        src/modules/auth/infra/drizzle/drizzle-users-repository.ts \
        src/modules/auth/infra/in-memory/in-memory-users-repository.ts \
        tests/integration/drizzle-users-repository.spec.ts
git commit -m "feat: let the users repository replace a password hash

A command with primitives, matching how every non-insert write on
IRefreshTokensRepository is shaped, and making the wrong column
inexpressible rather than merely discouraged.

updatedAt is always sent explicitly. The column's \$onUpdate fills an
absence with the system clock but never overwrites a present value
(measured against drizzle-orm 1.0.0-rc.4), so omitting it is the one
way the injected clock silently stops being the source of truth. The
integration test writes a date in 2020 to keep that honest."
```

---

### Task 2: `ChangePasswordUseCase` and its two errors

**Files:**
- Create: `src/modules/auth/errors/invalid-current-password-error.ts`
- Create: `src/modules/auth/errors/password-unchanged-error.ts`
- Create: `src/modules/auth/use-cases/change-password.ts`
- Test: `src/modules/auth/use-cases/change-password.spec.ts`

**Interfaces:**
- Consumes: `IUsersRepository.updatePasswordHash(id, passwordHash, updatedAt)` from Task 1.
- Produces:
  - `ChangePasswordCommand { userId: string; currentPassword: string; newPassword: string }`
  - `ChangePasswordResult { accessToken: string; refreshToken: string }`
  - `new ChangePasswordUseCase(usersRepository, uow, hashProvider, tokenSigner, refreshTokenIssuer, clock)`
  - `InvalidCurrentPasswordError` (code `INVALID_CURRENT_PASSWORD`), `PasswordUnchangedError` (code `PASSWORD_UNCHANGED`)

- [ ] **Step 1: Write the two error classes**

They carry no behaviour to test on their own — `error-handler.spec.ts` already proves `BusinessRuleError → 422` with a probe class — so they are written first and exercised by the tests below.

`src/modules/auth/errors/invalid-current-password-error.ts`:

```ts
import { BusinessRuleError } from '#shared/errors/app-error'

const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
const INVALID_CURRENT_PASSWORD_MESSAGE = 'Current password is incorrect'

/**
 * The current password did not match, on a route whose caller is already
 * authenticated.
 *
 * A `BusinessRuleError` and not an `UnauthorizedError`, and the reason is
 * client behaviour rather than semantics: every serious mobile interceptor
 * treats 401 as "the access token expired", so it would refresh a perfectly
 * good token, replay the request, take another 401 and — in many interceptors —
 * sign the user out over a typo. 422 is unambiguous: the Bearer was fine, a
 * rule failed.
 *
 * The first concrete `BusinessRuleError` in the project. Until now the 422 row
 * of `STATUS_BY_CATEGORY` was reachable only by the handler's own probe.
 */
export class InvalidCurrentPasswordError extends BusinessRuleError {
  readonly code = INVALID_CURRENT_PASSWORD_CODE

  constructor() {
    super(INVALID_CURRENT_PASSWORD_MESSAGE)
  }
}
```

`src/modules/auth/errors/password-unchanged-error.ts`:

```ts
import { BusinessRuleError } from '#shared/errors/app-error'

const PASSWORD_UNCHANGED_CODE = 'PASSWORD_UNCHANGED'
const PASSWORD_UNCHANGED_MESSAGE = 'New password must differ from the current one'

/**
 * The new password equals the current one.
 *
 * Without this rule the call would be an expensive no-op that answers success:
 * every session revoked, a new family minted, and the same secret rewritten
 * under a different salt. A user who meant to confirm their password would lose
 * every other device with no explanation.
 *
 * The comparison behind it is plaintext, not a third argon2 — see the use case.
 */
export class PasswordUnchangedError extends BusinessRuleError {
  readonly code = PASSWORD_UNCHANGED_CODE

  constructor() {
    super(PASSWORD_UNCHANGED_MESSAGE)
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/modules/auth/use-cases/change-password.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { InvalidPasswordError } from '#modules/auth/errors/invalid-password-error'
import { PasswordUnchangedError } from '#modules/auth/errors/password-unchanged-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { ChangePasswordUseCase } from '#modules/auth/use-cases/change-password'
import { User } from '#modules/auth/entities/user'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const EMAIL = 'joao@example.com'

const CURRENT_PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const WRONG_PASSWORD = 'n0t-the-one!'
const WEAK_PASSWORD = 'short'

/** The fake hashes by prefixing, so a hash is recognisable and reversible. */
const HASH_PREFIX = 'hashed:'
const CURRENT_HASH = `${HASH_PREFIX}${CURRENT_PASSWORD}`
const NEW_HASH = `${HASH_PREFIX}${NEW_PASSWORD}`
const DUMMY_HASH = `${HASH_PREFIX}dummy`

const ACCESS_TOKEN = 'signed-access-token'
const OPAQUE_TOKEN = 'opaque-refresh-token'
const GENERATED_ID = 'generated-id'
const DIGEST_PREFIX = 'digest:'
const TTL_SECONDS = 3600

const NOW = new Date('2026-09-03T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')

/** Records the order in which collaborators were called. */
let callLog: string[]
const COMPARE_CALL = 'compare'
const HASH_CALL = 'hash'
const UOW_CALL = 'uow'
const UPDATE_CALL = 'updatePasswordHash'
const REVOKE_ALL_CALL = 'revokeAllForUser'
const SAVE_TOKEN_CALL = 'saveToken'

let usersRepository: InMemoryUsersRepository
let refreshTokensRepository: InMemoryRefreshTokensRepository
let useCase: ChangePasswordUseCase
let compareSpy: ReturnType<typeof vi.fn>
let hashSpy: ReturnType<typeof vi.fn>
let uowSpy: ReturnType<typeof vi.fn>

const storeUser = (passwordHash: string) => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash,
      emailVerifiedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )
}

const storedUser = () => usersRepository.users.find((user) => user.id === USER_ID)

beforeEach(() => {
  callLog = []
  usersRepository = new InMemoryUsersRepository()
  refreshTokensRepository = new InMemoryRefreshTokensRepository()

  // Wrapped so the log records the order the repositories were touched INSIDE
  // the transaction. Order is the whole point of two of the tests below.
  const trackedRepos: AuthRepos = {
    users: {
      save: (user) => usersRepository.save(user),
      findByEmail: (email) => usersRepository.findByEmail(email),
      findById: (id) => usersRepository.findById(id),
      updatePasswordHash: (id, passwordHash, updatedAt) => {
        callLog.push(UPDATE_CALL)
        return usersRepository.updatePasswordHash(id, passwordHash, updatedAt)
      },
    },
    refreshTokens: {
      save: (token) => {
        callLog.push(SAVE_TOKEN_CALL)
        return refreshTokensRepository.save(token)
      },
      findByHashForUpdate: (hash) => refreshTokensRepository.findByHashForUpdate(hash),
      markRotated: (id, replacedBy, revokedAt) =>
        refreshTokensRepository.markRotated(id, replacedBy, revokedAt),
      revoke: (id, revokedAt) => refreshTokensRepository.revoke(id, revokedAt),
      revokeFamily: (familyId, revokedAt) =>
        refreshTokensRepository.revokeFamily(familyId, revokedAt),
      revokeAllForUser: (userId, revokedAt) => {
        callLog.push(REVOKE_ALL_CALL)
        return refreshTokensRepository.revokeAllForUser(userId, revokedAt)
      },
    },
  }

  uowSpy = vi.fn((work: (repos: AuthRepos) => Promise<unknown>) => {
    callLog.push(UOW_CALL)
    return work(trackedRepos)
  })

  compareSpy = vi.fn(async (plain: string, hashed: string) => {
    callLog.push(COMPARE_CALL)
    return `${HASH_PREFIX}${plain}` === hashed
  })

  hashSpy = vi.fn(async (plain: string) => {
    callLog.push(HASH_CALL)
    return `${HASH_PREFIX}${plain}`
  })

  useCase = new ChangePasswordUseCase(
    usersRepository,
    uowSpy as unknown as IAuthUnitOfWork,
    { hash: hashSpy, compare: compareSpy, dummyHash: DUMMY_HASH },
    { sign: async () => ACCESS_TOKEN, verify: async () => ({ sub: USER_ID }) },
    new RefreshTokenIssuer(
      { opaque: () => OPAQUE_TOKEN },
      { hash: (value: string) => `${DIGEST_PREFIX}${value}` },
      { generate: () => GENERATED_ID },
      TTL_SECONDS,
    ),
    { now: () => NOW },
  )
})

const change = (overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
  useCase.execute({
    userId: USER_ID,
    currentPassword: CURRENT_PASSWORD,
    newPassword: NEW_PASSWORD,
    ...overrides,
  })

describe('ChangePasswordUseCase', () => {
  it('replaces the hash, revokes every session and issues a new pair', async () => {
    storeUser(CURRENT_HASH)

    const result = await change()

    expect(storedUser()?.passwordHash).toBe(NEW_HASH)
    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE_TOKEN })
  })

  it('runs both argon2 calls BEFORE opening the transaction', async () => {
    // The assertion is the ORDER, not the outcome. Moving either hash call
    // inside the callback keeps every other test in this file green while
    // parking a pooled connection on 15ms of CPU — §8 of the unit of work
    // design, and the one mistake this slice was warned about.
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog.indexOf(COMPARE_CALL)).toBeLessThan(callLog.indexOf(UOW_CALL))
    expect(callLog.indexOf(HASH_CALL)).toBeLessThan(callLog.indexOf(UOW_CALL))
  })

  it('revokes every session BEFORE inserting the new token', async () => {
    // revokeAllForUser revokes every row of the user whose revoked_at is null.
    // Inserting first means the brand new token is caught by that same UPDATE
    // and is born revoked: the endpoint answers 200 and the first refresh
    // answers 401.
    storeUser(CURRENT_HASH)

    await change()

    expect(callLog.indexOf(REVOKE_ALL_CALL)).toBeLessThan(callLog.indexOf(SAVE_TOKEN_CALL))
  })

  it('leaves the new token alive after the revocation', async () => {
    storeUser(CURRENT_HASH)

    await change()

    const issued = refreshTokensRepository.tokens.find(
      (token) => token.tokenHash === `${DIGEST_PREFIX}${OPAQUE_TOKEN}`,
    )
    expect(issued?.revokedAt).toBeNull()
  })

  it('rejects a wrong current password and writes nothing', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ currentPassword: WRONG_PASSWORD })).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
    expect(storedUser()?.passwordHash).toBe(CURRENT_HASH)
  })

  it('rejects a new password equal to the current one without hashing it', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ newPassword: CURRENT_PASSWORD })).rejects.toBeInstanceOf(
      PasswordUnchangedError,
    )
    expect(hashSpy).not.toHaveBeenCalled()
  })

  it('rejects a weak new password before touching the repository', async () => {
    storeUser(CURRENT_HASH)

    await expect(change({ newPassword: WEAK_PASSWORD })).rejects.toBeInstanceOf(
      InvalidPasswordError,
    )
    expect(compareSpy).not.toHaveBeenCalled()
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('reports a missing user rather than writing', async () => {
    await expect(change({ userId: MISSING_USER_ID })).rejects.toBeInstanceOf(
      UserNotFoundError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('stamps updatedAt from the injected clock', async () => {
    storeUser(CURRENT_HASH)

    await change()

    expect(storedUser()?.updatedAt).toEqual(NOW)
  })

  it('reads the clock once, so every write shares one instant', async () => {
    storeUser(CURRENT_HASH)

    await change()

    const issued = refreshTokensRepository.tokens.find(
      (token) => token.tokenHash === `${DIGEST_PREFIX}${OPAQUE_TOKEN}`,
    )
    expect(storedUser()?.updatedAt).toEqual(issued?.createdAt)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test:unit
```

Expected: FAIL — `Cannot find module '#modules/auth/use-cases/change-password'`.

- [ ] **Step 4: Write the use case**

Create `src/modules/auth/use-cases/change-password.ts`:

```ts
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { PasswordUnchangedError } from '#modules/auth/errors/password-unchanged-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Password } from '#modules/auth/value-objects/password'
import type { IClock } from '#shared/ports/clock'

/** Raw, untrusted input. `userId` comes from the verified token, never the body. */
export interface ChangePasswordCommand {
  userId: string
  currentPassword: string
  newPassword: string
}

export interface ChangePasswordResult {
  accessToken: string
  refreshToken: string
}

/**
 * Changes a user's own password, ends every session, and hands the current
 * device a fresh pair.
 *
 * **It takes the unit of work AND a repository directly, which §9 of the unit
 * of work design used to forbid outright.** That rule now forbids a direct
 * WRITE, and the reason for the amendment is visible in the ordering below:
 * `compare` needs the stored hash, so the read must precede it — and argon2 may
 * not run inside a transaction (§8). No ordering satisfies both rules with a
 * single `uow`. The read here is the only thing this repository is used for;
 * every write goes through `repos`.
 *
 * The order of the steps is normative, not stylistic. See the comments inline.
 */
export class ChangePasswordUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly clock: IClock,
  ) {}

  async execute(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    // First, so a bad payload pays neither a database read nor argon2 — the
    // same ordering `RegisterUserUseCase` documents.
    const newPassword = Password.create(command.newPassword)

    const user = await this.usersRepository.findById(command.userId)

    // Reachable: the account was deleted while an unexpired access token was
    // still in the wild. No enumeration concern — the caller owns the account.
    if (user === null) throw new UserNotFoundError()

    // Argon2 #1, outside any transaction.
    const matches = await this.hashProvider.compare(
      command.currentPassword,
      user.passwordHash,
    )
    if (!matches) throw new InvalidCurrentPasswordError()

    // Plaintext, and deliberately so: the body carries both secrets and the
    // current one was just confirmed correct, so this is exact. Running the new
    // password through `compare` against the stored hash would spend another
    // ~7ms of argon2 to answer the same question.
    //
    // After the check above, never before: a caller who mistyped the current
    // password deserves to hear that, not "it did not change".
    if (newPassword.value === command.currentPassword) throw new PasswordUnchangedError()

    // Argon2 #2, still outside.
    const passwordHash = await this.hashProvider.hash(newPassword.value)

    // Read ONCE. The same instant stamps `updated_at`, every `revoked_at`, and
    // the new token's `created_at`/`expires_at` — three columns across two
    // tables that a transaction makes atomic and three clock reads would not.
    const now = this.clock.now()

    // Cheap (random bytes plus a digest), so it could go either side; it stays
    // out because it only depends on what is already computed, and moving work
    // into a transaction without a reason is the same mistake in miniature.
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ users, refreshTokens }) => {
      await users.updatePasswordHash(user.id, passwordHash, now)

      // BEFORE the insert, always. `revokeAllForUser` revokes every row of this
      // user whose `revoked_at` is null — inserting first would let it catch
      // the token minted one line below, which would be born revoked. The
      // endpoint would answer 200 and the very next refresh would answer 401.
      await refreshTokens.revokeAllForUser(user.id, now)

      await refreshTokens.save(issued.entity)
    })

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test:unit
```

Expected: PASS — all ten tests.

- [ ] **Step 6: Falsify the tests**

One mutation at a time, reverting each:

1. Move `const passwordHash = await this.hashProvider.hash(...)` inside the `uow` callback.
   Expected: *"runs both argon2 calls BEFORE opening the transaction"* goes RED. **Every other test stays green** — which is exactly why this test exists.
2. Swap `revokeAllForUser` and `save` inside the callback.
   Expected: *"revokes every session BEFORE inserting"* and *"leaves the new token alive"* both go RED.
3. Replace `const now = this.clock.now()` with three separate `this.clock.now()` calls at each use site.
   Expected: with a fixed fake clock this stays GREEN — the fake returns the same instant. Note it and move on: the single read is enforced by review and by the comment, not by this test. **Do not add a mutable-clock test just to make this red**; it would assert the fake, not the behaviour.
4. Move the `PasswordUnchangedError` check to after `hashProvider.hash`.
   Expected: *"rejects a new password equal to the current one without hashing it"* goes RED.
5. Move `Password.create` to after `findById`.
   Expected: *"rejects a weak new password before touching the repository"* goes RED.

- [ ] **Step 7: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/errors/invalid-current-password-error.ts \
        src/modules/auth/errors/password-unchanged-error.ts \
        src/modules/auth/use-cases/change-password.ts \
        src/modules/auth/use-cases/change-password.spec.ts
git commit -m "feat: change a password, ending every session but this device

Both argon2 calls run before the transaction opens, and the revocation
runs before the insert. Neither is style: argon2 inside the callback
parks one of ten pooled connections on 15ms of CPU, and inserting
before revoking lets revokeAllForUser catch the token it just minted,
so the endpoint answers 200 and the next refresh answers 401.

Two tests assert those orderings directly rather than their outcomes,
because both mutations leave every result-shaped assertion green.

Wrong current password is 422, not 401: mobile interceptors read 401
as an expired access token, so they would refresh a good token, replay,
and sign the user out over a typo."
```

---

### Task 3: One definition of the session response

**Files:**
- Create: `src/modules/auth/infra/http/session-tokens.ts`
- Modify: `src/modules/auth/infra/http/endpoints/login.ts`
- Modify: `src/modules/auth/infra/http/endpoints/refresh.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sessionTokensSchema` — a Zod object `{ accessToken: string; refreshToken?: string }`, consumed by Task 4's endpoint.

This task changes no behaviour. The existing `login` and `refresh` integration tests are the regression net; if they stay green, the extraction is faithful.

- [ ] **Step 1: Create the shared schema**

Create `src/modules/auth/infra/http/session-tokens.ts`:

```ts
import { z } from 'zod'

/**
 * What every endpoint that hands out a session answers with: `login`, `refresh`
 * and `change-password`.
 *
 * Extracted at the third copy. It is public contract, and three literal
 * duplicates of a contract drift — one of them gains a field, the others do
 * not, and nothing fails until a client notices.
 *
 * `refreshToken` is absent in cookie mode. Optional rather than two separate
 * schemas because declaring a status makes the serializer VALIDATE the body
 * against it (§7 of `ARCHITECTURE.md`), and a shape it cannot serialize answers
 * 500 instead of the intended status.
 */
export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
})
```

- [ ] **Step 2: Point `login.ts` at it**

Delete the local `okSchema` declaration (the `z.object({ accessToken … })` block with its comment) and add the import:

```ts
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
```

Then replace `[OK_STATUS]: okSchema` with `[OK_STATUS]: sessionTokensSchema`.

- [ ] **Step 3: Point `refresh.ts` at it**

Same edit: delete the local `okSchema` (including the comment that points at `login.ts`, which no longer has one), add the same import, and replace the response entry.

- [ ] **Step 4: Run the tests**

```bash
pnpm test
```

Expected: PASS. `tests/integration/login.spec.ts` and `tests/integration/refresh-token.spec.ts` are the proof that the wire contract did not move.

- [ ] **Step 5: Falsify the extraction**

Remove `.optional()` from `refreshToken` in the shared schema.
Expected: the cookie-mode cases of the login and refresh integration tests go RED — a body without `refreshToken` no longer serializes. Revert.

This confirms the two endpoints really consume the shared schema rather than a stale copy.

- [ ] **Step 6: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/http/session-tokens.ts \
        src/modules/auth/infra/http/endpoints/login.ts \
        src/modules/auth/infra/http/endpoints/refresh.ts
git commit -m "refactor: give the session response one definition

{ accessToken, refreshToken? } was duplicated verbatim in login and
refresh, the second carrying a comment pointing at the first. The
password change endpoint would have been the third copy.

It is public contract, and duplicated contracts drift silently."
```

---

### Task 4: The endpoint, its ceiling, and the wiring

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/change-password.ts`
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/constants.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Modify: `src/modules/auth/infra/http/refresh-cookie.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ChangePasswordUseCase` (Task 2), `sessionTokensSchema` (Task 3).
- Produces: `POST /auth/password`; `container.changePassword`; `container.passwordChangeRateLimit: { max: number; timeWindow: number }`.

Route wiring has no unit test in this project — the endpoints are proved by `tests/integration/`, which is Task 5. This task therefore ends at the gates, and Task 5 is what makes it green in anger.

- [ ] **Step 1: Add the two env variables**

In `src/modules/auth/config.ts`, beside the login rate limit defaults:

```ts
/**
 * Ten attempts a minute from one address, the same numbers as the login route
 * and for the same reason: a request here carries a password guess, it counts
 * REQUESTS rather than failures, and the number sits far above human retry and
 * far below anything useful to an attacker.
 *
 * Its own variables rather than reusing the login ones, because the two
 * ceilings may need to diverge — and a field named `login` declared on a route
 * that is not login is a comment that lies.
 *
 * The vector this closes is concrete: stolen access token -> password changed
 * -> account taken. Without it the route would inherit only the global 300/min.
 */
export const DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS = 60
```

And in `authEnvSchema`, after the login entries:

```ts
  // `.positive()` for the reason it is used everywhere else here: a ceiling of
  // zero would refuse every password change, and rejecting zero is what rejects
  // an empty value.
  PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS),
  PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS),
```

- [ ] **Step 2: Extend the test env fixture and `.env.example`**

In `src/infra/config/fixtures/test-env.ts`, import the two new defaults from `#modules/auth/config` alongside the existing ones and add:

```ts
  PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS:
    DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS,
  PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS:
    DEFAULT_PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS,
```

The fixture is typed `Env`, so omitting them is a compile error — that is the intended safety net.

In `.env.example`, after the login block:

```
# The password change route's own ceiling. Same reasoning as the login one: the
# request carries a password guess, and it counts requests, not failures.
PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS=10
PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS=60
```

- [ ] **Step 3: Add the status constant**

In `src/modules/auth/infra/http/constants.ts`, between `CONFLICT_STATUS` and `TOO_MANY_REQUESTS_STATUS`:

```ts
/**
 * A rule failed on a request that was well-formed and properly authenticated.
 * The password change endpoint is the first to produce it from a domain error.
 */
export const UNPROCESSABLE_ENTITY_STATUS = 422
```

- [ ] **Step 4: Wire the container**

In `src/modules/auth/container.ts`, import the use case:

```ts
import { ChangePasswordUseCase } from './use-cases/change-password.js'
```

Add to the returned object, after `logoutAll`:

```ts
    changePassword: new ChangePasswordUseCase(
      usersRepository,
      uow,
      hashProvider,
      tokenSigner,
      refreshTokenIssuer,
      clock,
    ),
```

And beside `loginRateLimit`:

```ts
    /**
     * The password change route declares its own ceiling, like login.
     * Milliseconds because that is what the limiter's `timeWindow` takes.
     */
    passwordChangeRateLimit: {
      max: config.PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
```

Note that `usersRepository` is passed **and** `uow`. That combination is what §9 of the unit of work design now permits for reads only; the use case's own comment carries the justification.

- [ ] **Step 5: Write the endpoint**

Create `src/modules/auth/infra/http/endpoints/change-password.ts`:

```ts
import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  EXAMPLE_PASSWORD,
  NOT_FOUND_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  clearRefreshCookie,
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '#modules/auth/value-objects/password'

const CHANGE_PASSWORD_PATH = '/password'
const CHANGE_PASSWORD_SUMMARY = 'Change this account password'
const CHANGE_PASSWORD_DESCRIPTION =
  'Replaces the password of the authenticated user, who must present the ' +
  'current one. Every session on every device is revoked, and this device ' +
  'receives a fresh token pair in the response. Access tokens already issued ' +
  'stay valid until they expire — decision 11.'

/**
 * A new example, distinct from `EXAMPLE_PASSWORD`: the two fields must differ
 * or "Try it out" in Swagger UI sends a request that answers 422.
 */
const EXAMPLE_NEW_PASSWORD = 'ev3nS4fer!'

const MIN_SUBMITTED_PASSWORD_LENGTH = 1

/**
 * `currentPassword` checks PRESENCE, not policy — the same call login makes.
 * Enforcing the rules on it would answer 400 where the right answer is 422,
 * telling an attacker the guess failed the RULES rather than the password, and
 * an account created under a looser policy must stay able to change it. The
 * ceiling stays for the unrelated reason: without one, a 10 MB body becomes
 * argon2 over 10 MB.
 *
 * `newPassword` carries the full policy, exactly as `register` does. Validating
 * here as well as in the `Password` value object is deliberate: this is what
 * gives the client a 400 with a per-field `details` array and what publishes
 * the policy in the OpenAPI document, while the value object keeps the use case
 * safe for the non-HTTP entrypoints of decision 10.
 */
const bodySchema = z.object({
  currentPassword: z
    .string()
    .min(MIN_SUBMITTED_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .meta({ examples: [EXAMPLE_PASSWORD] }),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .regex(PASSWORD_POLICY_PATTERN)
    .meta({ examples: [EXAMPLE_NEW_PASSWORD] }),
  /**
   * The SECOND endpoint that needs this. Like `login`, it hands back a refresh
   * token without having received one, so nothing in the request reveals which
   * channel the client wants.
   */
  refreshTransport: refreshTransportSchema,
})

export const changePasswordRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    CHANGE_PASSWORD_PATH,
    {
      preHandler: guard,
      /**
       * Tighter than the global ceiling, like login: this request carries a
       * password guess. The vector is a stolen access token being escalated
       * into a taken account.
       */
      config: { rateLimit: container.passwordChangeRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: CHANGE_PASSWORD_SUMMARY,
        description: CHANGE_PASSWORD_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [NOT_FOUND_STATUS]: errorResponseSchema,
          [UNPROCESSABLE_ENTITY_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.changePassword.execute({
        // From the verified token, never the body: taking a userId from the
        // payload here would let any authenticated caller reset anyone.
        userId: getPrincipal(request).id,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
      })

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      // Body mode clears any cookie that was there: it now points at a family
      // that was just revoked, and leaving it in the browser only produces a
      // confusing 401 on the next refresh. Same reasoning as `logout-all`.
      clearRefreshCookie(reply)

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}
```

- [ ] **Step 6: Register the route**

In `src/modules/auth/infra/http/routes.ts`, add the import beside the others:

```ts
import { changePasswordRoute } from './endpoints/change-password.js'
```

and the registration after `logoutAllRoute`:

```ts
  await app.register(changePasswordRoute, { container, guard })
```

- [ ] **Step 7: Amend the refresh-cookie comment**

In `src/modules/auth/infra/http/refresh-cookie.ts`, the doc comment on `refreshTransportSchema` opens with *"Which channel carries the refresh token back. Only `login` needs it: every other endpoint learns the channel from the request that arrived."* That is no longer true. Replace those two sentences with:

```ts
/**
 * Which channel carries the refresh token back. Needed by the two endpoints
 * that hand out a refresh token WITHOUT having received one — `login` and
 * `change-password` — because nothing in their requests reveals the channel.
 * `refresh` and `logout` learn it from the token that arrived.
 *
```

Leave the rest of the comment (the paragraph about decision 12) as it is.

- [ ] **Step 8: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all green. The existing suite must not move; the new route has no test yet.

- [ ] **Step 9: Manually confirm the route exists**

```bash
docker compose up -d
pnpm dev
```

In another terminal:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/auth/password \
  -H 'content-type: application/json' -d '{}'
```

Expected: `401` — the guard rejects a request with no Bearer, which also proves the route is mounted (a missing route would answer `404`). Stop `pnpm dev`.

- [ ] **Step 10: Commit**

```bash
git add src/modules/auth/infra/http/endpoints/change-password.ts \
        src/modules/auth/infra/http/routes.ts \
        src/modules/auth/infra/http/constants.ts \
        src/modules/auth/infra/http/refresh-cookie.ts \
        src/modules/auth/config.ts \
        src/modules/auth/container.ts \
        src/infra/config/fixtures/test-env.ts \
        .env.example
git commit -m "feat: expose POST /auth/password

POST and not PUT: the call is not idempotent — each one revokes every
session and mints a new family.

Its own rate limit ceiling, with its own variables rather than reusing
the login ones, because the two may need to diverge and a field named
login on a route that is not login is a comment that lies.

This is the second endpoint that returns a refresh token without having
received one, so the refresh-cookie comment claiming only login needs a
transport choice is amended."
```

---

### Task 5: End-to-end proof against real Postgres

**Files:**
- Test: `tests/integration/change-password.spec.ts`

**Interfaces:**
- Consumes: `POST /auth/password` from Task 4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/change-password.spec.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported: these values ARE the wire contract, and
// importing them would make the assertions tautological.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const CHANGE_PASSWORD_PATH = '/auth/password'
const POST_METHOD = 'POST'
const AUTHORIZATION_HEADER = 'authorization'
const BEARER_PREFIX = 'Bearer '

const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
const PASSWORD_UNCHANGED_CODE = 'PASSWORD_UNCHANGED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const NEW_PASSWORD = 'ev3n-b3tter!'
const WRONG_PASSWORD = 'n0t-the-one!'

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp(env)
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(users)
  await app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
})

const login = async (password: string = PASSWORD) =>
  app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password },
  })

const loggedIn = async () => {
  const response = await login()
  return response.json() as { accessToken: string; refreshToken: string }
}

const changePassword = (accessToken: string, payload: object = {}) =>
  app.inject({
    method: POST_METHOD,
    url: CHANGE_PASSWORD_PATH,
    headers: { [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${accessToken}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...payload },
  })

const refreshWith = (refreshToken: string) =>
  app.inject({ method: POST_METHOD, url: REFRESH_PATH, payload: { refreshToken } })

describe('POST /auth/password', () => {
  it('kills the old refresh token and returns one that works', async () => {
    const before = await loggedIn()

    const response = await changePassword(before.accessToken)
    expect(response.statusCode).toBe(OK_STATUS_CODE)

    const after = response.json() as { accessToken: string; refreshToken: string }

    expect((await refreshWith(before.refreshToken)).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
    // The one that dies if the revocation runs after the insert: the new token
    // would be caught by the same UPDATE and born revoked.
    expect((await refreshWith(after.refreshToken)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('ends the sessions of other devices too', async () => {
    const phone = await loggedIn()
    const tablet = await loggedIn()

    await changePassword(phone.accessToken)

    expect((await refreshWith(tablet.refreshToken)).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
  })

  it('accepts the new password at login and refuses the old one', async () => {
    const session = await loggedIn()

    await changePassword(session.accessToken)

    expect((await login(PASSWORD)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(NEW_PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('answers 422 with INVALID_CURRENT_PASSWORD for a wrong current password', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      currentPassword: WRONG_PASSWORD,
    })

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    const body = response.json() as { error: { code: string; traceId: string } }
    expect(body.error.code).toBe(INVALID_CURRENT_PASSWORD_CODE)
    expect(body.error.traceId).toBeTruthy()
  })

  it('answers 422 with PASSWORD_UNCHANGED when the new password is the current one', async () => {
    const session = await loggedIn()

    const response = await changePassword(session.accessToken, {
      newPassword: PASSWORD,
    })

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    const body = response.json() as { error: { code: string } }
    expect(body.error.code).toBe(PASSWORD_UNCHANGED_CODE)
  })

  it('leaves the session standing when the current password is wrong', async () => {
    // A failed attempt must not be a way to sign somebody out.
    const session = await loggedIn()

    await changePassword(session.accessToken, { currentPassword: WRONG_PASSWORD })

    expect((await refreshWith(session.refreshToken)).statusCode).toBe(OK_STATUS_CODE)
    expect((await login(PASSWORD)).statusCode).toBe(OK_STATUS_CODE)
  })

  it('refuses a request with no access token', async () => {
    const response = await app.inject({
      method: POST_METHOD,
      url: CHANGE_PASSWORD_PATH,
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })
})
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
docker compose up -d
pnpm test:integration
```

Expected: PASS. They exercise code written in Tasks 1–4, so green here is the point; the falsification below is what proves they are real.

- [ ] **Step 3: Falsify the tests**

One mutation at a time, reverting each:

1. In `change-password.ts` (use case), swap `revokeAllForUser` and `save` inside the callback.
   Expected: *"kills the old refresh token and returns one that works"* goes RED on the **second** assertion — the new token answers 401. This is the end-to-end twin of the unit ordering test.
2. Delete `await refreshTokens.revokeAllForUser(user.id, now)` entirely.
   Expected: *"ends the sessions of other devices too"* goes RED.
3. In the use case, move the `uow` call before the `if (!matches) throw` line.
   Expected: *"leaves the session standing when the current password is wrong"* goes RED.
4. In `change-password.ts` (endpoint), remove `preHandler: guard`.
   Expected: *"refuses a request with no access token"* goes RED — with a 500, because `getPrincipal` throws on an unguarded route.

- [ ] **Step 4: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add tests/integration/change-password.spec.ts
git commit -m "test: prove the password change end to end

The load-bearing case is that the refresh token returned by the change
still works. Inverting the two writes inside the transaction leaves
every other assertion green and breaks only that one, which is the
whole reason it is asserted separately from the old token dying.

Also proves a failed attempt is not a way to sign somebody out."
```

---

### Task 6: Documentation amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-unit-of-work-design.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/superpowers/2026-09-03-handoff-password-change.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1–5.
- Produces: nothing consumed by later tasks.

These are the amendments §12 of the spec requires. They are last because they describe what was built; doing them first would risk documenting something the implementation then changed.

- [ ] **Step 1: Amend §9 of the unit of work design**

In `docs/superpowers/specs/2026-08-29-unit-of-work-design.md`, §9 currently ends with the bolded rule *"Regra: use case que recebe o UoW não recebe repositório direto."* Replace that sentence and keep the surrounding prose, then append:

```markdown
**Regra: use case que recebe o UoW não faz ESCRITA por repositório direto.**
Ele acessa tudo pelo `repos` do callback.

> **Emendada em 2026-09-03, pela fatia 9.** A regra original proibia *receber* o
> repositório, e a troca de senha não consegue obedecê-la: o `compare` do argon2
> precisa do hash guardado, então a leitura tem de vir antes dele — e o §8
> proíbe argon2 dentro da transação. Não existe ordem que satisfaça as duas
> regras com um único `uow`.
>
> O estrago que o §9 descreve é inteiramente de uma **escrita** fora da
> transação, que commita sozinha e quebra a atomicidade. Uma **leitura** fora
> não tem esse estrago: o `UPDATE ... WHERE id` da fatia 9 é incondicional, e
> duas trocas simultâneas do mesmo usuário terminam com a última vencendo — as
> duas conheciam a senha atual.
>
> **O custo, dito por inteiro:** a regra deixa de ser visível na assinatura do
> construtor. Antes, "tem `uow` **e** repositório" era o alarme, legível sem
> abrir o corpo; agora é preciso ler o corpo para saber se o repositório direto
> está sendo lido ou escrito. Continua invisível ao lint e ao compilador.
```

- [ ] **Step 2: Add the `$onUpdate` finding to `ARCHITECTURE.md`**

In `ARCHITECTURE.md` §11, section *"Bibliotecas que falham em silêncio"*, append one more blockquote alongside the existing ones:

```markdown
> **`$onUpdate` do Drizzle preenche a ausência, não sobrescreve a presença — e o
> perigo é o contrário do que parece.** Medido em 2026-09-03 no
> `drizzle-orm@1.0.0-rc.4`: `set({ passwordHash, updatedAt: D })` grava `D`, e
> `set({ passwordHash })` grava `new Date()`. A causa é o `??` do
> `buildUpdateSet` em `pg-core/dialect.js`. Ou seja: um valor vindo do `IClock`
> **não** é descartado — mas **omitir** a coluna deixa o relógio do sistema
> entrar em silêncio, e em produção ninguém nota, porque os dois relógios
> coincidem. Quem nota é o teste que avança um relógio falso. Por isso o
> repositório manda `updated_at` sempre, explicitamente, e o teste de integração
> grava uma data de 2020.
```

- [ ] **Step 3: Correct the handoff**

At the very top of `docs/superpowers/2026-09-03-handoff-password-change.md`, immediately under the `#` title, insert:

```markdown
> ⚠️ **Corrigido em 2026-09-03 pela fatia que ele descreve.** Três afirmações
> deste documento foram medidas e refutadas — o `$onUpdate` do §4.1, o
> trade-off da sessão preservada no §5 e o estado do repositório no §7. As
> medições estão no §3 de
> [`specs/2026-09-03-password-change-design.md`](specs/2026-09-03-password-change-design.md).
> Leia aquela seção antes de agir sobre qualquer parte deste handoff.
```

- [ ] **Step 4: Amend decision 11**

In `docs/DECISIONS.md`, inside `### 11 — Auth: access JWT curto + refresh opaco rotativo`, add one more amendment blockquote after the existing ones:

```markdown
> **Emendada em 2026-09-03, pela fatia 9.** A troca de senha é o primeiro
> consumidor real da revogação: ela revoga **todas** as famílias e emite um par
> novo para o aparelho que trocou, na mesma transação e nessa ordem — a
> revogação antes do insert, porque `revokeAllForUser` apanha toda linha viva do
> usuário e pegaria o token recém-inserido.
>
> Preservar a sessão atual foi considerado e descartado. O argumento de que
> preservá-la protegeria o atacante não separa os desenhos: quem trocou a senha
> a conhece, e faz login de novo em qualquer um deles. A escolha foi de UX e de
> superfície de contrato.
>
> Senha atual errada responde **422**, não 401, e a razão é o cliente: um
> interceptor que lê 401 como "access token venceu" refrescaria um token bom,
> repetiria a request e deslogaria o usuário por um erro de digitação.
```

- [ ] **Step 5: Verify the links resolve**

```bash
ls docs/superpowers/specs/2026-09-03-password-change-design.md
grep -n "password-change-design" docs/superpowers/2026-09-03-handoff-password-change.md
```

Expected: the file exists and the handoff reference is present.

- [ ] **Step 6: Run every gate, separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Documentation does not affect them, but a green run is what the final commit claims.

- [ ] **Step 7: Run the architecture audit**

```
Use the architecture-audit skill with --base main
```

Expected: 0 findings in both scopes. It specifically catches comments that lie — the amended `refresh-cookie.ts` comment from Task 4 and the §9 rule are exactly what it should be checking.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-29-unit-of-work-design.md \
        docs/superpowers/2026-09-03-handoff-password-change.md \
        docs/DECISIONS.md \
        ARCHITECTURE.md
git commit -m "docs: amend the rules the password change slice moved

The unit of work rule now forbids a direct WRITE rather than a direct
repository: no ordering satisfies both 'read before compare' and 'no
argon2 inside a transaction' with a single uow. The cost is stated —
the rule is no longer visible in the constructor signature.

The handoff gets a correction banner, because three of its claims were
measured and refuted and it stays in the repository for future sessions
to read."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §4.1/§6.2 → Tasks 2 and 5; §4.2 → Task 2; §4.3/§4.4 → Task 2's errors; §4.5 → Task 4; §5 → Tasks 3 and 4; §6.0 → Task 2 (the single `clock.now()` and its test); §7 → Task 2's class comment and Task 6's amendment; §8 → Task 1; §10 → Tasks 1, 2 and 5; §12 → Task 6.

**One known gap, deliberate.** §6.0 (the clock read once) has a test that a fixed fake clock cannot falsify — Task 2, Step 6, mutation 3 says so explicitly rather than pretending otherwise. Making it falsifiable would require a clock that returns a different instant per call, which asserts the fake rather than the behaviour.

**Type consistency.** `updatePasswordHash(id, passwordHash, updatedAt)` is spelled identically in Task 1's contract, both adapters, Task 2's use case and Task 2's tracked repos. `sessionTokensSchema` is spelled identically in Tasks 3 and 4. `changePassword` and `passwordChangeRateLimit` are spelled identically in Task 4's container and endpoint. `ChangePasswordCommand` fields (`userId`, `currentPassword`, `newPassword`) match between Task 2 and Task 4's handler.
