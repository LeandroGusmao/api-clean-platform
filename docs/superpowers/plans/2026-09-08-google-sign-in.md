# Google Sign-In (client-driven) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /auth/google`, a client-driven Google sign-in that verifies a Google ID token against Google's public JWKS and issues the project's own session, creating or linking a local account per the three scenarios of `DECISIONS.md §6`.

**Architecture:** A new `IGoogleIdentityVerifier` port with a `jose`-backed adapter turns an ID token into `{ subject, email }` or throws one generic error. A new `SignInWithGoogleUseCase` branches on whether the Google `sub` is already linked (`federated_identities`), whether the email already has a local user, and whether that user has a password — creating a passwordless verified account, requiring the app password to link over a password account, or fast-pathing an existing link. Sessions are the same `{ accessToken, refreshToken? }` as `login`. `users.password_hash` becomes nullable for federated-only accounts.

**Tech Stack:** TypeScript (Node), Fastify 5, Drizzle ORM 1.0.0-rc.4 + Postgres, `jose` 6.2.3 (JWKS verification — already a dependency), Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-08-google-sign-in-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- **Language:** all code (identifiers, strings, comments, messages) in **English**. Markdown may be Portuguese.
- **No magic strings/numbers:** extract to named `UPPER_SNAKE_CASE` constants, placed next to use, or in a module `constants.ts` when shared. Exception: schema files spell table/column/index names inline **unless** the name is read from another file, which makes it an exported constant declared in the schema file.
- **Comments** explain the code they sit on (what/why), never task or review history; cite the spec, do not re-argue it; stay local to the file.
- **TDD:** write the failing test, watch it fail, minimal implementation, watch it pass, commit. Frequent commits.
- **Entities:** state in `#` private fields; `Object.freeze` in the constructor; clone `Date` on the way in and out; `JSON.stringify(entity)` must yield `{}`. Build via `create` (validates), rehydrate via `fromTrusted` (no re-validation).
- **Time:** every timestamp comes from injected `IClock` — never `new Date()` in domain or use-case code (R7).
- **Transactions:** argon2 (`hashProvider.hash` / `.compare`) must never run inside a `uow` callback (§8 of the unit-of-work design). Reads that feed argon2 precede it, outside the transaction.
- **Repositories:** on a caught driver error, throw `toPersistenceError(error)` — never re-throw what the driver gave you (it glues bound parameters into its message).
- **Oracle discipline:** where reporting a distinct reason would let an anonymous caller enumerate accounts or probe a secret, collapse every failure mode into one `throw` of one error.
- **Use-case constructors:** take `Pick<Interface, 'usedMethod'>` of each repository, so an unintended write is a compile error.
- **Commands:** `pnpm test:unit <file>`, `pnpm test:integration <file>`, `pnpm typecheck`, `pnpm lint` (`pnpm lint:fix` to autofix). Integration tests need Postgres up: `docker compose up -d`.

---

## File Structure

**New — domain / ports:**
- `src/modules/auth/entities/federated-identity.ts` — the link entity + `GOOGLE_PROVIDER` constant + `FederatedProvider` type.
- `src/modules/auth/ports/google-identity-verifier.ts` — `IGoogleIdentityVerifier` + `GoogleIdentity`.
- `src/modules/auth/repositories/federated-identities-repository.ts` — `IFederatedIdentitiesRepository`.
- `src/modules/auth/errors/invalid-google-identity-error.ts` — 401, `INVALID_GOOGLE_IDENTITY`.
- `src/modules/auth/errors/google-link-requires-password-error.ts` — 409, `GOOGLE_LINK_REQUIRES_PASSWORD`.
- `src/modules/auth/errors/google-sign-in-conflict-error.ts` — 409, `GOOGLE_SIGN_IN_CONFLICT`.
- `src/modules/auth/use-cases/sign-in-with-google.ts` — the orchestration.

**New — infra:**
- `src/modules/auth/infra/providers/jose-google-identity-verifier.ts` — the adapter.
- `src/modules/auth/infra/drizzle/schema/federated-identities.ts` — table.
- `src/modules/auth/infra/drizzle/federated-identity-mapper.ts` — row ↔ entity.
- `src/modules/auth/infra/drizzle/drizzle-federated-identities-repository.ts` — adapter.
- `src/modules/auth/infra/in-memory/in-memory-federated-identities-repository.ts` — unit-test adapter.
- `src/modules/auth/infra/http/endpoints/sign-in-with-google.ts` — the route.
- `drizzle/<timestamp>_users_password_hash_nullable/` — generated in Task 2 (`ALTER COLUMN ... DROP NOT NULL`).
- `drizzle/<timestamp>_add_federated_identities/` — generated in Task 3 (`CREATE TABLE` + indexes).

**New — tests:**
- `src/modules/auth/entities/federated-identity.spec.ts`
- `src/modules/auth/use-cases/sign-in-with-google.spec.ts`
- `tests/integration/setup/google-jwks.ts` — helper: RS256 keypair, ephemeral JWKS HTTP server, test ID-token signer.
- `tests/integration/federated-identities-schema.spec.ts`
- `tests/integration/drizzle-federated-identities-repository.spec.ts`
- `tests/integration/jose-google-identity-verifier.spec.ts`
- `tests/integration/sign-in-with-google.spec.ts`

**Modified:**
- `src/modules/auth/entities/user.ts` (+ `.spec.ts`) — `createFederated`, `passwordHash: string | null`.
- `src/modules/auth/infra/drizzle/schema/users.ts` — drop `.notNull()` on `passwordHash`.
- `src/modules/auth/repositories/pending-registrations-repository.ts` (+ Drizzle, in-memory, `noop-auth-repos.ts`) — `deleteAllByEmail`.
- `src/modules/auth/repositories/unit-of-work.ts` — `AuthRepos.federatedIdentities` + doctrine comment.
- `src/modules/auth/infra/drizzle/auth-repositories.ts` — build the new repo.
- `src/modules/auth/config.ts` — `GOOGLE_CLIENT_ID`, `GOOGLE_JWKS_URI`, `GOOGLE_SIGN_IN_RATE_LIMIT_*` + `DEFAULT_*`.
- `src/infra/config/fixtures/test-env.ts` + `vitest.config.ts` — the new env vars.
- `src/modules/auth/container.ts` — verifier, use case, rate limit, repo.
- `src/modules/auth/infra/http/routes.ts` — one line.
- `src/modules/auth/infra/http/constants.ts` — `CONFLICT_STATUS = 409` (absent today).
- `src/modules/auth/use-cases/login-user.ts` (+ `.spec.ts`) — comment + a null-hash test case.
- `src/modules/auth/use-cases/change-password.ts` (+ `.spec.ts`) — null-hash guard.
- `src/modules/auth/notifications/emails.ts` (+ `.spec.ts`) — `googleAccountLinkedEmail`.
- `src/modules/auth/README.md`, `docs/DECISIONS.md` (decision 31), `docs/TODO.md`.
- `tests/integration/users-schema.spec.ts` — `password_hash` nullable.
- `tests/integration/drizzle-pending-registrations-repository.spec.ts` — `deleteAllByEmail`.
- `.env.example`, `docs/local.md` — `GOOGLE_CLIENT_ID`.

---

## Task 1: `FederatedIdentity` entity

**Files:**
- Create: `src/modules/auth/entities/federated-identity.ts`
- Test: `src/modules/auth/entities/federated-identity.spec.ts`

**Interfaces:**
- Consumes: `Email` from `#modules/auth/value-objects/email`.
- Produces:
  - `type FederatedProvider = 'google'`
  - `const GOOGLE_PROVIDER: FederatedProvider`
  - `interface CreateFederatedIdentityProps { id: string; userId: string; provider: FederatedProvider; providerUserId: string; emailAtLink: Email; now: Date }`
  - `interface TrustedFederatedIdentityProps { id: string; userId: string; provider: FederatedProvider; providerUserId: string; emailAtLink: Email; createdAt: Date }`
  - `class FederatedIdentity` with `static create(CreateFederatedIdentityProps): FederatedIdentity`, `static fromTrusted(TrustedFederatedIdentityProps): FederatedIdentity`, getters `id`, `userId`, `provider`, `providerUserId`, `emailAtLink`, `createdAt`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/auth/entities/federated-identity.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { Email } from '#modules/auth/value-objects/email'

const ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const PROVIDER_USER_ID = 'google-subject-1234567890'
const EMAIL_TEXT = 'ana@example.com'
const NOW = new Date('2026-09-08T12:00:00.000Z')
const EMPTY_SERIALIZATION = '{}'
const MUTATED_YEAR = 1970

const created = () =>
  FederatedIdentity.create({
    id: ID,
    userId: USER_ID,
    provider: GOOGLE_PROVIDER,
    providerUserId: PROVIDER_USER_ID,
    emailAtLink: Email.fromTrusted(EMAIL_TEXT),
    now: new Date(NOW),
  })

describe('FederatedIdentity.create', () => {
  it('stamps createdAt from the injected clock', () => {
    expect(created().createdAt).toEqual(NOW)
  })

  it('keeps every field it was given', () => {
    const identity = created()

    expect(identity.id).toBe(ID)
    expect(identity.userId).toBe(USER_ID)
    expect(identity.provider).toBe(GOOGLE_PROVIDER)
    expect(identity.providerUserId).toBe(PROVIDER_USER_ID)
    expect(identity.emailAtLink.value).toBe(EMAIL_TEXT)
  })
})

describe('FederatedIdentity.fromTrusted', () => {
  it('rehydrates every field from a trusted row', () => {
    const createdAt = new Date('2026-08-19T10:00:00.000Z')

    const identity = FederatedIdentity.fromTrusted({
      id: ID,
      userId: USER_ID,
      provider: GOOGLE_PROVIDER,
      providerUserId: PROVIDER_USER_ID,
      emailAtLink: Email.fromTrusted(EMAIL_TEXT),
      createdAt,
    })

    expect(identity.id).toBe(ID)
    expect(identity.createdAt).toEqual(createdAt)
  })
})

describe('FederatedIdentity serialization', () => {
  it('serializes to an empty object, so providerUserId cannot leak', () => {
    expect(JSON.stringify(created())).toBe(EMPTY_SERIALIZATION)
  })
})

