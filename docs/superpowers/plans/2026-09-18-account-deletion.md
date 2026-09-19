# Deleção de conta — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DELETE /auth/me` apaga a conta do próprio dono, com hard delete da linha de `users`.

**Architecture:** A linha de `users` é apagada de verdade; as FKs com `onDelete: 'cascade'` que já existem levam junto `refresh_tokens`, `federated_identities` e `password_reset_tokens`. Duas coisas fora do alcance da cascata acontecem na mesma transação: a varredura de `pending_registrations` daquele e-mail (não tem FK, por desenho) e a gravação do aviso no outbox (também sem FK, e é o que o deixa sobreviver à conta). Conta com senha exige a senha, conferida com argon2 **fora** da transação; conta só-Google apaga com a sessão válida.

**Tech Stack:** TypeScript, Fastify, Drizzle (Postgres), Zod, vitest (projetos `unit` e `integration`), argon2, biome.

**Spec:** [`docs/superpowers/specs/2026-09-18-account-deletion-design.md`](../specs/2026-09-18-account-deletion-design.md)

## Global Constraints

- **Sem migration.** As três cascatas já estão declaradas no schema. Nenhuma tarefa aqui cria ou altera tabela.
- **TDD estrito:** o teste que falha vem antes de qualquer linha de produção, e a falha é observada antes do conserto.
- **Todo código, identificador, string e comentário em inglês** (`CLAUDE.md`). Markdown em `docs/` pode ser português.
- **Sem magic number/string:** valor literal vira constante nomeada em `UPPER_SNAKE_CASE`, perto de onde é usada.
- **Comentário explica o código, nunca a task:** proibido escrever "esta fatia", "a review pediu", "slice 20". Aponte para a spec, não reconte o argumento dela.
- **argon2 nunca dentro de uma transação** (§8 do design do unit of work).
- **`IClock` lido uma vez por use case** (R7); nada de `new Date()` sem argumento.
- Banco de teste no ar antes de qualquer teste de integração: `pnpm db:up`.
- Antes de cada commit: `npx tsc --noEmit`, `npx biome check .`, `npx vitest run --project unit`.

---

### Task 1: `accountDeletedEmail`

**Files:**
- Modify: `src/modules/auth/notifications/emails.ts`
- Test: `src/modules/auth/notifications/emails.spec.ts`

**Interfaces:**
- Consumes: `Email` de `#modules/auth/value-objects/email`, `EmailMessage` de `#shared/ports/email-sender`.
- Produces: `accountDeletedEmail(to: Email): EmailMessage` — consumida pela Task 3.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `src/modules/auth/notifications/emails.spec.ts`, e inclua `accountDeletedEmail` no `import` que já existe no topo do arquivo:

```ts
describe('accountDeletedEmail', () => {
  it('addresses the owner and says the account is gone for good', () => {
    const message = accountDeletedEmail(TO)

    expect(message.to).toBe(TO.value)
    expect(message.text.toLowerCase()).toContain('deleted')
    expect(message.text.toLowerCase()).toContain('cannot be undone')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: FAIL — `accountDeletedEmail is not a function` (ou erro de import).

- [ ] **Step 3: Implementar**

Em `src/modules/auth/notifications/emails.ts`, acrescente a constante junto das outras do topo:

```ts
const ACCOUNT_DELETED_SUBJECT = 'Your account was deleted'
```

E a função ao fim do arquivo:

```ts
/**
 * The last message this address receives from the app. Sent for the same
 * reason `passwordChangedEmail` is: if a stolen session asked for the
 * deletion, this is the owner's only chance to find out.
 */
export function accountDeletedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: ACCOUNT_DELETED_SUBJECT,
    text:
      'Your account and every session tied to it were just deleted.\n\n' +
      'This cannot be undone — nothing is kept, and signing up again with ' +
      'this address starts a brand new account.\n\n' +
      'If this was not you, someone had access to your account.',
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/notifications/emails.ts src/modules/auth/notifications/emails.spec.ts
git commit -m "feat(auth): add the account deleted notice"
```

---

### Task 2: `IUsersRepository.deleteById` e a prova da cascata

**Files:**
- Modify: `src/modules/auth/repositories/users-repository.ts`
- Modify: `src/modules/auth/infra/drizzle/drizzle-users-repository.ts`
- Modify: `src/modules/auth/infra/in-memory/in-memory-users-repository.ts`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts`
- Test: `tests/integration/drizzle-users-repository.spec.ts`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `deleteById(id: string): Promise<void>` em `IUsersRepository` — consumida pela Task 3.

- [ ] **Step 1: Escrever o teste de integração que falha**

Acrescente ao fim de `tests/integration/drizzle-users-repository.spec.ts`. Os imports novos vão no topo, junto dos que já existem:

```ts
import { federatedIdentities } from '#modules/auth/infra/drizzle/schema/federated-identities'
import { passwordResetTokens } from '#modules/auth/infra/drizzle/schema/password-reset-tokens'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
```

O `beforeEach` do arquivo hoje só apaga `users`; a cascata cuida das filhas, então ele não muda.

```ts
const HASH_LENGTH = 64
const REFRESH_HASH = 'a'.repeat(HASH_LENGTH)
const RESET_HASH = 'b'.repeat(HASH_LENGTH)
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const GOOGLE_PROVIDER_NAME = 'google'
const GOOGLE_SUBJECT = 'google-subject-1234567890'
const EXPIRES_AT = new Date('2026-12-31T12:00:00.000Z')
const NO_ROWS = 0
const ONE_ROW = 1

/**
 * Distinct ids per child table and per owner: the three tables have their own
 * primary keys, and both users get a full set in the isolation test.
 */
const CHILD_IDS = {
  [ID]: {
    refresh: '44445555-6666-4777-8888-999900001111',
    federated: '44445555-6666-4777-8888-999900002222',
    reset: '44445555-6666-4777-8888-999900003333',
  },
  [OTHER_ID]: {
    refresh: '55556666-7777-4888-8999-000011114444',
    federated: '55556666-7777-4888-8999-000011115555',
    reset: '55556666-7777-4888-8999-000011116666',
  },
} as const

/** Inserts one row in each table that carries a cascading FK to `users`. */
async function storeChildRows(userId: keyof typeof CHILD_IDS) {
  const ids = CHILD_IDS[userId]

  await db.insert(refreshTokens).values({
    id: ids.refresh,
    userId,
    tokenHash: `${REFRESH_HASH}${ids.refresh}`,
    familyId: FAMILY_ID,
    expiresAt: EXPIRES_AT,
    createdAt: NOW,
  })
  await db.insert(federatedIdentities).values({
    id: ids.federated,
    userId,
    provider: GOOGLE_PROVIDER_NAME,
    providerUserId: `${GOOGLE_SUBJECT}-${ids.federated}`,
    emailAtLink: EMAIL,
    createdAt: NOW,
  })
  await db.insert(passwordResetTokens).values({
    id: ids.reset,
    userId,
    tokenHash: `${RESET_HASH}${ids.reset}`,
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    createdAt: NOW,
  })
}

describe('DrizzleUsersRepository.deleteById', () => {
  it('removes the row', async () => {
    await repository.save(makeUser(ID, EMAIL))

    await repository.deleteById(ID)

    expect(await db.select().from(users)).toHaveLength(NO_ROWS)
  })

  it('takes the refresh tokens, federated identities and reset tokens with it', async () => {
    // The cascade is declared in the schema; this is the test that proves
    // Postgres actually applies it, rather than trusting the declaration.
    await repository.save(makeUser(ID, EMAIL))
    await storeChildRows(ID)

    await repository.deleteById(ID)

    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
    expect(await db.select().from(federatedIdentities)).toHaveLength(NO_ROWS)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(NO_ROWS)
  })

  it("never touches another account's rows", async () => {
    await repository.save(makeUser(ID, EMAIL))
    await repository.save(makeUser(OTHER_ID, OTHER_EMAIL))
    await storeChildRows(ID)
    await storeChildRows(OTHER_ID)

    await repository.deleteById(ID)

    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
    expect(await db.select().from(refreshTokens)).toHaveLength(ONE_ROW)
    expect(await db.select().from(federatedIdentities)).toHaveLength(ONE_ROW)
    expect(await db.select().from(passwordResetTokens)).toHaveLength(ONE_ROW)
  })

  it('is silent about an id that has no row', async () => {
    await expect(repository.deleteById(MISSING_USER_ID)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Subir o banco e ver falhar**

Run: `pnpm db:up && npx vitest run --project integration tests/integration/drizzle-users-repository.spec.ts`
Expected: FAIL — `repository.deleteById is not a function`.

- [ ] **Step 3: Declarar no contrato**

Em `src/modules/auth/repositories/users-repository.ts`, ao fim da interface:

```ts
  /**
   * Deletes the row. The `onDelete: 'cascade'` foreign keys take
   * `refresh_tokens`, `federated_identities` and `password_reset_tokens` with
   * it — which is also what ends every session of a deleted account, without a
   * revocation step of its own.
   *
   * It does NOT reach `pending_registrations`: that table is keyed by email and
   * carries no foreign key, so the caller sweeps it explicitly.
   *
   * Silent about a missing id, like `updatePasswordHash`: the caller has
   * already loaded the user, and turning a missing row into an error here would
   * duplicate a decision that belongs to the use case.
   */
  deleteById(id: string): Promise<void>