describe('FederatedIdentity immutability', () => {
  it('does not let a caller mutate createdAt through the getter', () => {
    const identity = created()

    identity.createdAt.setFullYear(MUTATED_YEAR)

    expect(identity.createdAt).toEqual(NOW)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit src/modules/auth/entities/federated-identity.spec.ts`
Expected: FAIL — cannot find module `#modules/auth/entities/federated-identity`.

- [ ] **Step 3: Write the entity**

Create `src/modules/auth/entities/federated-identity.ts`:

```ts
import type { Email } from '#modules/auth/value-objects/email'

/**
 * `Object.freeze` is shallow: it locks the bindings, not the objects behind
 * them. Copying dates in and out is what makes the immutability this class
 * claims actually hold — the same reasoning as in `pending-registration.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

/** The identity providers this module federates with. A closed set. */
export type FederatedProvider = 'google'

/** The only provider wired today. Read by the use case and the repository. */
export const GOOGLE_PROVIDER: FederatedProvider = 'google'

export interface CreateFederatedIdentityProps {
  id: string
  userId: string
  provider: FederatedProvider
  /** The provider's stable subject id — Google's `sub`. */
  providerUserId: string
  /** The address the provider asserted when the link was made. */
  emailAtLink: Email
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
}

/** The complete state of an already-persisted row. See `User.fromTrusted`. */
export interface TrustedFederatedIdentityProps {
  id: string
  userId: string
  provider: FederatedProvider
  providerUserId: string
  emailAtLink: Email
  createdAt: Date
}

/**
 * A link between a local user and an identity a provider vouches for. It is a
 * recorded fact: it does not expire, and nothing about it changes after the
 * insert — unlinking, when it lands, is a row delete.
 *
 * State lives in `#` private fields, non-enumerable at runtime:
 * `JSON.stringify(identity)` yields `{}`, so `providerUserId` cannot escape
 * through an accidental `reply.send(identity)` or `log.info({ identity })`.
 */
export class FederatedIdentity {
  readonly #id: string
  readonly #userId: string
  readonly #provider: FederatedProvider
  readonly #providerUserId: string
  readonly #emailAtLink: Email
  readonly #createdAt: Date

  private constructor(props: TrustedFederatedIdentityProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#provider = props.provider
    this.#providerUserId = props.providerUserId
    this.#emailAtLink = props.emailAtLink
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  static create(props: CreateFederatedIdentityProps): FederatedIdentity {
    return new FederatedIdentity({
      id: props.id,
      userId: props.userId,
      provider: props.provider,
      providerUserId: props.providerUserId,
      emailAtLink: props.emailAtLink,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedFederatedIdentityProps): FederatedIdentity {
    return new FederatedIdentity(props)
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get provider(): FederatedProvider {
    return this.#provider
  }

  get providerUserId(): string {
    return this.#providerUserId
  }

  get emailAtLink(): Email {
    return this.#emailAtLink
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit src/modules/auth/entities/federated-identity.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/entities/federated-identity.ts src/modules/auth/entities/federated-identity.spec.ts
git commit -m "feat(auth): add the FederatedIdentity entity"
```

---

## Task 2: Nullable `password_hash` — entity, schema, mapper, login, change-password

This is one atomic unit: `passwordHash` becoming `string | null` in the entity
breaks `user-mapper.ts` and `change-password.ts` compilation, so the schema, the
mapper, and the two consuming use cases all move with it. The `federated_identities`
table is Task 3 (its own migration).

**Files:**
- Modify: `src/modules/auth/entities/user.ts` + `src/modules/auth/entities/user.spec.ts`
- Modify: `src/modules/auth/infra/drizzle/schema/users.ts`
- Modify: `src/modules/auth/infra/drizzle/user-mapper.ts` (verify; likely no code change)
- Modify: `src/modules/auth/use-cases/login-user.ts` + `src/modules/auth/use-cases/login-user.spec.ts`
- Modify: `src/modules/auth/use-cases/change-password.ts` + `src/modules/auth/use-cases/change-password.spec.ts`
- Modify: `tests/integration/users-schema.spec.ts`
- Create: migration folder via `pnpm db:generate` (the `DROP NOT NULL` only)

**Interfaces:**
- Consumes: `Email`; existing `IHashProvider` (`compare`, `dummyHash`), `InvalidCurrentPasswordError`, `InvalidCredentialsError`.
- Produces:
  - `TrustedUserProps.passwordHash: string | null`; `User.prototype.passwordHash` getter → `string | null`.
  - `interface CreateFederatedUserProps { id: string; email: Email; now: Date }`
  - `User.createFederated(CreateFederatedUserProps): User` — verified, `passwordHash === null`.
  - `User.create` and `CreateUserProps` unchanged.
  - `users.password_hash` column nullable at the DB.
  - No new HTTP/use-case surface — `login` and `change-password` gain guards only.

- [ ] **Step 1: Write the failing unit tests**

Append to `src/modules/auth/entities/user.spec.ts` (reuse the file's `ID`, `EMAIL`, `NOW`):

```ts
describe('User.createFederated', () => {
  it('is born verified: the provider has already proven the email', () => {
    const user = User.createFederated({ id: ID, email: Email.create(EMAIL), now: new Date(NOW) })
    expect(user.emailVerifiedAt).toEqual(NOW)
  })

  it('has no password hash — a federated account has no password', () => {
    const user = User.createFederated({ id: ID, email: Email.create(EMAIL), now: new Date(NOW) })
    expect(user.passwordHash).toBeNull()
  })

  it('stamps createdAt and updatedAt from the injected clock', () => {
    const user = User.createFederated({ id: ID, email: Email.create(EMAIL), now: new Date(NOW) })
    expect(user.createdAt).toEqual(NOW)
    expect(user.updatedAt).toEqual(NOW)
  })
})

describe('User.fromTrusted with a null hash', () => {
  it('rehydrates a federated (passwordless) row', () => {
    const user = User.fromTrusted({
      id: ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: new Date(NOW),
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    expect(user.passwordHash).toBeNull()
  })
})
```

Add to `src/modules/auth/use-cases/login-user.spec.ts` (reuse its `USER_ID`/`EMAIL`/`NOW`, in-memory users repo, and `InvalidCredentialsError` import):

```ts
it('rejects a federated-only account (null hash) as invalid credentials, via the decoy', async () => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )

  await expect(
    useCase.execute({ email: EMAIL, password: 'anything' }),
  ).rejects.toBeInstanceOf(InvalidCredentialsError)
})
```

Add to `src/modules/auth/use-cases/change-password.spec.ts` (match the file's names for the compare spy and dummy-hash constant — shown as `hashSpy` / `DUMMY_HASH` here):

```ts
it('refuses a federated-only account (null hash) with InvalidCurrentPasswordError, after a decoy compare', async () => {
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )

  await expect(
    useCase.execute({ userId: USER_ID, currentPassword: 'x', newPassword: NEW_PASSWORD }),
  ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)
  expect(hashSpy).toHaveBeenCalledWith('x', DUMMY_HASH)
  expect(storedUser()?.passwordHash).toBeNull()
})
```

Add to `tests/integration/users-schema.spec.ts` (import `eq` from `drizzle-orm` if absent):

```ts
it('accepts a user row with no password hash (federated account)', async () => {
  await db.insert(users).values({
    id: '11111111-2222-4333-8444-555555555555',
    email: 'federated@example.com',
    emailVerifiedAt: new Date('2026-09-08T00:00:00.000Z'),
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  })

  const [stored] = await db
    .select()
    .from(users)
    .where(eq(users.email, 'federated@example.com'))

  expect(stored?.passwordHash).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit src/modules/auth/entities/user.spec.ts src/modules/auth/use-cases/change-password.spec.ts`
Expected: FAIL — `User.createFederated` undefined; `change-password` calls `compare(current, null)` and throws before the assertion.
Run: `pnpm test:integration users-schema`
Expected: FAIL — `password_hash` is still `NOT NULL` (`23502`).

- [ ] **Step 3: Widen the entity**

In `src/modules/auth/entities/user.ts`:
1. `readonly #passwordHash: string | null`
2. In `TrustedUserProps`: `passwordHash: string | null`
3. Add next to `CreateUserProps`:
   ```ts
   export interface CreateFederatedUserProps {
     id: string
     email: Email
     /** Supplied by `IClock`, never by `new Date()` — R7. */
     now: Date
   }
   ```
4. In the `create` docstring, change `* Social login, when it lands, is the other proven path.` to `* Social login is the other proven path — see \`createFederated\` below.`
5. Add after `create`:
   ```ts
   /**
    * Born verified and WITHOUT a password: the only caller is
    * `SignInWithGoogleUseCase`, and the identity provider has already proven
    * control of the address (§6 item 2 of `DECISIONS.md`). A null `passwordHash`
    * is the honest state — there is no password — and `login-user.ts` already
    * funnels it to the decoy compare through `?? dummyHash`.
    */
   static createFederated(props: CreateFederatedUserProps): User {
     return new User({
       id: props.id,
       email: props.email,
       passwordHash: null,
       emailVerifiedAt: props.now,
       createdAt: props.now,
       updatedAt: props.now,
     })
   }
   ```
6. Getter: `get passwordHash(): string | null { return this.#passwordHash }`

- [ ] **Step 4: Drop the NOT NULL and generate the migration**

In `src/modules/auth/infra/drizzle/schema/users.ts`, change:
```ts
passwordHash: text('password_hash').notNull(),
```
to:
```ts
/**
 * Null for federated-identity accounts (slice 14), which have no password.
 * Every other account is born with a hash at confirmation.
 */
passwordHash: text('password_hash'),
```

```bash
docker compose up -d
pnpm db:generate
```
Inspect the new `drizzle/<timestamp>_...` folder — `migration.sql` must be exactly
`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;` (plus drizzle's
statement-breakpoint comment). Rename the folder slug to
`<timestamp>_users_password_hash_nullable` if unhelpful (keep the timestamp prefix).

```bash
pnpm db:migrate
```

- [ ] **Step 5: Check the mapper**

Open `src/modules/auth/infra/drizzle/user-mapper.ts`. `toPersistenceUser` returns
`passwordHash: user.passwordHash` (now `string | null`) into `NewUserRow` (now
`string | null | undefined` after the schema change) — assignable, no change.
`toDomainUser` passes `row.passwordHash` (`string | null`) to `User.fromTrusted`,
which now accepts it — no change. Add one comment on the `toDomainUser` field:
```ts
    // Null for a federated account; `fromTrusted` accepts it.
    passwordHash: row.passwordHash,
```
Run `pnpm typecheck` — if `user-mapper.ts` still errors, the schema change did not
take; re-check step 4.

- [ ] **Step 6: Guard `login-user.ts`**

The decoy already covers `null` — `user?.passwordHash ?? this.hashProvider.dummyHash`
turns `null` into `dummyHash` (`??` catches `null`). Confirm the line reads exactly
that (not a ternary on `user`). Add the comment above it:
```ts
    // A federated-only account has `passwordHash === null`; `??` funnels it to
    // the decoy here, so it fails as InvalidCredentialsError like any other
    // wrong credential — no separate branch, no oracle.
    const hashed = user?.passwordHash ?? this.hashProvider.dummyHash
```

- [ ] **Step 7: Guard `change-password.ts`**

After `if (user === null) throw new UserNotFoundError()` and BEFORE the `compare`
call, add:
```ts
    // A federated-only account has no current password to confirm. Run the
    // decoy so the timing matches a wrong-password attempt, then refuse.
    // "Set a first password" is a future slice.
    if (user.passwordHash === null) {
      await this.hashProvider.compare(command.currentPassword, this.hashProvider.dummyHash)
      throw new InvalidCurrentPasswordError()
    }
```
The existing `compare(command.currentPassword, user.passwordHash)` below now sees a
narrowed `string`.

- [ ] **Step 8: Run everything green**

Run: `pnpm test:unit src/modules/auth/entities/user.spec.ts src/modules/auth/use-cases/login-user.spec.ts src/modules/auth/use-cases/change-password.spec.ts`
Expected: PASS.
Run: `pnpm test:integration users-schema`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/entities/user.ts src/modules/auth/entities/user.spec.ts src/modules/auth/infra/drizzle/schema/users.ts src/modules/auth/infra/drizzle/user-mapper.ts src/modules/auth/use-cases/login-user.ts src/modules/auth/use-cases/login-user.spec.ts src/modules/auth/use-cases/change-password.ts src/modules/auth/use-cases/change-password.spec.ts tests/integration/users-schema.spec.ts drizzle/
git commit -m "feat(auth): nullable users.password_hash for federated accounts"
```

---

## Task 3: `federated_identities` schema + migration

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/federated-identities.ts`
- Create: migration folder via `pnpm db:generate`
- Create: `tests/integration/federated-identities-schema.spec.ts`

**Interfaces:**
- Consumes: `users` table from `./users.js`.
- Produces:
  - `export const federatedIdentities` — Drizzle `pgTable` with columns `id` (uuid PK), `userId` (uuid, FK → `users.id` `onDelete: 'cascade'`), `provider` (text), `providerUserId` (text), `emailAtLink` (text), `createdAt` (timestamptz).
  - Indexes: `unique (provider, provider_user_id)` named `federated_identities_provider_subject_unique`; `unique (user_id, provider)` named `federated_identities_user_provider_unique`; `index (user_id)` named `federated_identities_user_id_idx`.
  - Names spelled inline (each appears exactly once; the repository does not match a `23505` against any of them — Task 4).

- [ ] **Step 1: Write the failing schema test**

Create `tests/integration/federated-identities-schema.spec.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological.
const TABLE_NAME = 'federated_identities'
const PROVIDER_SUBJECT_UNIQUE = 'federated_identities_provider_subject_unique'
const USER_PROVIDER_UNIQUE = 'federated_identities_user_provider_unique'
const USER_ID_INDEX = 'federated_identities_user_id_idx'
const UNIQUE_VIOLATION = '23505'
const NOT_NULL_VIOLATION = '23502'
const FK_VIOLATION = '23503'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const PROVIDER = 'google'
const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-09-08T12:00:00.000Z')
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
  await db.delete(federatedIdentities)
  await db.delete(users)
  await db.insert(users).values({
    id: USER_ID,
    email: EMAIL,
    passwordHash: HASH,
    emailVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })
})

const row = (overrides: Partial<typeof federatedIdentities.$inferInsert> = {}) => ({
  id: ROW_ID,
  userId: USER_ID,
  provider: PROVIDER,
  providerUserId: SUBJECT,
  emailAtLink: EMAIL,
  createdAt: NOW,
  ...overrides,
})

describe('federated_identities table', () => {
  it('stores a row with all six columns', async () => {
    await db.insert(federatedIdentities).values(row())

    const [stored] = await db.select().from(federatedIdentities)

    expect(stored?.id).toBe(ROW_ID)
    expect(stored?.userId).toBe(USER_ID)
    expect(stored?.provider).toBe(PROVIDER)
    expect(stored?.providerUserId).toBe(SUBJECT)
    expect(stored?.emailAtLink).toBe(EMAIL)
    expect(stored?.createdAt).toEqual(NOW)
  })

  it('rejects an insert without created_at, proving there is no default', async () => {
    const { createdAt: _c, ...withoutCreatedAt } = row()

    await expect(
      db.insert(federatedIdentities).values(withoutCreatedAt as never),
    ).rejects.toMatchObject({ cause: { code: NOT_NULL_VIOLATION } })
  })

  it('rejects a row whose user_id has no user (foreign key)', async () => {
    await expect(
      db.insert(federatedIdentities).values(row({ userId: OTHER_ROW_ID })),
    ).rejects.toMatchObject({ cause: { code: FK_VIOLATION } })
  })

  it('deletes the link when its user is deleted (ON DELETE CASCADE)', async () => {
    await db.insert(federatedIdentities).values(row())

    await db.delete(users)

    expect(await db.select().from(federatedIdentities)).toHaveLength(0)
  })

  it('refuses a second link for the same (provider, subject)', async () => {
    await db.insert(federatedIdentities).values(row())

    await expect(
      db.insert(federatedIdentities).values(row({ id: OTHER_ROW_ID })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('refuses a second Google link for the same user', async () => {
    await db.insert(federatedIdentities).values(row())

    await expect(
      db
        .insert(federatedIdentities)
        .values(row({ id: OTHER_ROW_ID, providerUserId: 'a-different-subject' })),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } })
  })

  it('carries the two unique indexes and the user_id index', async () => {
    const result = await db.execute(
      sql`select indexname from pg_indexes where tablename = ${TABLE_NAME}`,
    )
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{
      indexname: string
    }>
    const names = rows.map((r) => r.indexname)

    expect(names).toContain(PROVIDER_SUBJECT_UNIQUE)
    expect(names).toContain(USER_PROVIDER_UNIQUE)
    expect(names).toContain(USER_ID_INDEX)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration federated-identities-schema`
Expected: FAIL — cannot find module `#modules/auth/infra/drizzle/schema/federated-identities`.

- [ ] **Step 3: Write the schema**

Create `src/modules/auth/infra/drizzle/schema/federated-identities.ts`:

```ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One link between a local user and an identity a provider vouches for. This
 * module owns the table, and the foreign key to `users` is legal because both
 * live inside `auth` (decision 24). Cascade on delete: the link is meaningless
 * without its user.
 *
 * NO column defaults, like `refresh-tokens.ts`: `created_at` comes from `IClock`
 * so that any later instant comparison has both sides from one source. `users`
 * can afford defaults as defence in depth for direct writes; a link row has no
 * legitimate direct write to defend.
 *
 * Names spelled inline: each appears exactly once, and the repository does NOT
 * match a `23505` against any of them — a duplicate link is rare, and re-running
 * the sign-in resolves it through the fast path (design §4.4).
 */
export const federatedIdentities = pgTable(
  'federated_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `'google'` today; a closed set carried as text (design §2). */
    provider: text('provider').notNull(),
    /** The provider's stable subject id — Google's `sub`. Never reassigned. */
    providerUserId: text('provider_user_id').notNull(),
    /** Audit: the address the provider asserted when the link was made. */
    emailAtLink: text('email_at_link').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The fast-path lookup, and the guarantee that one provider identity maps
    // to exactly one user.
    uniqueIndex('federated_identities_provider_subject_unique').on(
      table.provider,
      table.providerUserId,
    ),
    // One identity per provider per user.
    uniqueIndex('federated_identities_user_provider_unique').on(
      table.userId,
      table.provider,
    ),
    index('federated_identities_user_id_idx').on(table.userId),
  ],
)
```

- [ ] **Step 4: Generate and apply the migration**

```bash
docker compose up -d
pnpm db:generate
```

Inspect the new folder under `drizzle/` (name like `<timestamp>_<slug>`). Its `migration.sql` must contain **only** the `federated_identities` changes (the `users.password_hash` `DROP NOT NULL` was already generated and applied in Task 2):
- `CREATE TABLE "federated_identities" (...)` with the FK to `users`,
- `CREATE UNIQUE INDEX "federated_identities_provider_subject_unique" ...`,
- `CREATE UNIQUE INDEX "federated_identities_user_provider_unique" ...`,
- `CREATE INDEX "federated_identities_user_id_idx" ...`.

If `password_hash` shows up here, Task 2's migration was not applied — run `pnpm db:migrate` and re-generate. If the folder slug is unhelpful, rename it to `<timestamp>_add_federated_identities` (keep the timestamp prefix; drizzle-kit keys on the `snapshot.json` inside).

```bash
pnpm db:migrate
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:integration federated-identities-schema`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/infra/drizzle/schema/federated-identities.ts drizzle/ tests/integration/federated-identities-schema.spec.ts
git commit -m "feat(auth): federated_identities table"
```

---

## Task 4: `IFederatedIdentitiesRepository` — interface, in-memory, Drizzle, mapper, `AuthRepos` wiring

**Files:**
- Create: `src/modules/auth/repositories/federated-identities-repository.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-federated-identities-repository.ts`
- Create: `src/modules/auth/infra/drizzle/federated-identity-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-federated-identities-repository.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts` (`AuthRepos` + doctrine comment)
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Create: `tests/integration/drizzle-federated-identities-repository.spec.ts`

**Interfaces:**
- Consumes: `FederatedIdentity`, `FederatedProvider` (Task 1); `federatedIdentities` table (Task 3); `Database`, `toPersistenceError` from infra.
- Produces:
  - `interface IFederatedIdentitiesRepository { save(identity: FederatedIdentity): Promise<void>; findByProviderUserId(provider: FederatedProvider, providerUserId: string): Promise<FederatedIdentity | null> }`
  - `class InMemoryFederatedIdentitiesRepository implements IFederatedIdentitiesRepository` with a public `readonly rows: FederatedIdentity[]`.
  - `class DrizzleFederatedIdentitiesRepository implements IFederatedIdentitiesRepository`, constructor `(db: Database)`.
  - `toDomainFederatedIdentity(row): FederatedIdentity`, `toPersistenceFederatedIdentity(identity): NewFederatedIdentityRow`.
  - `AuthRepos.federatedIdentities: IFederatedIdentitiesRepository`; `authRepositories(db).federatedIdentities`; `noopAuthRepos().federatedIdentities`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/drizzle-federated-identities-repository.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { DrizzleFederatedIdentitiesRepository } from '#modules/auth/infra/drizzle/drizzle-federated-identities-repository'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const ROW_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_ROW_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-09-08T12:00:00.000Z')

let db: Database
let pool: Pool
let repo: DrizzleFederatedIdentitiesRepository

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  repo = new DrizzleFederatedIdentitiesRepository(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(federatedIdentities)
  await db.delete(users)
  await db.insert(users).values({
    id: USER_ID,
    email: EMAIL,
    passwordHash: HASH,
    emailVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })
})

const identity = (id = ROW_ID, subject = SUBJECT) =>
  FederatedIdentity.create({
    id,
    userId: USER_ID,
    provider: GOOGLE_PROVIDER,
    providerUserId: subject,
    emailAtLink: Email.fromTrusted(EMAIL),
    now: NOW,
  })

describe('DrizzleFederatedIdentitiesRepository.save', () => {
  it('persists a link, round-tripping through findByProviderUserId', async () => {
    await repo.save(identity())

    const found = await repo.findByProviderUserId(GOOGLE_PROVIDER, SUBJECT)

    expect(found?.id).toBe(ROW_ID)
    expect(found?.userId).toBe(USER_ID)
    expect(found?.providerUserId).toBe(SUBJECT)
  })

  it('rejects a duplicate (provider, subject) as a persistence failure', async () => {
    await repo.save(identity())

    await expect(repo.save(identity(OTHER_ROW_ID))).rejects.toThrow()
  })

  it('rejects a second Google link for the same user', async () => {
    await repo.save(identity())

    await expect(
      repo.save(identity(OTHER_ROW_ID, 'a-different-subject')),
    ).rejects.toThrow()
  })
})

describe('DrizzleFederatedIdentitiesRepository.findByProviderUserId', () => {
  it('returns null when nothing is linked', async () => {
    expect(await repo.findByProviderUserId(GOOGLE_PROVIDER, SUBJECT)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration drizzle-federated-identities-repository`
Expected: FAIL — cannot find `DrizzleFederatedIdentitiesRepository`.

- [ ] **Step 3: Write the interface**

Create `src/modules/auth/repositories/federated-identities-repository.ts`:

```ts
import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'

export interface IFederatedIdentitiesRepository {
  /**
   * Plain insert. A unique violation on `(provider, provider_user_id)` or
   * `(user_id, provider)` bubbles as a generic persistence failure — the
   * concurrent double-link is rare and re-running the sign-in lands on the fast
   * path (design §4.4), so there is nothing to translate.
   */
  save(identity: FederatedIdentity): Promise<void>

  /**
   * The fast path: an already-linked provider identity. Matches on the stable
   * `provider_user_id`, never on the email — the email may have changed since
   * the link was made.
   */
  findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null>
}
```

- [ ] **Step 4: Write the mapper**

Create `src/modules/auth/infra/drizzle/federated-identity-mapper.ts`:

```ts
import {
  FederatedIdentity,
  type FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import { Email } from '#modules/auth/value-objects/email'
import type { federatedIdentities } from './schema/federated-identities.js'

type NewFederatedIdentityRow = typeof federatedIdentities.$inferInsert
type FederatedIdentityRow = typeof federatedIdentities.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 */
export const toPersistenceFederatedIdentity = (
  identity: FederatedIdentity,
): NewFederatedIdentityRow => ({
  id: identity.id,
  userId: identity.userId,
  provider: identity.provider,
  providerUserId: identity.providerUserId,
  emailAtLink: identity.emailAtLink.value,
  createdAt: identity.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `FederatedIdentity.fromTrusted`. */
export const toDomainFederatedIdentity = (
  row: FederatedIdentityRow,
): FederatedIdentity =>
  FederatedIdentity.fromTrusted({
    id: row.id,
    userId: row.userId,
    // The column is unconstrained `text`; the domain type is the closed set.
    provider: row.provider as FederatedProvider,
    providerUserId: row.providerUserId,
    emailAtLink: Email.fromTrusted(row.emailAtLink),
    createdAt: row.createdAt,
  })
```

- [ ] **Step 5: Write the Drizzle repository**

Create `src/modules/auth/infra/drizzle/drizzle-federated-identities-repository.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { toPersistenceError } from '#infra/database/driver-error'
import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'
import {
  toDomainFederatedIdentity,
  toPersistenceFederatedIdentity,
} from './federated-identity-mapper.js'
import { federatedIdentities } from './schema/federated-identities.js'

export class DrizzleFederatedIdentitiesRepository
  implements IFederatedIdentitiesRepository
{
  constructor(private readonly db: Database) {}

  async save(identity: FederatedIdentity): Promise<void> {
    try {
      await this.db
        .insert(federatedIdentities)
        .values(toPersistenceFederatedIdentity(identity))
    } catch (error) {
      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message.
      throw toPersistenceError(error)
    }
  }

  async findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null> {
    try {
      const [row] = await this.db
        .select()
        .from(federatedIdentities)
        .where(
          and(
            eq(federatedIdentities.provider, provider),
            eq(federatedIdentities.providerUserId, providerUserId),
          ),
        )

      return row === undefined ? null : toDomainFederatedIdentity(row)
    } catch (error) {
      throw toPersistenceError(error)
    }
  }
}
```

- [ ] **Step 6: Write the in-memory repository**

Create `src/modules/auth/infra/in-memory/in-memory-federated-identities-repository.ts`:

```ts
import type {
  FederatedIdentity,
  FederatedProvider,
} from '#modules/auth/entities/federated-identity'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09). Models
 * no unique constraint: a unit test inserts one row at a time, and the two
 * unique indexes are proved against real Postgres in
 * `tests/integration/drizzle-federated-identities-repository.spec.ts`.
 */
export class InMemoryFederatedIdentitiesRepository
  implements IFederatedIdentitiesRepository
{
  readonly rows: FederatedIdentity[] = []

  async save(identity: FederatedIdentity): Promise<void> {
    this.rows.push(identity)
  }

  async findByProviderUserId(
    provider: FederatedProvider,
    providerUserId: string,
  ): Promise<FederatedIdentity | null> {
    return (
      this.rows.find(
        (row) =>
          row.provider === provider && row.providerUserId === providerUserId,
      ) ?? null
    )
  }
}
```

- [ ] **Step 7: Add `federatedIdentities` to `AuthRepos` and its wiring**

The use case (Task 8) receives this repo through the `uow` callback, so `AuthRepos`
must carry it now — added here, with nothing consuming it yet, so the task ends
green.

In `src/modules/auth/repositories/unit-of-work.ts`:
1. Import `IFederatedIdentitiesRepository`.
2. Add to the `AuthRepos` interface: `federatedIdentities: IFederatedIdentitiesRepository`.
3. Extend the doctrine comment — after the `passwordResetTokens` paragraph:
   ```
   * `federatedIdentities` for the Google sign-in: it creates the `users` row,
   * the identity link and the first refresh token in one transaction — one fact.
   ```

In `src/modules/auth/infra/drizzle/auth-repositories.ts`:
1. Import `DrizzleFederatedIdentitiesRepository`.
2. Add `federatedIdentities: new DrizzleFederatedIdentitiesRepository(db)` to the returned object.

In `src/modules/auth/repositories/noop-auth-repos.ts`, add to the returned object:
```ts
    federatedIdentities: {
      save: async () => {},
      findByProviderUserId: async () => null,
    },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:integration drizzle-federated-identities-repository`
Expected: PASS (4 tests).
Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS — every spec that builds an `AuthRepos` via `{ ...noopAuthRepos(), ... }` still compiles because `noopAuthRepos()` now supplies `federatedIdentities`.

- [ ] **Step 9: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/repositories/federated-identities-repository.ts src/modules/auth/infra/in-memory/in-memory-federated-identities-repository.ts src/modules/auth/infra/drizzle/federated-identity-mapper.ts src/modules/auth/infra/drizzle/drizzle-federated-identities-repository.ts src/modules/auth/repositories/unit-of-work.ts src/modules/auth/infra/drizzle/auth-repositories.ts src/modules/auth/repositories/noop-auth-repos.ts tests/integration/drizzle-federated-identities-repository.spec.ts
git commit -m "feat(auth): federated identities repository (Drizzle + in-memory), wired into AuthRepos"
```

---

## Task 5: `deleteAllByEmail` on the pending-registrations repository

**Files:**
- Modify: `src/modules/auth/repositories/pending-registrations-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Modify: `tests/integration/drizzle-pending-registrations-repository.spec.ts`

**Interfaces:**
- Produces: `IPendingRegistrationsRepository.deleteAllByEmail(email: Email): Promise<void>` — deletes every row for `lower(email)`, consumed or not, expired or not.

- [ ] **Step 1: Write the failing integration test**

Add to `tests/integration/drizzle-pending-registrations-repository.spec.ts` (reuse the file's `db`, `repo`, row helpers, and `Email` import):

```ts
describe('DrizzlePendingRegistrationsRepository.deleteAllByEmail', () => {
  it('removes every row for the address — live, expired, and consumed alike', async () => {
    const address = 'ana@example.com'
    // A live unconsumed row.
    await repo.save(pendingFor(address, { id: ID_A }))
    // A consumed row for the same address.
    await db.insert(pendingRegistrations).values(
      rawRow({ id: ID_B, email: address, consumedAt: new Date('2026-09-08T00:00:00.000Z') }),
    )

    await repo.deleteAllByEmail(Email.fromTrusted(address))

    const remaining = await db
      .select()
      .from(pendingRegistrations)
      .where(sql`lower(${pendingRegistrations.email}) = ${address}`)
    expect(remaining).toHaveLength(0)
  })

  it('leaves rows for other addresses untouched', async () => {
    await repo.save(pendingFor('ana@example.com', { id: ID_A }))
    await repo.save(pendingFor('other@example.com', { id: ID_B }))

    await repo.deleteAllByEmail(Email.fromTrusted('ana@example.com'))

    const rows = await db.select().from(pendingRegistrations)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe('other@example.com')
  })
})
```
Adapt `pendingFor` / `rawRow` / `ID_A` / `ID_B` to whatever the file already provides — if it has a single `row()` builder and one id constant, add a second id constant and a small helper that sets `email` and `id`. Import `sql` from `drizzle-orm` if not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration drizzle-pending-registrations-repository`
Expected: FAIL — `repo.deleteAllByEmail is not a function`.

- [ ] **Step 3: Add to the interface**

In `src/modules/auth/repositories/pending-registrations-repository.ts`, add after `deleteExpiredByEmail`:

```ts
  /**
   * Total wipe for one address: `DELETE ... WHERE lower(email) = ?`, with no
   * expiry or `consumed_at` filter. Called when a federated sign-in takes the
   * address (§6 item 2 of `DECISIONS.md`) — a concurrent confirm that was about
   * to consume one of these rows then loses its `consume` and reports the same
   * generic failure. Distinct from `deleteExpiredByEmail`, which is
   * opportunistic and never touches a live row.
   */
  deleteAllByEmail(email: Email): Promise<void>
```

- [ ] **Step 4: Implement in the Drizzle repository**

In `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts`, add a method (mirrors `deleteExpiredByEmail` without the `or(...)`):

```ts
  async deleteAllByEmail(email: Email): Promise<void> {
    await this.db
      .delete(pendingRegistrations)
      .where(sql`lower(${pendingRegistrations.email}) = ${email.value}`)
  }
```
(`sql` is already imported in that file.)

- [ ] **Step 5: Implement in the in-memory repository**

In `src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts`, add:

```ts
  async deleteAllByEmail(email: Email): Promise<void> {
    const survivors = this.rows.filter(
      (row) => row.email.value !== email.value,
    )
    this.rows.length = 0
    this.rows.push(...survivors)
  }
```
Check the field name the in-memory rows use for the address (`row.email` is an `Email`, so `.value`); match the file's existing style for the same comparison in `deleteExpiredByEmail`.

- [ ] **Step 6: Add to `noopAuthRepos`**

In `src/modules/auth/repositories/noop-auth-repos.ts`, inside `pendingRegistrations`, add:

```ts
      deleteAllByEmail: async () => {},
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test:integration drizzle-pending-registrations-repository`
Expected: PASS.
Run: `pnpm typecheck` — expect PASS.

- [ ] **Step 8: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/repositories/pending-registrations-repository.ts src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts src/modules/auth/infra/in-memory/in-memory-pending-registrations-repository.ts src/modules/auth/repositories/noop-auth-repos.ts tests/integration/drizzle-pending-registrations-repository.spec.ts
git commit -m "feat(auth): deleteAllByEmail on the pending-registrations repository"
```

---

## Task 6: Config — `GOOGLE_CLIENT_ID`, `GOOGLE_JWKS_URI`, rate-limit pair

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/config.spec.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Modify: `vitest.config.ts`
- Modify: `.env.example`
- Modify: `docs/local.md`

**Interfaces:**
- Produces on `AuthConfig`: `GOOGLE_CLIENT_ID: string`, `GOOGLE_JWKS_URI: string`, `GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: number`, `GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: number`.
- Produces exported constants: `DEFAULT_GOOGLE_JWKS_URI`, `DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS`, `DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS`.

- [ ] **Step 1: Write the failing config test**

In `src/modules/auth/config.spec.ts` add cases (match the file's existing pattern for asserting a parsed default and a rejected empty value):

```ts
it('defaults GOOGLE_JWKS_URI to Google's cert endpoint', () => {
  const parsed = authEnvSchema.parse({
    JWT_SECRET: VALID_SECRET,
    GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  })

  expect(parsed.GOOGLE_JWKS_URI).toBe(DEFAULT_GOOGLE_JWKS_URI)
  expect(parsed.GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS).toBe(
    DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
  )
})

it('rejects a missing GOOGLE_CLIENT_ID', () => {
  expect(() => authEnvSchema.parse({ JWT_SECRET: VALID_SECRET })).toThrow()
})
```
Use the file's own name for a valid secret fixture (`VALID_SECRET` here is a placeholder for whatever the spec file already defines; if it builds input inline, follow that).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit src/modules/auth/config.spec.ts`
Expected: FAIL — `DEFAULT_GOOGLE_JWKS_URI` undefined / `GOOGLE_JWKS_URI` missing on parsed output.

- [ ] **Step 3: Add the constants and schema fields**

In `src/modules/auth/config.ts`, add the constants near the other `DEFAULT_*`:

```ts
/**
 * Google's JWKS endpoint. A default of the real URL, the way `MAIL_HOST`
 * defaults to the dev Mailpit host: it is a service endpoint, and the
 * integration test points it at a local JWKS server via the same `buildApp`
 * env override `verify-email.spec.ts` uses for rate-limit ceilings.
 */
export const DEFAULT_GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'

/**
 * Ten attempts a minute from one address on `POST /auth/google`. The link path
 * of that route carries a password guess, so the reasoning is login's: it counts
 * REQUESTS not failures, sits far above human retry and far below anything
 * useful to an attacker. Its own pair, not login's — a field named for one route
 * used by another is a comment that lies.
 */
export const DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS = 60
```

In `authEnvSchema`, add the fields (follow the file's `.coerce.number().int().positive().default(...)` style for the numeric pair):

```ts
  /**
   * The OAuth client id from Google Cloud Console. Public, not a secret:
   * ID-token verification is public-key crypto. Required, no default, like
   * `JWT_SECRET` — ship a placeholder in `.env.example` for setups without
   * Google sign-in.
   */
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_JWKS_URI: z.url().default(DEFAULT_GOOGLE_JWKS_URI),
  GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS),
  GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS),
```

- [ ] **Step 4: Complete the test fixtures**

In `src/infra/config/fixtures/test-env.ts`:
1. Add to the `#modules/auth/config` import list: `DEFAULT_GOOGLE_JWKS_URI`, `DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS`, `DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS`.
2. Add to the `TEST_ENV` object:
   ```ts
     GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
     GOOGLE_JWKS_URI: DEFAULT_GOOGLE_JWKS_URI,
     GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
     GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
   ```

In `vitest.config.ts`, add a constant and an `env` entry next to `JWT_SECRET`:

```ts
const TEST_GOOGLE_CLIENT_ID = 'integration-test-google-client-id'
```
```ts
      // Same story as JWT_SECRET: a test fixture, not configuration. The
      // integration project runs `parseEnv`, which exits the process without it.
      GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
```

- [ ] **Step 5: Document the new variable**

In `.env.example`, add under the auth section:
```
# OAuth client id from Google Cloud Console (public, not a secret). Required.
# Any non-empty value lets the process boot; a real one is needed for Google sign-in to work.
GOOGLE_CLIENT_ID=replace-me.apps.googleusercontent.com
```
In `docs/local.md`, add a line to whatever env table/list it keeps: `GOOGLE_CLIENT_ID` — "client id do Google Cloud Console; qualquer valor não vazio sobe o processo".

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test:unit src/modules/auth/config.spec.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS (the `Env` type now requires the new keys; `test-env.ts` supplies them).

- [ ] **Step 7: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts src/infra/config/fixtures/test-env.ts vitest.config.ts .env.example docs/local.md
git commit -m "feat(auth): config for Google sign-in (client id, JWKS URI, rate limit)"
```

---

## Task 7: `IGoogleIdentityVerifier` port + `jose` adapter + `InvalidGoogleIdentityError`

**Files:**
- Create: `src/modules/auth/ports/google-identity-verifier.ts`
- Create: `src/modules/auth/errors/invalid-google-identity-error.ts`
- Create: `src/modules/auth/infra/providers/jose-google-identity-verifier.ts`
- Create: `tests/integration/setup/google-jwks.ts`
- Create: `tests/integration/jose-google-identity-verifier.spec.ts`

**Interfaces:**
- Consumes: `AuthConfig` (Task 6); `jose` (`createRemoteJWKSet`, `jwtVerify`, and for the test helper `generateKeyPair`, `exportJWK`, `SignJWT`).
- Produces:
  - `interface GoogleIdentity { subject: string; email: string }`
  - `interface IGoogleIdentityVerifier { verify(idToken: string): Promise<GoogleIdentity> }`
  - `class InvalidGoogleIdentityError extends UnauthorizedError` — `code = 'INVALID_GOOGLE_IDENTITY'`.
  - `class JoseGoogleIdentityVerifier implements IGoogleIdentityVerifier`, constructor `(config: Pick<AuthConfig, 'GOOGLE_CLIENT_ID' | 'GOOGLE_JWKS_URI'>)`.
  - Test helper `startGoogleJwksServer()` → `{ url: string, sign(claims): Promise<string>, close(): Promise<void>, otherKeySign(claims): Promise<string> }` and `GOOGLE_TEST_ISSUER = 'https://accounts.google.com'`.

- [ ] **Step 1: Write the JWKS test helper**

Create `tests/integration/setup/google-jwks.ts`:

```ts
import { createServer, type Server } from 'node:http'
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose'

const RS256 = 'RS256'
/** One of the two values the adapter pins as a Google issuer. */
export const GOOGLE_TEST_ISSUER = 'https://accounts.google.com'

const HOST = '127.0.0.1'
const ANY_FREE_PORT = 0
const JWKS_CONTENT_TYPE = 'application/json'
const KEY_ID = 'test-key-1'
const OTHER_KEY_ID = 'test-key-2'

export interface GoogleJwksServer {
  /** Pass as `GOOGLE_JWKS_URI`. */
  url: string
  /** Signs an ID token with the served key. `claims` overrides the defaults. */
  sign(claims: Record<string, unknown>): Promise<string>
  /** Signs with a key that is NOT in the served set — for the bad-signature case. */
  signWithForeignKey(claims: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

export async function startGoogleJwksServer(
  audience: string,
): Promise<GoogleJwksServer> {
  const served = await generateKeyPair(RS256)
  const foreign = await generateKeyPair(RS256)

  const publicJwk = (await exportJWK(served.publicKey)) as JWK
  publicJwk.kid = KEY_ID
  publicJwk.alg = RS256
  publicJwk.use = 'sig'

  const body = JSON.stringify({ keys: [publicJwk] })

  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': JWKS_CONTENT_TYPE })
    res.end(body)
  })

  await new Promise<void>((resolve) => server.listen(ANY_FREE_PORT, HOST, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('JWKS test server did not bind a port')
  }
  const url = `http://${HOST}:${address.port}/`

  const baseClaims = (claims: Record<string, unknown>) => ({
    iss: GOOGLE_TEST_ISSUER,
    aud: audience,
    email: 'ana@example.com',
    email_verified: true,
    sub: 'google-subject-1234567890',
    ...claims,
  })

  return {
    url,
    async sign(claims) {
      return new SignJWT(baseClaims(claims))
        .setProtectedHeader({ alg: RS256, kid: KEY_ID })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(served.privateKey)
    },
    async signWithForeignKey(claims) {
      return new SignJWT(baseClaims(claims))
        .setProtectedHeader({ alg: RS256, kid: OTHER_KEY_ID })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(foreign.privateKey)
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}
```

- [ ] **Step 2: Write the failing adapter test**

Create `tests/integration/jose-google-identity-verifier.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import { JoseGoogleIdentityVerifier } from '#modules/auth/infra/providers/jose-google-identity-verifier'
import { type GoogleJwksServer, startGoogleJwksServer } from './setup/google-jwks.js'

const CLIENT_ID = 'integration-test-google-client-id'

let jwks: GoogleJwksServer
let verifier: JoseGoogleIdentityVerifier

beforeAll(async () => {
  jwks = await startGoogleJwksServer(CLIENT_ID)
  verifier = new JoseGoogleIdentityVerifier({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_JWKS_URI: jwks.url,
  })
})

afterAll(async () => {
  await jwks.close()
})

describe('JoseGoogleIdentityVerifier.verify', () => {
  it('returns the subject and email of a well-formed token', async () => {
    const token = await jwks.sign({})

    const identity = await verifier.verify(token)

    expect(identity.subject).toBe('google-subject-1234567890')
    expect(identity.email).toBe('ana@example.com')
  })

  it('rejects a token minted for a different client id', async () => {
    const token = await jwks.sign({ aud: 'some-other-client.apps.googleusercontent.com' })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token from an unexpected issuer', async () => {
    const token = await jwks.sign({ iss: 'https://evil.example.com' })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects an expired token', async () => {
    // `exp` in the past; jose rejects on `exp <= now`.
    const token = await jwks.sign({ exp: Math.floor(Date.now() / 1000) - 60 })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token signed with a key that is not in the JWKS', async () => {
    const token = await jwks.signWithForeignKey({})

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token whose email is not verified by Google', async () => {
    const token = await jwks.sign({ email_verified: false })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })

  it('rejects a token with no email claim', async () => {
    const token = await jwks.sign({ email: undefined })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:integration jose-google-identity-verifier`
Expected: FAIL — cannot find `InvalidGoogleIdentityError` / `JoseGoogleIdentityVerifier`.

- [ ] **Step 4: Write the error**

Create `src/modules/auth/errors/invalid-google-identity-error.ts`:

```ts
import { UnauthorizedError } from '#shared/errors/app-error'

const INVALID_GOOGLE_IDENTITY_CODE = 'INVALID_GOOGLE_IDENTITY'
const INVALID_GOOGLE_IDENTITY_MESSAGE = 'Invalid Google identity token'

/**
 * The single answer to every way a Google ID token can fail: bad signature,
 * wrong issuer, wrong audience, expired, or an email Google has not verified.
 *
 * Deliberately says nothing about which. Branches that reported differently
 * would drift apart at the first maintenance and hand an attacker a probe.
 */
export class InvalidGoogleIdentityError extends UnauthorizedError {
  readonly code = INVALID_GOOGLE_IDENTITY_CODE

  constructor() {
    super(INVALID_GOOGLE_IDENTITY_MESSAGE)
  }
}
```

- [ ] **Step 5: Write the port**

Create `src/modules/auth/ports/google-identity-verifier.ts`:

```ts
/** What the app trusts from a verified Google ID token. */
export interface GoogleIdentity {
  /** Google's `sub` — stable, unique per Google account, never reassigned. */
  subject: string
  /** Already asserted as verified by Google; the adapter throws otherwise. */
  email: string
}

export interface IGoogleIdentityVerifier {
  /**
   * Throws `InvalidGoogleIdentityError` on any invalid, forged, expired,
   * wrong-audience, wrong-issuer, or unverified-email token.
   */
  verify(idToken: string): Promise<GoogleIdentity>
}
```

- [ ] **Step 6: Write the adapter**

Create `src/modules/auth/infra/providers/jose-google-identity-verifier.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthConfig } from '#modules/auth/config'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import type {
  GoogleIdentity,
  IGoogleIdentityVerifier,
} from '#modules/auth/ports/google-identity-verifier'

/**
 * The two issuer strings Google actually stamps on an ID token. A closed set and
 * a Google fact, so it stays a constant here rather than an env var.
 */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/**
 * Verifies a Google ID token against Google's published signing keys. No client
 * secret: this is public-key crypto. `createRemoteJWKSet` fetches and caches the
 * key set itself (honouring `Cache-Control`), so this is the app's first
 * outbound dependency but not a hand-rolled HTTP client.
 *
 * Takes the SLICE of config it reads, like `JwtTokenSigner` — a variable added
 * elsewhere cannot break this class by merely existing.
 */
export class JoseGoogleIdentityVerifier implements IGoogleIdentityVerifier {
  readonly #clientId: string
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(config: Pick<AuthConfig, 'GOOGLE_CLIENT_ID' | 'GOOGLE_JWKS_URI'>) {
    this.#clientId = config.GOOGLE_CLIENT_ID
    this.#jwks = createRemoteJWKSet(new URL(config.GOOGLE_JWKS_URI))
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.#jwks, {
        issuer: GOOGLE_ISSUERS,
        // Load-bearing, not decoration: without the audience pin, a token minted
        // for any other Google client id would verify here. Covered by the
        // "different client id" regression test.
        audience: this.#clientId,
      })

      if (payload.email_verified !== true) throw new InvalidGoogleIdentityError()
      if (typeof payload.email !== 'string') throw new InvalidGoogleIdentityError()
      if (typeof payload.sub !== 'string') throw new InvalidGoogleIdentityError()

      return { subject: payload.sub, email: payload.email }
    } catch {
      // One error for every failure mode — see `InvalidGoogleIdentityError`.
      throw new InvalidGoogleIdentityError()
    }
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test:integration jose-google-identity-verifier`
Expected: PASS (7 tests).
Run: `pnpm typecheck` — expect PASS.

- [ ] **Step 8: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/ports/google-identity-verifier.ts src/modules/auth/errors/invalid-google-identity-error.ts src/modules/auth/infra/providers/jose-google-identity-verifier.ts tests/integration/setup/google-jwks.ts tests/integration/jose-google-identity-verifier.spec.ts
git commit -m "feat(auth): jose-backed Google ID token verifier"
```

---

## Task 8: `SignInWithGoogleUseCase` + its two conflict errors + the link email

**Files:**
- Create: `src/modules/auth/errors/google-link-requires-password-error.ts`
- Create: `src/modules/auth/errors/google-sign-in-conflict-error.ts`
- Modify: `src/modules/auth/notifications/emails.ts`
- Modify: `src/modules/auth/notifications/emails.spec.ts`
- Create: `src/modules/auth/use-cases/sign-in-with-google.ts`
- Create: `src/modules/auth/use-cases/sign-in-with-google.spec.ts`

**Interfaces:**
- Consumes: `FederatedIdentity`, `GOOGLE_PROVIDER` (Task 1); `User.createFederated` (Task 2); `IFederatedIdentitiesRepository`, `InMemoryFederatedIdentitiesRepository` (Task 4); `IPendingRegistrationsRepository.deleteAllByEmail` (Task 5); `IGoogleIdentityVerifier`, `InvalidGoogleIdentityError` (Task 7); existing `IUsersRepository`, `IAuthUnitOfWork`, `RefreshTokenIssuer`, `ITokenSigner`, `IHashProvider`, `IIdGenerator`, `IClock`, `IEmailSender`, `InvalidCredentialsError`, `EmailAlreadyInUseError`, `Email`.
- Produces:
  - `class GoogleLinkRequiresPasswordError extends ConflictError` — `code = 'GOOGLE_LINK_REQUIRES_PASSWORD'`.
  - `class GoogleSignInConflictError extends ConflictError` — `code = 'GOOGLE_SIGN_IN_CONFLICT'`.
  - `function googleAccountLinkedEmail(to: Email): EmailMessage`
  - `interface SignInWithGoogleCommand { idToken: string; password?: string }`
  - `interface SignInWithGoogleResult { accessToken: string; refreshToken: string }`
  - `class SignInWithGoogleUseCase` with constructor `(googleVerifier: IGoogleIdentityVerifier, usersRepository: Pick<IUsersRepository, 'findById' | 'findByEmail'>, federatedIdentities: Pick<IFederatedIdentitiesRepository, 'findByProviderUserId'>, refreshTokensRepository: Pick<IRefreshTokensRepository, 'save'>, uow: IAuthUnitOfWork, refreshTokenIssuer: RefreshTokenIssuer, tokenSigner: ITokenSigner, hashProvider: IHashProvider, idGenerator: IIdGenerator, clock: IClock, emailSender: IEmailSender)` and `execute(command): Promise<SignInWithGoogleResult>`.

- [ ] **Step 1: Write the two errors and the email**

Create `src/modules/auth/errors/google-link-requires-password-error.ts`:

```ts
import { ConflictError } from '#shared/errors/app-error'

const GOOGLE_LINK_REQUIRES_PASSWORD_CODE = 'GOOGLE_LINK_REQUIRES_PASSWORD'
const GOOGLE_LINK_REQUIRES_PASSWORD_MESSAGE =
  'This email already has a password account; supply the password to link Google'

/**
 * Google sign-in landed on an email that already has a password account, and no
 * password was supplied to prove ownership.
 *
 * Deliberately specific — "this email already has a password account" — and that
 * is safe here alone: the caller already proved control of the address through
 * Google, so this is not an enumeration oracle (decision §6, item 3). It is the
 * one place in `auth` where telling the truth costs nothing.
 */
export class GoogleLinkRequiresPasswordError extends ConflictError {
  readonly code = GOOGLE_LINK_REQUIRES_PASSWORD_CODE

  constructor() {
    super(GOOGLE_LINK_REQUIRES_PASSWORD_MESSAGE)
  }
}
```

Create `src/modules/auth/errors/google-sign-in-conflict-error.ts`:

```ts
import { ConflictError } from '#shared/errors/app-error'

const GOOGLE_SIGN_IN_CONFLICT_CODE = 'GOOGLE_SIGN_IN_CONFLICT'
const GOOGLE_SIGN_IN_CONFLICT_MESSAGE = 'This email cannot be linked to this Google account'

/**
 * Google sign-in landed on an email that already belongs to a federated-only
 * account whose provider subject does not match — a Google account that was
 * deleted and recreated, or a second subject for one address over time. There is
 * no password to require and no safe merge, so the sign-in fails. Generic on
 * purpose: no client action resolves it.
 */
export class GoogleSignInConflictError extends ConflictError {
  readonly code = GOOGLE_SIGN_IN_CONFLICT_CODE

  constructor() {
    super(GOOGLE_SIGN_IN_CONFLICT_MESSAGE)
  }
}
```

In `src/modules/auth/notifications/emails.ts`, add a subject constant next to the others and the function next to `passwordChangedEmail`:

```ts
const GOOGLE_ACCOUNT_LINKED_SUBJECT = 'A Google sign-in was connected to your account'
```
```ts
/**
 * Sent when Google sign-in is linked to an account that already had a password.
 * The link means someone can now sign in without the password, so the owner
 * finding out is what makes an unwanted link recoverable — the same role
 * `passwordChangedEmail` plays for the password change.
 */
export function googleAccountLinkedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: GOOGLE_ACCOUNT_LINKED_SUBJECT,
    text:
      'Sign in with Google was just connected to your account.\n\n' +
      'If this was not you, reset your password immediately — whoever ' +
      'connected it can then sign in without your password.',
  }
}
```

In `src/modules/auth/notifications/emails.spec.ts`, add:

```ts
describe('googleAccountLinkedEmail', () => {
  it('addresses the owner and tells them how to react', () => {
    const message = googleAccountLinkedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('google')
    expect(message.text.toLowerCase()).toContain('reset your password')
  })
})
```
(Add `googleAccountLinkedEmail` to the import.)

- [ ] **Step 2: Write the failing use-case spec**

Create `src/modules/auth/use-cases/sign-in-with-google.spec.ts`:

```ts
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { FederatedIdentity, GOOGLE_PROVIDER } from '#modules/auth/entities/federated-identity'
import { User } from '#modules/auth/entities/user'
import { GoogleLinkRequiresPasswordError } from '#modules/auth/errors/google-link-requires-password-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import { InvalidGoogleIdentityError } from '#modules/auth/errors/invalid-google-identity-error'
import { InMemoryFederatedIdentitiesRepository } from '#modules/auth/infra/in-memory/in-memory-federated-identities-repository'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { googleAccountLinkedEmail } from '#modules/auth/notifications/emails'
import type { GoogleIdentity, IGoogleIdentityVerifier } from '#modules/auth/ports/google-identity-verifier'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { SignInWithGoogleUseCase } from '#modules/auth/use-cases/sign-in-with-google'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender, EmailMessage } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenGenerator } from '#shared/ports/token-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const EMAIL = 'ana@example.com'
const SUBJECT = 'google-subject-1234567890'
const ID_TOKEN = 'the.raw.id-token'
const APP_PASSWORD = 'sup3r-s3cr3t!'
const STORED_HASH = 'hashed:sup3r-s3cr3t!'
const DUMMY_HASH = 'hashed:dummy'
const NOW = new Date('2026-09-08T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')
const ACCESS_TOKEN = 'signed.access.token'
const GENERATED_ID = 'generated-uuid'
const FAMILY_ID = 'generated-uuid' // idGenerator returns the same stub value
const OPAQUE = 'opaque-refresh-token'
const REFRESH_TTL_SECONDS = 5_184_000

// Call-order log, asserted whole with toEqual so a deletion or reorder fails.
const VERIFY = 'verify'
const HASH_COMPARE = 'compare'
const UOW = 'uow'
const COMMIT = 'commit'
const SEND_EMAIL = 'sendEmail'

let callLog: string[]
let identity: GoogleIdentity
let verifyResult: () => Promise<GoogleIdentity>
let users: InMemoryUsersRepository
let federatedIdentities: InMemoryFederatedIdentitiesRepository
let refreshTokens: InMemoryRefreshTokensRepository
let sentEmails: EmailMessage[]
let compareResult: boolean
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let useCase: SignInWithGoogleUseCase

const verifier: IGoogleIdentityVerifier = { verify: () => verifyResult() }

const hashProvider: IHashProvider = {
  hash: async () => STORED_HASH,
  compare: async () => {
    callLog.push(HASH_COMPARE)
    return compareResult
  },
  dummyHash: DUMMY_HASH,
}

const tokenSigner: ITokenSigner = {
  sign: async () => ACCESS_TOKEN,
  verify: async () => ({ sub: USER_ID }),
}

const idGenerator: IIdGenerator = { generate: () => GENERATED_ID }
const clock: IClock = { now: () => NOW }

const tokenGenerator: ITokenGenerator = { opaque: () => OPAQUE, numericCode: () => '000000' }
const tokenDigest: ITokenDigest = { hash: (v: string) => `digest:${v}` }
const refreshTokenIssuer = new RefreshTokenIssuer(
  tokenGenerator,
  tokenDigest,
  idGenerator,
  REFRESH_TTL_SECONDS,
)

const emailSender: IEmailSender = {
  send: async (message) => {
    callLog.push(SEND_EMAIL)
    sentEmails.push(message)
  },
}

const storePasswordUser = () =>
  users.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: STORED_HASH,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

const storeFederatedUser = () =>
  users.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash: null,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

const linkFor = (userId: string) =>
  FederatedIdentity.create({
    id: 'existing-link',
    userId,
    provider: GOOGLE_PROVIDER,
    providerUserId: SUBJECT,
    emailAtLink: Email.fromTrusted(EMAIL),
    now: CREATED_AT,
  })

beforeEach(() => {
  callLog = []
  sentEmails = []
  identity = { subject: SUBJECT, email: EMAIL }
  verifyResult = async () => {
    callLog.push(VERIFY)
    return identity
  }
  compareResult = true
  users = new InMemoryUsersRepository()
  federatedIdentities = new InMemoryFederatedIdentitiesRepository()
  refreshTokens = new InMemoryRefreshTokensRepository()

  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW)
    const repos: AuthRepos = {
      ...noopAuthRepos(),
      users,
      refreshTokens,
      federatedIdentities,
      pendingRegistrations: {
        ...noopAuthRepos().pendingRegistrations,
        deleteAllByEmail: vi.fn(async () => {}),
      },
    }
    const result = await work(repos)
    callLog.push(COMMIT)
    return result
  })

  useCase = new SignInWithGoogleUseCase(
    verifier,
    users,
    federatedIdentities,
    refreshTokens,
    uowSpy as unknown as AuthRepos extends never ? never : any, // see note
    refreshTokenIssuer,
    tokenSigner,
    hashProvider,
    idGenerator,
    clock,
    emailSender,
  )
})
```

> **Note for the implementer:** type `uowSpy` with the project's `IAuthUnitOfWork` shape exactly as `reset-password.spec.ts` does (`Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>`), and pass it without the `as unknown as ...` cast — that line is a stand-in. Mirror `reset-password.spec.ts`'s `uowSpy` wiring; the only addition here is `federatedIdentities` and the `deleteAllByEmail` spy on the repos object.

Now the cases (append):

```ts
describe('SignInWithGoogleUseCase — already linked (fast path)', () => {
  it('loads the user, issues a session, and does NOT open a transaction', async () => {
    storePasswordUser()
    await federatedIdentities.save(linkFor(USER_ID))

    const result = await useCase.execute({ idToken: ID_TOKEN })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE })
    expect(refreshTokens.rows).toHaveLength(1)
    expect(callLog).toEqual([VERIFY])
    expect(uowSpy).not.toHaveBeenCalled()
  })
})

describe('SignInWithGoogleUseCase — new email', () => {
  it('creates a verified passwordless account, links it, clears pendings, issues a session, all in one uow', async () => {
    const deleteAll = vi.fn(async () => {})
    uowSpy.mockImplementation(async (work) => {
      callLog.push(UOW)
      const repos: AuthRepos = {
        ...noopAuthRepos(),
        users,
        refreshTokens,
        federatedIdentities,
        pendingRegistrations: { ...noopAuthRepos().pendingRegistrations, deleteAllByEmail: deleteAll },
      }
      const r = await work(repos)
      callLog.push(COMMIT)
      return r
    })

    const result = await useCase.execute({ idToken: ID_TOKEN })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    const [created] = users.users
    expect(created?.passwordHash).toBeNull()
    expect(created?.emailVerifiedAt).toEqual(NOW)
    expect(federatedIdentities.rows).toHaveLength(1)
    expect(federatedIdentities.rows[0]?.userId).toBe(created?.id)
    expect(deleteAll).toHaveBeenCalledOnce()
    expect(refreshTokens.rows).toHaveLength(1)
    expect(callLog).toEqual([VERIFY, UOW, COMMIT])
  })
})

describe('SignInWithGoogleUseCase — email has a password account', () => {
  it('refuses without a password, writing nothing', async () => {
    storePasswordUser()

    await expect(useCase.execute({ idToken: ID_TOKEN })).rejects.toBeInstanceOf(
      GoogleLinkRequiresPasswordError,
    )
    expect(federatedIdentities.rows).toHaveLength(0)
    expect(refreshTokens.rows).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('rejects a wrong password after running argon2 OUTSIDE the uow, writing nothing', async () => {
    storePasswordUser()
    compareResult = false

    await expect(
      useCase.execute({ idToken: ID_TOKEN, password: 'wrong' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
    expect(callLog).toEqual([VERIFY, HASH_COMPARE])
    expect(uowSpy).not.toHaveBeenCalled()
  })

  it('links on the right password: identity + refresh token in one uow, then the warning email after commit', async () => {
    storePasswordUser()

    const result = await useCase.execute({ idToken: ID_TOKEN, password: APP_PASSWORD })

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: OPAQUE })
    expect(federatedIdentities.rows).toHaveLength(1)
    expect(federatedIdentities.rows[0]?.userId).toBe(USER_ID)
    expect(refreshTokens.rows).toHaveLength(1)
    expect(users.users).toHaveLength(1) // no new user
    expect(sentEmails).toEqual([googleAccountLinkedEmail(Email.fromTrusted(EMAIL))])
    expect(callLog).toEqual([VERIFY, HASH_COMPARE, UOW, COMMIT, SEND_EMAIL])
  })
})

describe('SignInWithGoogleUseCase — email is a federated-only account with a mismatched subject', () => {
  it('fails with GoogleSignInConflictError, writing nothing', async () => {
    storeFederatedUser() // has NO federated_identities row for SUBJECT

    await expect(useCase.execute({ idToken: ID_TOKEN })).rejects.toMatchObject({
      code: 'GOOGLE_SIGN_IN_CONFLICT',
    })
    expect(federatedIdentities.rows).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })
})

describe('SignInWithGoogleUseCase — bad identity', () => {
  it('propagates InvalidGoogleIdentityError and touches nothing', async () => {
    verifyResult = async () => {
      throw new InvalidGoogleIdentityError()
    }

    await expect(useCase.execute({ idToken: ID_TOKEN })).rejects.toBeInstanceOf(
      InvalidGoogleIdentityError,
    )
    expect(users.users).toHaveLength(0)
    expect(uowSpy).not.toHaveBeenCalled()
  })
})
```

> Check the real `ITokenGenerator` / `ITokenDigest` / `IClock` / `IEmailSender` / `IIdGenerator` shapes and import them from their actual paths; the stubs above follow `reset-password.spec.ts`. If `RefreshTokenIssuer` needs different collaborators, mirror how `reset-password.spec.ts` or `change-password.spec.ts` builds it.

- [ ] **Step 3: Run the spec to verify it fails**

Run: `pnpm test:unit src/modules/auth/use-cases/sign-in-with-google.spec.ts`
Expected: FAIL — cannot find `SignInWithGoogleUseCase`.

- [ ] **Step 4: Write the use case**

Create `src/modules/auth/use-cases/sign-in-with-google.ts`:

```ts
import {
  FederatedIdentity,
  GOOGLE_PROVIDER,
} from '#modules/auth/entities/federated-identity'
import { User } from '#modules/auth/entities/user'
import { GoogleLinkRequiresPasswordError } from '#modules/auth/errors/google-link-requires-password-error'
import { GoogleSignInConflictError } from '#modules/auth/errors/google-sign-in-conflict-error'
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import type { IGoogleIdentityVerifier } from '#modules/auth/ports/google-identity-verifier'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IFederatedIdentitiesRepository } from '#modules/auth/repositories/federated-identities-repository'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { googleAccountLinkedEmail } from '#modules/auth/notifications/emails'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. */
export interface SignInWithGoogleCommand {
  idToken: string
  /** Present only when linking over an existing password account. */
  password?: string
}

export interface SignInWithGoogleResult {
  accessToken: string
  refreshToken: string
}

/**
 * Verifies a Google ID token and hands back the project's own session, creating
 * or linking a local account.
 *
 * Five branches (design §5): an already-linked subject fast-paths with a single
 * write and no transaction, like `login`; a new email creates a verified
 * passwordless account, clears any pending registrations for the address, links,
 * and issues — all in one `uow`; an email that already has a PASSWORD account is
 * refused until the password proves ownership, and only then linked; a
 * federated-only account whose subject does not match is a conflict.
 *
 * argon2 runs only on the link path, and OUTSIDE the transaction (§8 of the unit
 * of work design). No decoy hash on the other branches: unlike `confirm`, the
 * outcomes here are public by design — the caller knows whether it sent a
 * password — so there is no timing signal to mask.
 */
export class SignInWithGoogleUseCase {
  constructor(
    private readonly googleVerifier: IGoogleIdentityVerifier,
    private readonly usersRepository: Pick<IUsersRepository, 'findById' | 'findByEmail'>,
    private readonly federatedIdentities: Pick<
      IFederatedIdentitiesRepository,
      'findByProviderUserId'
    >,
    private readonly refreshTokensRepository: Pick<IRefreshTokensRepository, 'save'>,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly hashProvider: IHashProvider,
    private readonly idGenerator: IIdGenerator,
    private readonly clock: IClock,
    private readonly emailSender: IEmailSender,
  ) {}

  async execute(command: SignInWithGoogleCommand): Promise<SignInWithGoogleResult> {
    const identity = await this.googleVerifier.verify(command.idToken)
    const email = Email.create(identity.email)
    // Read ONCE (R7): stamps the user, its verification, the link row and the
    // first refresh token — columns a transaction makes atomic on the new-email
    // branch.
    const now = this.clock.now()

    const linked = await this.federatedIdentities.findByProviderUserId(
      GOOGLE_PROVIDER,
      identity.subject,
    )
    if (linked !== null) {
      // Fast path: one write, no transaction, exactly like `login`.
      const user = await this.usersRepository.findById(linked.userId)
      if (user === null) throw new GoogleSignInConflictError()
      return this.#issueSession(user.id, now)
    }

    const existing = await this.usersRepository.findByEmail(email)

    if (existing === null) {
      return this.#createAccountAndLink(email, identity.subject, now)
    }

    if (existing.passwordHash === null) {
      // A federated-only account for this address whose subject did not match
      // above: recreated Google account, or a second subject for one email. No
      // password to require, no safe merge.
      throw new GoogleSignInConflictError()
    }

    // The email has a PASSWORD account: no silent merge (design §5, §6 item 3).
    if (command.password === undefined) throw new GoogleLinkRequiresPasswordError()

    // argon2, outside any transaction.
    const matches = await this.hashProvider.compare(
      command.password,
      existing.passwordHash,
    )
    if (!matches) throw new InvalidCredentialsError()

    const link = FederatedIdentity.create({
      id: this.idGenerator.generate(),
      userId: existing.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: identity.subject,
      emailAtLink: email,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      existing.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(async ({ federatedIdentities, refreshTokens }) => {
      await federatedIdentities.save(link)
      await refreshTokens.save(issued.entity)
    })

    // After the commit, best-effort: the link is already made and a failed send
    // must not undo it (the composition root hands this a best-effort sender).
    await this.emailSender.send(googleAccountLinkedEmail(existing.email))

    return {
      accessToken: await this.tokenSigner.sign({ sub: existing.id }),
      refreshToken: issued.token,
    }
  }

  async #createAccountAndLink(
    email: Email,
    subject: string,
    now: Date,
  ): Promise<SignInWithGoogleResult> {
    const user = User.createFederated({ id: this.idGenerator.generate(), email, now })
    const link = FederatedIdentity.create({
      id: this.idGenerator.generate(),
      userId: user.id,
      provider: GOOGLE_PROVIDER,
      providerUserId: subject,
      emailAtLink: email,
      now,
    })
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )

    await this.uow(
      async ({ users, pendingRegistrations, federatedIdentities, refreshTokens }) => {
        // A concurrent confirm/google that won the unique index on `email`
        // surfaces here as EmailAlreadyInUseError, leaves the uow (rollback),
        // and maps to 409 EMAIL_ALREADY_IN_USE. No remap: Google proved the
        // email, so the specific 409 leaks nothing new.
        await users.save(user)
        await pendingRegistrations.deleteAllByEmail(email)
        await federatedIdentities.save(link)
        await refreshTokens.save(issued.entity)
      },
    )

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }

  async #issueSession(userId: string, now: Date): Promise<SignInWithGoogleResult> {
    const issued = this.refreshTokenIssuer.issue(
      userId,
      this.refreshTokenIssuer.newFamilyId(),
      now,
    )
    await this.refreshTokensRepository.save(issued.entity)

    return {
      accessToken: await this.tokenSigner.sign({ sub: userId }),
      refreshToken: issued.token,
    }
  }
}
```

- [ ] **Step 5: Run the spec to verify it passes**

Run: `pnpm test:unit src/modules/auth/use-cases/sign-in-with-google.spec.ts src/modules/auth/notifications/emails.spec.ts`
Expected: PASS.
Run: `pnpm typecheck` — expect PASS.

- [ ] **Step 6: Lint and commit**

```bash
pnpm lint:fix
git add src/modules/auth/errors/google-link-requires-password-error.ts src/modules/auth/errors/google-sign-in-conflict-error.ts src/modules/auth/notifications/emails.ts src/modules/auth/notifications/emails.spec.ts src/modules/auth/use-cases/sign-in-with-google.ts src/modules/auth/use-cases/sign-in-with-google.spec.ts
git commit -m "feat(auth): SignInWithGoogleUseCase"
```

---

## Task 9: HTTP endpoint, container wiring, end-to-end test

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/sign-in-with-google.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Modify: `src/modules/auth/infra/http/constants.ts`
- Modify: `src/modules/auth/container.ts`
- Create: `tests/integration/sign-in-with-google.spec.ts`

**Interfaces:**
- Consumes: `SignInWithGoogleUseCase` (Task 8), `JoseGoogleIdentityVerifier` (Task 7), the `federatedIdentities` repo already on `authRepositories` (Task 4), config (Task 6), the JWKS test helper (Task 7).
- Produces:
  - `POST /auth/google` route registered in `authRoutes`.
  - `CONFLICT_STATUS = 409` in the auth HTTP constants.
  - `AuthContainer.signInWithGoogle`, `AuthContainer.googleSignInRateLimit`.

- [ ] **Step 1: Add the 409 constant**

In `src/modules/auth/infra/http/constants.ts`, add next to `NOT_FOUND_STATUS`:

```ts
/**
 * A conflict with the current state. Google sign-in produces it two ways: the
 * email already has a password account and no password was supplied to link
 * (`GOOGLE_LINK_REQUIRES_PASSWORD`), or the address belongs to a mismatched
 * federated-only account (`GOOGLE_SIGN_IN_CONFLICT`).
 */
export const CONFLICT_STATUS = 409
```

- [ ] **Step 2: Write the endpoint**

Create `src/modules/auth/infra/http/endpoints/sign-in-with-google.ts` (model on `login.ts`):

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  CONFLICT_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  REFRESH_TRANSPORT_COOKIE,
  refreshTransportSchema,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'
import { sessionTokensSchema } from '#modules/auth/infra/http/session-tokens'
import { MAX_PASSWORD_LENGTH } from '#modules/auth/value-objects/password'

const GOOGLE_PATH = '/google'
const GOOGLE_SUMMARY = 'Sign in with Google'
const GOOGLE_DESCRIPTION =
  'Exchanges a Google ID token for a session. If the email already has a ' +
  'password account, answers 409 GOOGLE_LINK_REQUIRES_PASSWORD; resend the ' +
  'same request with `password` set to that account's password to link Google ' +
  'and receive the session.'

/** Presence, not policy — like `login`: an account made under any password rule must be linkable. */
const MIN_SUBMITTED_PASSWORD_LENGTH = 1
/** A Google ID token is a ~1-2 KB JWT; the ceiling keeps a 10 MB body from reaching crypto. */
const MAX_ID_TOKEN_LENGTH = 4096

const bodySchema = z
  .object({
    idToken: z.string().min(1).max(MAX_ID_TOKEN_LENGTH),
    password: z
      .string()
      .min(MIN_SUBMITTED_PASSWORD_LENGTH)
      .max(MAX_PASSWORD_LENGTH)
      .optional(),
    refreshTransport: refreshTransportSchema,
  })
  .strict()

export const signInWithGoogleRoute: FastifyPluginAsync<{
  container: AuthContainer
}> = async (app, { container }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    GOOGLE_PATH,
    {
      /**
       * Its own ceiling, like login: the link path of this route carries a
       * password guess. Own numbers, not login's — a field named for one route
       * used by another is a comment that lies.
       */
      config: { rateLimit: container.googleSignInRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: GOOGLE_SUMMARY,
        description: GOOGLE_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: sessionTokensSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [CONFLICT_STATUS]: errorResponseSchema,
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
          // Opens a transaction on the create / link branches.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.signInWithGoogle.execute(
        request.body,
      )

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}
```

Confirm `MAX_PASSWORD_LENGTH` is exported from `value-objects/password.ts` (it is used by `login.ts`); confirm `SERVICE_UNAVAILABLE_STATUS` is exported from the auth HTTP constants (it is).

- [ ] **Step 3: Register the route**

In `src/modules/auth/infra/http/routes.ts`:
1. Import `signInWithGoogleRoute`.
2. Add `await app.register(signInWithGoogleRoute, { container })` next to `loginRoute` (anonymous route, no `guard`).

- [ ] **Step 4: Wire the container**

In `src/modules/auth/container.ts`:
1. Imports: `JoseGoogleIdentityVerifier` from `./infra/providers/jose-google-identity-verifier.js`, `SignInWithGoogleUseCase` from `./use-cases/sign-in-with-google.js`.
2. Destructure `federatedIdentities: federatedIdentitiesRepository` from `authRepositories(db)`.
3. After `refreshTokenIssuer` is built, add:
   ```ts
   const googleIdentityVerifier = new JoseGoogleIdentityVerifier(config)
   ```
4. In the returned object, add:
   ```ts
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
     bestEffortEmailSender,
   ),
   ```
5. Add the rate-limit entry next to `loginRateLimit`:
   ```ts
   /**
    * Its own ceiling, like login: the link path carries a password guess.
    * Milliseconds because that is what the limiter's `timeWindow` takes.
    */
   googleSignInRateLimit: {
     max: config.GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
     timeWindow:
       config.GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
   },
   ```

Run: `pnpm typecheck` — expect PASS.

- [ ] **Step 5: Write the failing end-to-end test**

Create `tests/integration/sign-in-with-google.spec.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { clearMailpit, messageCount, waitForMessageCount } from './setup/mailpit.js'
import { type GoogleJwksServer, startGoogleJwksServer } from './setup/google-jwks.js'

const GOOGLE_PATH = '/auth/google'
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const CONFIRM_PATH = '/auth/email/verify'
const POST = 'POST'

const OK = 200
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const CONFLICT = 409

const CLIENT_ID = env.GOOGLE_CLIENT_ID
const SUBJECT = 'google-subject-1234567890'
const EMAIL = 'ana@example.com'
const APP_PASSWORD = 'sup3r-s3cr3t!'
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/
const CEILING = 1000
const ONE_MESSAGE = 1

let app: FastifyInstance
let db: Database
let pool: Pool
let jwks: GoogleJwksServer

beforeAll(async () => {
  jwks = await startGoogleJwksServer(CLIENT_ID)
  app = await buildApp({
    ...env,
    GOOGLE_JWKS_URI: jwks.url,
    GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS: CEILING,
    REGISTER_RATE_LIMIT_MAX_REQUESTS: CEILING,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING,
    EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS: CEILING,
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: 0,
  })
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
  await jwks.close()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(federatedIdentities)
  await db.delete(pendingRegistrations)
  await db.delete(users)
  await clearMailpit()
})

const idToken = (claims: Record<string, unknown> = {}) =>
  jwks.sign({ sub: SUBJECT, email: EMAIL, ...claims })

const googleSignIn = async (payload: Record<string, unknown>) =>
  app.inject({ method: POST, url: GOOGLE_PATH, payload })

describe('POST /auth/google', () => {
  it('creates a verified passwordless account for a new email and returns a session', async () => {
    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(OK)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    expect(response.json().refreshToken).toEqual(expect.any(String))

    const [row] = await db.select().from(users).where(eq(users.email, EMAIL))
    expect(row?.passwordHash).toBeNull()
    expect(row?.emailVerifiedAt).not.toBeNull()

    const [link] = await db.select().from(federatedIdentities)
    expect(link?.providerUserId).toBe(SUBJECT)
  })

  it('takes the fast path on the second sign-in — no new link row', async () => {
    await googleSignIn({ idToken: await idToken() })
    const second = await googleSignIn({ idToken: await idToken() })

    expect(second.statusCode).toBe(OK)
    expect(await db.select().from(federatedIdentities)).toHaveLength(1)
  })

  it('answers 409 when the email already has a password account and no password is sent', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(CONFLICT)
    expect(response.json().error.code).toBe('GOOGLE_LINK_REQUIRES_PASSWORD')
  })

  it('links to the password account when the right password is supplied, and emails a warning', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({
      idToken: await idToken(),
      password: APP_PASSWORD,
    })

    expect(response.statusCode).toBe(OK)
    expect(await db.select().from(federatedIdentities)).toHaveLength(1)
    await waitForMessageCount(ONE_MESSAGE)
  })

  it('answers 401 for a wrong password on the link path', async () => {
    await createPasswordAccount()

    const response = await googleSignIn({ idToken: await idToken(), password: 'wrong' })

    expect(response.statusCode).toBe(UNAUTHORIZED)
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS')
  })

  it('clears a pending registration for the address (Google wins)', async () => {
    await app.inject({ method: POST, url: REGISTER_PATH, payload: { email: EMAIL } })
    await waitForMessageCount(ONE_MESSAGE)
    await clearMailpit()

    const response = await googleSignIn({ idToken: await idToken() })

    expect(response.statusCode).toBe(OK)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('sets an HttpOnly refresh cookie in cookie mode', async () => {
    const response = await googleSignIn({
      idToken: await idToken(),
      refreshTransport: 'cookie',
    })

    expect(response.statusCode).toBe(OK)
    expect(response.json().refreshToken).toBeUndefined()
    expect(response.headers['set-cookie']).toEqual(
      expect.stringContaining('refresh_token='),
    )
  })

  it('rejects an unknown field with 400 (.strict())', async () => {
    const response = await googleSignIn({ idToken: await idToken(), role: 'admin' })

    expect(response.statusCode).toBe(BAD_REQUEST)
  })

  it('answers 401 for an unverified-email token', async () => {
    const response = await googleSignIn({
      idToken: await idToken({ email_verified: false }),
    })

    expect(response.statusCode).toBe(UNAUTHORIZED)
    expect(response.json().error.code).toBe('INVALID_GOOGLE_IDENTITY')
  })
})

/** Registers, confirms with a password, so the address has a real password account. */
async function createPasswordAccount(): Promise<void> {
  await app.inject({ method: POST, url: REGISTER_PATH, payload: { email: EMAIL } })
  await waitForMessageCount(ONE_MESSAGE)
  const { extractVerificationCode, latestMessage } = await import('./setup/mailpit.js')
  const code = extractVerificationCode((await latestMessage()).text)
  await app.inject({
    method: POST,
    url: CONFIRM_PATH,
    payload: { email: EMAIL, code, password: APP_PASSWORD, refreshTransport: 'body' },
  })
  await clearMailpit()
}
```
Adjust the `mailpit.js` helper imports to match its real exports (see `verify-email.spec.ts`). Prefer a top-level `import` over the inline `await import(...)` if the helper names allow.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:integration sign-in-with-google`
Expected: PASS.

- [ ] **Step 7: Full suite, lint, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

```bash
git add src/modules/auth/infra/http/endpoints/sign-in-with-google.ts src/modules/auth/infra/http/routes.ts src/modules/auth/infra/http/constants.ts src/modules/auth/container.ts tests/integration/sign-in-with-google.spec.ts
git commit -m "feat(auth): POST /auth/google endpoint and container wiring"
```

---

## Task 10: Documentation — README, decision 31, TODO

**Files:**
- Modify: `src/modules/auth/README.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TODO.md`

**Interfaces:** none — docs only.

- [ ] **Step 1: Update the module README**

In `src/modules/auth/README.md`:
- Add a row to the endpoints table: `| \`POST /google\` | Troca um ID token do Google por uma sessão; cria ou vincula a conta | não |`.
- Add a "Login com Google" section under "Fluxos" describing: the client obtains the ID token; `POST /auth/google { idToken, password?, refreshTransport? }`; new email → verified passwordless account; already linked → session; email with a password account → `409 GOOGLE_LINK_REQUIRES_PASSWORD`, resend with `password`; wrong password → `401`.
- In "O que este módulo **não** faz (ainda)", replace the "Login social / OAuth (Google)" bullet with the remaining gaps: fluxo redirect/BFF, desvincular provedor, definir primeira senha numa conta só-Google, listar provedores no `/me`, restrição de domínio `hd`.
- Add to "Garantias que um consumidor pode assumir": `POST /auth/google` só emite sessão para um ID token com `email_verified: true`; a recusa `409 GOOGLE_LINK_REQUIRES_PASSWORD` é específica de propósito (o Google já provou o e-mail).

- [ ] **Step 2: Add decision 31**

In `docs/DECISIONS.md`, add after decision 30:

```markdown
### 31 — Login com Google: client-driven, verificação de ID token, sem merge silencioso

A fatia 14 entrega `POST /auth/google`. O cliente roda o SDK do Google e manda o
**ID token**; a API verifica a assinatura contra o JWKS público (`jose`,
`createRemoteJWKSet` + `jwtVerify`), **sem client secret**. O fluxo redirect/BFF
(`/start` + `/callback`, com `state`+PKCE e `GOOGLE_CLIENT_SECRET`) fica para uma
fatia futura que reusa o núcleo de vínculo desta.

- **Tabela `federated_identities`** — `(provider, provider_user_id)` e
  `(user_id, provider)` únicos, FK para `users` com `ON DELETE CASCADE`. Não
  guarda token do Google, só a identidade.
- **`users.password_hash` passa a aceitar `NULL`** — uma conta federada não tem
  senha. `login` já a trata pelo decoy (`?? dummyHash`); `change-password` ganha
  um guard.
- **Sem merge silencioso.** Google sobre um e-mail com conta-senha responde
  `409 GOOGLE_LINK_REQUIRES_PASSWORD`; o cliente repete com a senha do app, que é
  conferida (argon2 fora da transação) antes de vincular. A recusa é específica —
  seguro aqui porque o IdP já provou o endereço.
- **`GOOGLE_CLIENT_ID` obrigatório no boot**, como `JWT_SECRET`. `GOOGLE_JWKS_URI`
  entra no env com default de produção (padrão do `MAIL_HOST`), para o teste de
  integração apontar para um JWKS local.

Resolve os itens 1, 2 e 3 de "Login social / OAuth (Google primeiro)" da §6:
sem troca de e-mail (casa por `sub`, `email_at_link` só audita); Google ganha de
um cadastro pendente (conta nasce verificada, pendentes apagados); Google sobre
conta-senha exige a senha.

Desenho completo em
[`specs/2026-09-08-google-sign-in-design.md`](superpowers/specs/2026-09-08-google-sign-in-design.md).
```

In §6, under "Login social / OAuth (Google primeiro)", mark the item resolved: prefix the heading with `~~...~~` **RESOLVIDA pela fatia 14 (decisão 31)** in the same style slice 11/12 used for verificação/recuperação, keeping the three sub-questions as the record.

- [ ] **Step 3: Update the TODO**

In `docs/TODO.md`:
- Update the top note: a new dated line — "Fatia 14 (2026-09-08) entregou o login com Google client-driven; `auth` agora tem identidade federada."
- In "O resto, em ordem decrescente de urgência", change the "Login social / OAuth (Google)" row to `~~Login social / OAuth (Google)~~ **fechado pela fatia 14** (client-driven POST). Falta: fluxo redirect/BFF, desvincular provedor, primeira senha em conta só-Google, listar provedores no /me, restrição de domínio hd`.
- In "O que eu faria a seguir", drop "login social" as the next generic step; the outbox transacional is now the standout, plus the sensitive-data ordering if that applies.

- [ ] **Step 4: Final verification and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS. Record the integration test count went up.

```bash
git add src/modules/auth/README.md docs/DECISIONS.md docs/TODO.md
git commit -m "docs(auth): record the Google sign-in slice (decision 31, README, TODO)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1, §2 formato client-driven | Task 7 (adapter), Task 8 (use case), Task 9 (endpoint) |
| §3.1 `federated_identities` table + indexes | Task 3 |
| §3.2 nullable `password_hash` (entity, schema, mapper, migration, login, change-password) | Task 2 |
| §3.3 no new cron job | Task 9 (container — none added); noted |
| §4.1 `FederatedIdentity` entity | Task 1 |
| §4.2 `IGoogleIdentityVerifier` port | Task 7 |
| §4.3 `JoseGoogleIdentityVerifier` (config slice, JWKS URI env) | Task 6 (config), Task 7 (adapter) |
| §4.4 `IFederatedIdentitiesRepository` (+ in-memory + Drizzle) | Task 4 |
| §4.5 `deleteAllByEmail` | Task 5 |
| §4.6 `AuthRepos.federatedIdentities` + doctrine comment | Task 9 |
| §4.7 `User.createFederated` + mapper | Task 2 |
| §4.8 `login-user.ts` / `change-password.ts` | Task 2 |
| §5 five-branch flow | Task 8 |
| §6.1 endpoint | Task 9 |
| §6.2 three new errors, two reused | Task 7 (`InvalidGoogleIdentityError`), Task 8 (`GoogleLinkRequiresPasswordError`, `GoogleSignInConflictError`) |
| §6.3 `googleAccountLinkedEmail` | Task 8 |
| §7.1 config | Task 6 |
| §7.2 migration (two folders: `password_hash` in Task 2, table in Task 3) | Tasks 2, 3 |
| §7.3 DI | Task 9 |
| §9.1 unit tests | Tasks 1, 2, 8 |
| §9.2 integration tests | Tasks 2, 3, 4, 7, 9 |
| §10 accepted costs | Design record; no code |
| §11 out of scope | Task 10 (README/TODO record) |
| §12 decision 31 | Task 10 |

No gaps. One deviation from spec §7.2: it describes a single migration folder holding both the `password_hash` `DROP NOT NULL` and `CREATE TABLE federated_identities`. The plan generates two — the `DROP NOT NULL` in Task 2 (with the entity change it belongs to) and the table in Task 3 — so each task ends with a green typecheck. Both are new, neither is rewritten, so R4 holds. If the reviewer prefers one folder, Tasks 2 and 3 must merge.

**2. Placeholder scan**

- Task 8 spec has an explicit `as unknown as ...` stand-in with a bracketed note telling the implementer to type `uowSpy` like `reset-password.spec.ts`. This is a known imperfection flagged in prose, not a silent placeholder — the implementer must resolve it against the real `IAuthUnitOfWork` type.
- Tasks 2, 5, 8 say "match the file's existing names / helpers" for spec fixtures — the surrounding code shows the exact shape; concrete enough.
- No "TBD", "add error handling", "similar to Task N", or code-free code steps.

**3. Type consistency**

- `GOOGLE_PROVIDER` / `FederatedProvider` defined in Task 1, consumed by Tasks 4, 8 with the same names.
- `FederatedIdentity.create` / `.fromTrusted` prop shapes identical across Tasks 1, 4, 8.
- `IFederatedIdentitiesRepository` methods (`save`, `findByProviderUserId`) identical in Tasks 4, 8, 9.
- `IGoogleIdentityVerifier.verify` → `GoogleIdentity { subject, email }` consistent across Tasks 7, 8, 9.
- `SignInWithGoogleUseCase` constructor arg order in Task 8 matches the `container.ts` call in Task 9.
- `User.createFederated({ id, email, now })` identical in Tasks 2, 8.
- `deleteAllByEmail(email: Email)` identical in Tasks 5, 8, 9 (`noop-auth-repos`).
- `CONFLICT_STATUS` added in Task 9 and used only there.
- Config keys `GOOGLE_CLIENT_ID`, `GOOGLE_JWKS_URI`, `GOOGLE_SIGN_IN_RATE_LIMIT_*` identical across Tasks 6, 7, 9 and the two test-env files.

Consistent.