```

- [ ] **Step 4: Implementar nos três adaptadores**

`src/modules/auth/infra/drizzle/drizzle-users-repository.ts`, ao fim da classe:

```ts
  async deleteById(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id))
  }
```

`src/modules/auth/infra/in-memory/in-memory-users-repository.ts`, ao fim da classe:

```ts
  async deleteById(id: string): Promise<void> {
    const index = this.users.findIndex((existing) => existing.id === id)
    if (index < 0) return

    this.users.splice(index, INDEX_STEP)
  }
```

Com a constante no topo do arquivo:

```ts
/** `splice` takes a count, and exactly one row carries a given id. */
const INDEX_STEP = 1
```

`src/modules/auth/repositories/noop-auth-repos.ts`, no objeto `users`:

```ts
      deleteById: async () => {},
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run --project integration tests/integration/drizzle-users-repository.spec.ts`
Expected: PASS, os quatro testes novos inclusive.

Run: `npx tsc --noEmit`
Expected: **três erros**, um por spec com dublê inline de `IUsersRepository` —
`change-password.spec.ts`, `confirm-email.spec.ts` e `reset-password.spec.ts`,
todas com um objeto `users: { save, findByEmail, findById, updatePasswordHash }`
dentro do `trackedRepos`. Acrescente a cada um dos três, junto de
`updatePasswordHash`:

```ts
      deleteById: (id) => usersRepository.deleteById(id),
```

Run: `npx tsc --noEmit && npx vitest run --project unit`
Expected: sem erro de tipo e suíte unit verde.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/repositories/users-repository.ts \
  src/modules/auth/infra/drizzle/drizzle-users-repository.ts \
  src/modules/auth/infra/in-memory/in-memory-users-repository.ts \
  src/modules/auth/repositories/noop-auth-repos.ts \
  tests/integration/drizzle-users-repository.spec.ts
git commit -m "feat(auth): add deleteById to the users repository"
```

---

### Task 3: `DeleteAccountUseCase`

**Files:**
- Create: `src/modules/auth/use-cases/delete-account.ts`
- Test: `src/modules/auth/use-cases/delete-account.spec.ts`

**Interfaces:**
- Consumes: `deleteById` (Task 2), `accountDeletedEmail` (Task 1), `pendingRegistrations.deleteAllByEmail(email: Email): Promise<void>` e `outboxMessages.save(message: OutboxMessage): Promise<void>`, ambos já existentes.
- Produces: `DeleteAccountUseCase`, com `execute(command: { userId: string; password?: string | undefined }): Promise<void>` — consumida pela Task 4 como `container.deleteAccount`.

- [ ] **Step 1: Escrever o spec que falha**

Create `src/modules/auth/use-cases/delete-account.spec.ts`:

```ts
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { User } from '#modules/auth/entities/user'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { InMemoryOutboxMessagesRepository } from '#modules/auth/infra/in-memory/in-memory-outbox-messages-repository'
import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
import { accountDeletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import { noopAuthRepos } from '#modules/auth/repositories/noop-auth-repos'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { DeleteAccountUseCase } from '#modules/auth/use-cases/delete-account'
import { Email } from '#modules/auth/value-objects/email'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const MISSING_USER_ID = '00000000-0000-4000-8000-000000000000'
const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'n0t-the-one!'
const HASH_PREFIX = 'hashed:'
const STORED_HASH = `${HASH_PREFIX}${PASSWORD}`
const DUMMY_HASH = `${HASH_PREFIX}dummy`
const GENERATED_ID = 'generated-id'
const NOW = new Date('2026-09-18T12:00:00.000Z')
const CREATED_AT = new Date('2026-01-01T08:00:00.000Z')

const COMPARE_CALL = 'compare'
const UOW_CALL = 'uow'
const DELETE_USER_CALL = 'deleteById'
const SWEEP_PENDINGS_CALL = 'deleteAllByEmail'
const SAVE_OUTBOX_CALL = 'saveOutboxMessage'
/** Pushed by the `uow` fake only when its callback RESOLVES — never on a rollback. */
const COMMIT_CALL = 'commit'

const NO_MESSAGES = 0
const NO_USERS = 0
const ONE_MESSAGE = 1
const ONE_USER = 1

let callLog: string[]
let usersRepository: InMemoryUsersRepository
let outboxMessages: InMemoryOutboxMessagesRepository
let compareResult: boolean
let deleteAllByEmailSpy: Mock<(email: Email) => Promise<void>>
let uowSpy: Mock<(work: (repos: AuthRepos) => Promise<unknown>) => Promise<unknown>>
let useCase: DeleteAccountUseCase

const hashProvider: IHashProvider = {
  hash: async () => STORED_HASH,
  compare: async () => {
    callLog.push(COMPARE_CALL)
    return compareResult
  },
  dummyHash: DUMMY_HASH,
}

const storeUser = (passwordHash: string | null) =>
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(EMAIL),
      passwordHash,
      emailVerifiedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }),
  )

beforeEach(() => {
  callLog = []
  compareResult = true
  usersRepository = new InMemoryUsersRepository()
  outboxMessages = new InMemoryOutboxMessagesRepository()
  deleteAllByEmailSpy = vi.fn(async () => {
    callLog.push(SWEEP_PENDINGS_CALL)
  })

  uowSpy = vi.fn(async (work) => {
    callLog.push(UOW_CALL)
    const repos: AuthRepos = {
      ...noopAuthRepos(),
      users: {
        ...noopAuthRepos().users,
        deleteById: (id) => {
          callLog.push(DELETE_USER_CALL)
          return usersRepository.deleteById(id)
        },
      },
      pendingRegistrations: {
        ...noopAuthRepos().pendingRegistrations,
        deleteAllByEmail: deleteAllByEmailSpy,
      },
      outboxMessages: {
        ...noopAuthRepos().outboxMessages,
        save: (message) => {
          callLog.push(SAVE_OUTBOX_CALL)
          return outboxMessages.save(message)
        },
      },
    }
    const result = await work(repos)
    callLog.push(COMMIT_CALL)
    return result
  })

  useCase = new DeleteAccountUseCase(
    usersRepository,
    // Cast: `IAuthUnitOfWork` is generic in the callback's return type and
    // `vi.fn` cannot produce a generic function. The spy's own signature is
    // checked at its declaration; only the generic instantiation is waived.
    uowSpy as unknown as IAuthUnitOfWork,
    hashProvider,
    { now: () => NOW },
    { generate: () => GENERATED_ID },
  )
})

describe('DeleteAccountUseCase — account with a password', () => {
  it('deletes the user, sweeps the pendings and queues the notice in one uow', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD })

    // toEqual on the whole log: argon2 must run before the transaction opens,
    // and all three writes must land inside it.
    expect(callLog).toEqual([
      COMPARE_CALL,
      UOW_CALL,
      DELETE_USER_CALL,
      SWEEP_PENDINGS_CALL,
      SAVE_OUTBOX_CALL,
      COMMIT_CALL,
    ])
    expect(usersRepository.users).toHaveLength(NO_USERS)
  })

  it('sweeps the pendings of the STORED address', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD })

    expect(deleteAllByEmailSpy).toHaveBeenCalledWith(Email.fromTrusted(EMAIL))
  })

  it('queues the deletion notice addressed to the owner', async () => {
    storeUser(STORED_HASH)

    await useCase.execute({ userId: USER_ID, password: PASSWORD })

    expect(outboxMessages.messages).toHaveLength(ONE_MESSAGE)
    expect(outboxMessages.messages[0]?.toEmailMessage()).toEqual(
      accountDeletedEmail(Email.fromTrusted(EMAIL)),
    )
  })

  it('refuses a wrong password without opening a transaction', async () => {
    storeUser(STORED_HASH)
    compareResult = false

    await expect(
      useCase.execute({ userId: USER_ID, password: WRONG_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCurrentPasswordError)
    expect(uowSpy).not.toHaveBeenCalled()
    expect(usersRepository.users).toHaveLength(ONE_USER)
  })

  it('refuses when no password is sent at all', async () => {
    storeUser(STORED_HASH)

    await expect(useCase.execute({ userId: USER_ID })).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
  })
})

describe('DeleteAccountUseCase — federated-only account', () => {
  it('deletes with no password at all, and never runs argon2', async () => {
    storeUser(null)

    await useCase.execute({ userId: USER_ID })

    expect(callLog).not.toContain(COMPARE_CALL)
    expect(usersRepository.users).toHaveLength(NO_USERS)
  })
})

describe('DeleteAccountUseCase — unknown subject', () => {
  it('throws when the token subject has no row, writing nothing', async () => {
    await expect(useCase.execute({ userId: MISSING_USER_ID })).rejects.toBeInstanceOf(
      UserNotFoundError,
    )
    expect(uowSpy).not.toHaveBeenCalled()
    expect(outboxMessages.messages).toHaveLength(NO_MESSAGES)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run --project unit src/modules/auth/use-cases/delete-account.spec.ts`
Expected: FAIL — `Cannot find module '#modules/auth/use-cases/delete-account'`.

- [ ] **Step 3: Implementar o use case**

Create `src/modules/auth/use-cases/delete-account.ts`:

```ts
import { OutboxMessage } from '#modules/auth/entities/outbox-message'
import { InvalidCurrentPasswordError } from '#modules/auth/errors/invalid-current-password-error'
import { UserNotFoundError } from '#modules/auth/errors/user-not-found-error'
import { accountDeletedEmail } from '#modules/auth/notifications/emails'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { IClock } from '#shared/ports/clock'
import type { IIdGenerator } from '#shared/ports/id-generator'

/** Raw, untrusted input. `userId` comes from the verified token, never the body. */
export interface DeleteAccountCommand {
  userId: string
  /**
   * Absent for a federated-only account, which has none to reapresent.
   * `| undefined` spelled out for `exactOptionalPropertyTypes`, like
   * `SignInWithGoogleCommand`.
   */
  password?: string | undefined
}

/**
 * Deletes the caller's own account, for good.
 *
 * The row in `users` goes, and the `onDelete: 'cascade'` foreign keys take
 * `refresh_tokens`, `federated_identities` and `password_reset_tokens` with it
 * — which is what ends every session without a revocation step of its own.
 *
 * Two things the cascade cannot reach happen explicitly, inside the same
 * transaction. `pending_registrations` is keyed by email and has no foreign
 * key, and a surviving live code there would confirm a BRAND NEW account for
 * the address. The notice has no foreign key either, and that is what lets it
 * outlive the account it describes.
 *
 * The id always comes from the verified access token — the endpoint reads it
 * with `getPrincipal`. Taking it from the body would let any authenticated
 * caller delete anyone.
 */
export class DeleteAccountUseCase {
  constructor(
    /** `Pick`, and the narrowing IS the rule (§9): the delete goes through the uow. */
    private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async execute(command: DeleteAccountCommand): Promise<void> {
    const user = await this.usersRepository.findById(command.userId)

    // Reachable: the account was deleted while an unexpired access token was
    // still in the wild — including by a second call to this very use case.
    if (user === null) throw new UserNotFoundError()

    // Outside any transaction (§8). No decoy on the federated branch, unlike
    // `change-password.ts`: the caller already proved, with the token, that the
    // account is theirs, so no timing here answers a question they cannot
    // already answer.
    if (user.passwordHash !== null) {
      const confirmed =
        command.password !== undefined &&
        (await this.hashProvider.compare(command.password, user.passwordHash))

      if (!confirmed) throw new InvalidCurrentPasswordError()
    }

    // Read ONCE, and the address captured BEFORE the delete: after it, the
    // entity is the only place either still exists.
    const now = this.clock.now()
    const email = user.email

    await this.uow(async ({ users, pendingRegistrations, outboxMessages }) => {
      await users.deleteById(user.id)

      await pendingRegistrations.deleteAllByEmail(email)

      await outboxMessages.save(
        OutboxMessage.create({
          id: this.idGenerator.generate(),
          message: accountDeletedEmail(email),
          now,
        }),
      )
    })
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run --project unit src/modules/auth/use-cases/delete-account.spec.ts`
Expected: PASS, os oito testes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/delete-account.ts src/modules/auth/use-cases/delete-account.spec.ts
git commit -m "feat(auth): add the delete account use case"
```

---

### Task 4: `DELETE /auth/me`

**Files:**
- Create: `src/modules/auth/infra/http/endpoints/delete-account.ts`
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Test: `tests/integration/delete-account.spec.ts`

**Interfaces:**
- Consumes: `DeleteAccountUseCase` (Task 3), exposto como `container.deleteAccount`; `container.accountDeleteRateLimit`; `getPrincipal`, `clearRefreshCookie`.
- Produces: a rota `DELETE /auth/me`. Nenhuma tarefa posterior depende dela em código.

- [ ] **Step 1: Escrever o teste de integração que falha**

Create `tests/integration/delete-account.spec.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'
import { pendingRegistrations } from '#modules/auth/infra/drizzle/schema/pending-registrations'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import { arrangeAccount } from './setup/arrange-account.js'

const LOGIN_PATH = '/auth/login'
const ME_PATH = '/auth/me'
const REFRESH_PATH = '/auth/refresh'
const REGISTER_PATH = '/auth/register'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'
const DELETE_METHOD = 'DELETE'

const NO_CONTENT_STATUS_CODE = 204
const UNAUTHORIZED_STATUS_CODE = 401
const NOT_FOUND_STATUS_CODE = 404
const UNPROCESSABLE_ENTITY_STATUS_CODE = 422

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const WRONG_PASSWORD = 'n0t-the-one!'
const INVALID_CURRENT_PASSWORD_CODE = 'INVALID_CURRENT_PASSWORD'
/** The exact subject of `accountDeletedEmail`; spelled out, not imported. */
const ACCOUNT_DELETED_SUBJECT = 'Your account was deleted'

const NO_ROWS = 0
const ONE_ROW = 1

let app: FastifyInstance
let db: Database
let pool: Pool
let accessToken: string
let refreshToken: string

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
  await db.delete(pendingRegistrations)
  await db.delete(outboxMessages)
  await db.delete(users)
  await arrangeAccount(db, { email: EMAIL, password: PASSWORD })

  const loggedIn = await app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
  ;({ accessToken, refreshToken } = loggedIn.json())
})

const deleteAccount = (payload: object, authorization?: string) =>
  app.inject({
    method: DELETE_METHOD,
    url: ME_PATH,
    payload,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })

describe('DELETE /auth/me', () => {
  it('answers 204 and removes the row', async () => {
    const response = await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect(await db.select().from(users)).toHaveLength(NO_ROWS)
  })

  it('leaves the still-valid access token with nothing to reach', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const profile = await app.inject({
      method: GET_METHOD,
      url: ME_PATH,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(profile.statusCode).toBe(NOT_FOUND_STATUS_CODE)
  })

  it('kills the session — the cascade took the refresh token row', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const refreshed = await app.inject({
      method: POST_METHOD,
      url: REFRESH_PATH,
      payload: { refreshToken },
    })

    expect(refreshed.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(await db.select().from(refreshTokens)).toHaveLength(NO_ROWS)
  })

  it('sweeps a live pending registration for the same address', async () => {
    // Registering again while the account exists writes no pending, so the row
    // is inserted the way a leftover sibling would have survived: directly.
    await db.insert(pendingRegistrations).values({
      id: '77778888-9999-4aaa-8bbb-ccccddddeeee',
      email: EMAIL,
      codeHash: 'digest:123456',
      attempts: NO_ROWS,
      codeIssuedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
      createdAt: new Date(),
    })

    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    expect(await db.select().from(pendingRegistrations)).toHaveLength(NO_ROWS)
  })

  it('queues the deletion notice, which outlives the account', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, ACCOUNT_DELETED_SUBJECT))

    expect(rows).toHaveLength(ONE_ROW)
    expect(rows[0]?.to).toBe(EMAIL)
    expect(rows[0]?.dispatchedAt).toBeNull()
  })

  it('answers 422 for a wrong password, keeping the account', async () => {
    const response = await deleteAccount(
      { password: WRONG_PASSWORD },
      `Bearer ${accessToken}`,
    )

    expect(response.statusCode).toBe(UNPROCESSABLE_ENTITY_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_CURRENT_PASSWORD_CODE)
    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
  })

  it('answers 401 without an Authorization header', async () => {
    const response = await deleteAccount({ password: PASSWORD })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(await db.select().from(users)).toHaveLength(ONE_ROW)
  })

  it('lets the address be registered again from scratch', async () => {
    await deleteAccount({ password: PASSWORD }, `Bearer ${accessToken}`)

    const registered = await app.inject({
      method: POST_METHOD,
      url: REGISTER_PATH,
      payload: { email: EMAIL },
    })

    expect(registered.statusCode).toBe(202)
    expect(await db.select().from(pendingRegistrations)).toHaveLength(ONE_ROW)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm db:up && npx vitest run --project integration tests/integration/delete-account.spec.ts`
Expected: FAIL — a rota não existe, então o 204 esperado vem como 404.

- [ ] **Step 3: Config — o par de rate limit**

Em `src/modules/auth/config.ts`, junto das outras constantes:

```ts
/**
 * A request here carries a password guess, like login and the password change.
 * Its own pair, not a shared one, for the reason those two document: a field
 * named for one route and used by another is a comment that lies.
 */
export const DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS = 60
```

E no `authEnvSchema`:

```ts
  // `.positive()` for the reason every ceiling here carries it: zero would
  // refuse every deletion, and rejecting zero is what rejects an empty value.
  ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS),
  ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS),
```

- [ ] **Step 4: Container — o use case e o teto**

Em `src/modules/auth/container.ts`, o import junto dos outros use cases:

```ts
import { DeleteAccountUseCase } from './use-cases/delete-account.js'
```

No objeto devolvido, junto de `changePassword`:

```ts
    deleteAccount: new DeleteAccountUseCase(
      usersRepository,
      uow,
      hashProvider,
      clock,
      idGenerator,
    ),
```

E junto dos outros tetos:

```ts
    /**
     * The deletion route declares its own ceiling, like the password change:
     * a request here carries a password guess.
     */
    accountDeleteRateLimit: {
      max: config.ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS,
      timeWindow:
        config.ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
```

- [ ] **Step 5: O endpoint**

Create `src/modules/auth/infra/http/endpoints/delete-account.ts`:

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
  NO_CONTENT_STATUS,
  NOT_FOUND_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  TOO_MANY_REQUESTS_STATUS,
  UNAUTHORIZED_STATUS,
  UNPROCESSABLE_ENTITY_STATUS,
} from '#modules/auth/infra/http/constants'
import { clearRefreshCookie } from '#modules/auth/infra/http/refresh-cookie'
import { MAX_PASSWORD_LENGTH } from '#modules/auth/value-objects/password'

const DELETE_ACCOUNT_PATH = '/me'
const DELETE_ACCOUNT_SUMMARY = 'Delete this account for good'
const DELETE_ACCOUNT_DESCRIPTION =
  'Deletes the authenticated account and everything tied to it: every ' +
  'session, every linked provider, every password reset token, and any ' +
  'pending registration for the address. Irreversible — there is no grace ' +
  'period and nothing is exported first. An account with a password must ' +
  'present it; an account that only signs in with Google does not, having ' +
  'none. Access tokens already issued stay valid until they expire, with ' +
  'nothing left to reach — decision 11.'

const MIN_SUBMITTED_PASSWORD_LENGTH = 1

/**
 * `password` checks PRESENCE, not policy — the same call login and the
 * password change make: an account created under a looser policy must stay
 * able to delete itself. It is optional because a federated-only account has
 * none to send; whether it is actually required is the use case's call, since
 * only it knows whether the account carries a hash. The ceiling stays for the
 * unrelated reason: without one, a 10 MB body becomes argon2 over 10 MB.
 */
const bodySchema = z.object({
  password: z
    .string()
    .min(MIN_SUBMITTED_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .meta({ examples: [EXAMPLE_PASSWORD] })
    .optional(),
})

export const deleteAccountRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().delete(
    DELETE_ACCOUNT_PATH,
    {
      preHandler: guard,
      config: { rateLimit: container.accountDeleteRateLimit },
      schema: {
        tags: [AUTH_TAG],
        summary: DELETE_ACCOUNT_SUMMARY,
        description: DELETE_ACCOUNT_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        body: bodySchema,
        response: {
          [NO_CONTENT_STATUS]: z.null(),
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
      await container.deleteAccount.execute({
        // Never from the body: that would let any authenticated caller delete
        // anyone.
        userId: getPrincipal(request).id,
        password: request.body.password,
      })

      // Sent unconditionally, like `logout-all`: if a cookie came with the
      // request, the row behind it just died, and leaving it in the browser
      // only produces a confusing 401 on the next refresh.
      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}
```

- [ ] **Step 6: Registrar a rota**

Em `src/modules/auth/infra/http/routes.ts`, o import em ordem alfabética junto dos outros, e o registro ao fim da função:

```ts
import { deleteAccountRoute } from './endpoints/delete-account.js'
```

```ts
  await app.register(deleteAccountRoute, { container, guard })
```

- [ ] **Step 7: Rodar e ver passar**

Run: `npx vitest run --project integration tests/integration/delete-account.spec.ts`
Expected: PASS, os oito testes.

Run: `npx tsc --noEmit && npx biome check . && npx vitest run --project unit && npx vitest run --project integration`
Expected: tudo verde.

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/infra/http/endpoints/delete-account.ts \
  src/modules/auth/config.ts \
  src/modules/auth/container.ts \
  src/modules/auth/infra/http/routes.ts \
  tests/integration/delete-account.spec.ts
git commit -m "feat(auth): add DELETE /auth/me"
```

---

### Task 5: Emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TODO.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: tudo que as Tasks 1–4 entregaram.
- Produces: nada em código.

- [ ] **Step 1: `.env.example`**

Acrescente, junto das outras variáveis de rate limit:

```
ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS=10
ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS=60
```

Confira antes se o arquivo lista as outras (`PASSWORD_CHANGE_RATE_LIMIT_*`); se não listar, não acrescente estas — siga o padrão que estiver lá.

- [ ] **Step 2: Decisão 37 no `DECISIONS.md`**

Depois da decisão 36, antes de `## 7. Pendências de manutenção`:

```markdown
### 37 — Deleção de conta: hard delete, apoiado na cascata que o schema já declara

`DELETE /auth/me` apaga a linha de `users` de verdade. As FKs com
`onDelete: 'cascade'` — escritas antes desta fatia — levam junto
`refresh_tokens`, `federated_identities` e `password_reset_tokens`, e é isso
que **fecha também o item "Revogação por usuário deletado/banido"** sem código
próprio: um refresh de conta apagada não acha linha e já responde 401.

**Hard delete, não soft delete.** O schema já assumia isso: cascata só dispara
quando a linha-pai some, e com soft delete as três tabelas ficariam com linhas
vivas — inclusive refresh tokens rotacionando — apontando para uma conta que o
app considera morta.

**Sem tabela de eventos de auditoria.** A trilha de auditoria já é pendência
adiada, com gatilho próprio, desde a auditoria de 2026-09-07. Criar uma tabela
agora só para a deleção resolveria esse problema maior pela metade e para um
evento só — o mesmo erro que a decisão 33 e a reclassificação do RBAC
evitaram. Quando o gatilho disparar, a deleção é um dos eventos a capturar.

**Duas escritas explícitas, porque a cascata não as alcança.**
`pending_registrations` é indexada por e-mail e não tem FK (um pendente nasce
antes de existir conta): um irmão não consumido sobreviveria e confirmaria uma
conta NOVA no mesmo endereço. Varrido com `deleteAllByEmail`, que já existia
desde a fatia 14. O aviso de deleção também não tem FK, e é isso que o deixa
sobreviver à conta que ele descreve — gravado no outbox na mesma transação.

**Confirmação em um passo, com a senha atual.** Molde de `change-password.ts`,
não o de recuperação de senha: um segundo passo não torna a ação reversível, só
a atrasa, e custaria tabela, TTL e cooldown novos repetindo infra existente.
Conta só-Google apaga com a sessão válida — não tem senha a reapresentar, e a
fatia que define a primeira senha numa conta federada segue fora do roteiro.

Desenho completo em
[`2026-09-18-account-deletion-design.md`](superpowers/specs/2026-09-18-account-deletion-design.md).

---
```

- [ ] **Step 3: `TODO.md`**

Três edições:

1. No bloco do topo, antes do parágrafo da fatia 19:

```markdown
> **Fatia 20 (2026-09-18) entregou a deleção de conta** (decisão 37).
> `DELETE /auth/me` com hard delete da linha de `users`; a cascata que o schema
> já declarava leva `refresh_tokens`, `federated_identities` e
> `password_reset_tokens`, e os pendentes do endereço são varridos
> explicitamente porque aquela tabela não tem FK. **Fecha junto "Revogação por
> usuário deletado/banido"**, sem código próprio. Sem soft delete e sem tabela
> de auditoria — ver decisão 37.
>
```

2. Na tabela "O resto", as duas linhas viram:

```markdown
| ~~Deleção de conta~~ | — | **fechada pela fatia 20.** `DELETE /auth/me`, hard delete apoiado na cascata; varre os `pending_registrations` do endereço. Decisão 37 |
| ~~Revogação por usuário deletado/banido~~ | — | **fechada pela fatia 20**, sem código próprio: a cascata apaga os `refresh_tokens` junto com a conta |
```

3. Na tabela da auditoria de 2026-09-07, a linha "Trilha de auditoria" ganha, ao fim da nota: `— e a deleção de conta (fatia 20) é um dos eventos que ela deve capturar quando for retomada`.

4. Na seção "O que eu faria a seguir", troque o parágrafo do próximo item por:

```markdown
~~Deleção de conta~~ — **entregue pela fatia 20** (decisão 37), e com ela
~~revogação por usuário deletado~~, que a cascata resolve sem código.

A tabela genérica fica sem item desbloqueado. O que resta são os achados da
auditoria de 2026-09-07, que sobem de prioridade pelo gatilho de dado
sensível, e o miúdo da fatia 14 (listar provedores vinculados no `/me`).
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit && npx biome check . && npx vitest run --project unit && npx vitest run --project integration`
Expected: tudo verde — as edições são de doc, mas o `.env.example` e o `config.ts` andam juntos.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/TODO.md .env.example
git commit -m "docs(auth): record decision 37 and close out the TODO entries"
```
