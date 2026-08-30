# Fatia 4 — Unit of Work: plano de implementação

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`) para acompanhamento.

**Goal:** entregar a primitiva de atomicidade da decisão 22 — um Unit of Work
genérico, com guarda contra aninhamento, provado contra Postgres real — antes da
fatia que vai consumi-la.

**Architecture:** duas camadas. Um `TransactionRunner` sem contexto abre a
transação, faz commit/rollback e recusa aninhamento; uma casca genérica de três
linhas o combina com uma fábrica de repositórios e produz o `IUnitOfWork<TRepos>`
que a camada pura enxerga. O módulo `auth` contribui apenas com o tipo do seu
pacote de repositórios e a fábrica que os constrói.

**Tech Stack:** TypeScript 7 · Drizzle 1.0.0-rc.4 (`node-postgres`) ·
`node:async_hooks` · Vitest 4 · Biome 2.5.9. **Nenhuma dependência nova.**

**Spec:** [`docs/superpowers/specs/2026-08-29-unit-of-work-design.md`](../specs/2026-08-29-unit-of-work-design.md)

---

## Pré-requisito de ambiente

`package.json` exige `node >=24.19.0 <25`, e o `pnpm` **recusa rodar scripts**
fora disso. O `.nvmrc` diz `24.19.0`.

Antes de começar: `nvm use` (ou equivalente) e confirme com `node -v`. Sem isso
`pnpm test` e `pnpm lint` falham antes de executar qualquer coisa, e a falha não
tem relação nenhuma com o código.

Postgres precisa estar de pé **apenas para a Task 4**: `docker compose up -d`
(dev em 5432, test em 5433). As tasks 1 a 3 rodam sem banco.

## Global Constraints

Valem para **todas** as tarefas. Copiadas do `CLAUDE.md`, do `biome.jsonc` e da
spec.

- **Idioma:** todo código, identificador, string, mensagem de erro e
  **comentário** em **inglês**. Só arquivo `.md` pode ser português.
- **Zero magic string/number.** Constante nomeada em `UPPER_SNAKE_CASE`,
  declarada perto do uso. Inclui o `name` de classe de erro — siga
  `PERSISTENCE_ERROR_NAME` em `driver-error.ts`.
- **Formatação (Biome):** indentação de 2 espaços, largura **90**, aspas
  **simples**, **sem** ponto e vírgula, trailing comma em tudo. Rode
  `pnpm lint:fix` antes de cada commit.
- **Imports:** subpath imports do Node — `#shared/*`, `#infra/*`, `#modules/*` —
  para outra pasta; relativo com sufixo `.js` (`./client.js`) para irmão na mesma
  pasta. **Ordem alfabética pelo especificador**, senão o `organizeImports` do
  Biome falha o lint (aconteceu na verificação de planejamento).
- **`type` e não `interface` para contrato só-chamável.** Biome tem
  `useShorthandFunctionType`; um `interface` com única call signature emite info.
- **Camada pura não importa infra.** `shared/ports/` e
  `modules/auth/repositories/` não podem importar `drizzle-orm`, `pg` nem
  `#infra/database/client`.
- **Comandos:** `pnpm typecheck` · `pnpm lint` · `pnpm test:unit` ·
  `pnpm test:integration` · `pnpm test`.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/shared/ports/unit-of-work.ts` | **Criar.** O único contrato que a camada pura enxerga. |
| `src/infra/database/transaction-runner.ts` | **Criar.** Abre a transação, commit/rollback, guarda de aninhamento. A única cópia dessa mecânica no projeto. |
| `src/infra/database/transaction-runner.spec.ts` | **Criar.** Cinco testes, sem Postgres. |
| `src/infra/database/unit-of-work.ts` | **Criar.** A casca genérica que casa runner + fábrica. |
| `src/modules/auth/repositories/unit-of-work.ts` | **Criar.** `AuthRepos` e `IAuthUnitOfWork`. Puro. |
| `src/modules/auth/infra/drizzle/auth-repositories.ts` | **Criar.** O único arquivo que conhece o conjunto de repositórios do módulo. |
| `src/modules/auth/container.ts` | **Modificar.** Usa a fábrica; recebe o runner; publica `uow`. |
| `src/main/container.ts` | **Modificar.** Cria o runner do processo. |
| `tests/integration/unit-of-work.spec.ts` | **Criar.** Commit, rollback, isolamento e erro de domínio, contra Postgres real. |

## Achados da fase de planejamento

Estes pontos foram **executados** durante o planejamento, não presumidos. Contam
como resolvidos; se algum falhar na sua mão, é regressão, não incerteza.

1. **`db.transaction()` sobre o tipo-união `Database` compila.** `Database` é
   `NodePgDatabase | NodePgTransaction<EmptyRelations>`, e chamar `.transaction`
   sobre a união passa no `tsc` sem cast nem narrowing.
2. **`interface` com única call signature emite info do Biome.** Por isso
   `IUnitOfWork` e `TransactionRunner` são `type`, contrariando o snippet do §7
   da spec, que os escreveu como `interface`. Com `type`, `pnpm lint` fecha com
   zero achados.
3. **A cadeia inteira compila e a suíte unitária continua verde** com o container
   refatorado: `pnpm typecheck` limpo, `pnpm lint` limpo, **150 testes passando**.
4. **Ordem de import é erro, não aviso.** `#infra/database/transaction-runner`
   vem **antes** de `#infra/database/unit-of-work`.

---

## Task 1: `TransactionRunner` e a guarda de aninhamento

**Files:**
- Create: `src/infra/database/transaction-runner.ts`
- Test: `src/infra/database/transaction-runner.spec.ts`

**Interfaces:**
- Consumes: `Database` de `src/infra/database/client.ts` (já existe).
- Produces:
  - `type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>`
  - `class NestedTransactionError extends Error`
  - `function createTransactionRunner(db: Database): TransactionRunner`

**Contexto que o executor precisa.** A guarda existe porque o UoW é singleton e
segura o **pool**, nunca o handle da transação. Uma segunda chamada tira **outra
conexão do pool** e abre uma transação independente — não um savepoint. Ela
commita sozinha enquanto a de fora faz rollback, e trava de vez quando a de fora
segura um lock de linha que a de dentro pede: o Postgres não quebra esse impasse,
porque a transação externa não espera lock, espera JavaScript. Detalhe completo
no §4 da spec.

- [ ] **Step 1: Escrever o spec que falha**

Crie `src/infra/database/transaction-runner.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Database } from '#infra/database/client'
import {
  createTransactionRunner,
  NestedTransactionError,
} from '#infra/database/transaction-runner'

const WORK_RESULT = 'work-result'
const COLLABORATOR_RESULT = 'collaborator-result'
const BOOM_MESSAGE = 'boom — abort the transaction'

/**
 * The runner only ever calls `.transaction`, so the double implements that and
 * nothing else. `Database` is Drizzle's complete handle type, hence the cast —
 * confined to these two lines, in a file that never reaches `dist/`.
 */
const TRANSACTION_HANDLE = { handle: 'tx' } as unknown as Database

const db = {
  transaction: <T>(work: (tx: Database) => Promise<T>): Promise<T> =>
    work(TRANSACTION_HANDLE),
} as unknown as Database

describe('createTransactionRunner', () => {
  it('hands the transaction handle to the work and returns its result', async () => {
    const runner = createTransactionRunner(db)
    let received: Database | undefined

    const result = await runner(async (tx) => {
      received = tx
      return WORK_RESULT
    })

    expect(result).toBe(WORK_RESULT)
    expect(received).toBe(TRANSACTION_HANDLE)
  })

  it('propagates the error the work throws, unwrapped', async () => {
    const runner = createTransactionRunner(db)
    const boom = new Error(BOOM_MESSAGE)

    // `toBe`, not `toThrow`: identity is the contract. A wrapped error would
    // still satisfy a message match while breaking the taxonomy of decision 13,
    // which is what lets `EmailAlreadyInUseError` still answer 409 from inside
    // a transaction.
    await expect(
      runner(async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })

  it('throws when a runner is called inside another runner', async () => {
    const runner = createTransactionRunner(db)

    await expect(
      runner(async () => runner(async () => WORK_RESULT)),
    ).rejects.toBeInstanceOf(NestedTransactionError)
  })

  it('throws when the nesting comes from a collaborator, across an await', async () => {
    const runner = createTransactionRunner(db)

    const collaborator = async (): Promise<string> => {
      // Crossing a microtask boundary is the point: the flag has to survive it.
      // That is what proves detection is by async context, and not by anything
      // that could be read off the synchronous call stack.
      await Promise.resolve()

      return runner(async () => COLLABORATOR_RESULT)
    }

    await expect(runner(async () => collaborator())).rejects.toBeInstanceOf(
      NestedTransactionError,
    )
  })

  it('does not trip the guard on a second, sequential run', async () => {
    const runner = createTransactionRunner(db)

    await runner(async () => WORK_RESULT)

    // Without this one, a storage whose context is never exited passes all four
    // tests above and then rejects the second request of every process.
    await expect(runner(async () => WORK_RESULT)).resolves.toBe(WORK_RESULT)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- transaction-runner
```

Esperado: **falha na importação** — `Failed to resolve import
"#infra/database/transaction-runner"`. Ainda não existe arquivo.

- [ ] **Step 3: Implementar**

Crie `src/infra/database/transaction-runner.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from './client.js'

/**
 * The context-free half of the Unit of Work: it knows how to open a transaction
 * and nothing about repositories. Build ONE per process, in the composition
 * root, and share it with every module's Unit of Work.
 */
export type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>

const NESTED_TRANSACTION_ERROR_NAME = 'NestedTransactionError'
const NESTED_TRANSACTION_MESSAGE =
  'a transaction is already open on this async context: open it once at the ' +
  'use case boundary and reuse the transaction-bound repositories'

/**
 * Deliberately NOT an `AppError`, for the same reason `PersistenceError` is not:
 * nesting is a programming defect, not one of the six semantic categories of
 * decision 13. It falls through to the error handler's generic branch and
 * answers 500 — which is what it is.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(NESTED_TRANSACTION_MESSAGE)
    this.name = NESTED_TRANSACTION_ERROR_NAME
  }
}

/**
 * Tracks whether the current async context already holds an open transaction.
 * Read ONLY by the guard below: repositories never touch it, and it carries a
 * boolean rather than the transaction handle.
 *
 * That is what separates it from the ambient-transaction pattern decision 22
 * rejected — the transaction stays explicit in `work`'s parameter, and the only
 * thing this flag can do is throw. It is the project's second use of
 * `AsyncLocalStorage`, which decision 15 had accepted as a one-off; the
 * amendment records why detection is not propagation.
 */
const insideTransaction = new AsyncLocalStorage<true>()

export function createTransactionRunner(db: Database): TransactionRunner {
  return <T>(work: (tx: Database) => Promise<T>): Promise<T> => {
    // A second call would take ANOTHER pooled connection and open an
    // independent transaction — not a savepoint. It would commit on its own
    // while the outer one rolls back, and deadlock outright whenever the outer
    // holds a row lock the inner asks for. Postgres cannot break that one: the
    // outer transaction is not waiting on a lock, it is waiting on JavaScript.
    if (insideTransaction.getStore() !== undefined) throw new NestedTransactionError()

    return insideTransaction.run(true, () => db.transaction((tx) => work(tx)))
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
pnpm test:unit -- transaction-runner
```

Esperado: **5 passed**.

- [ ] **Step 5: Lint, typecheck e commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add src/infra/database/transaction-runner.ts src/infra/database/transaction-runner.spec.ts
git commit -m "feat: open transactions through a runner that refuses to nest"
```

---

## Task 2: O contrato puro e a casca genérica

**Files:**
- Create: `src/shared/ports/unit-of-work.ts`
- Create: `src/infra/database/unit-of-work.ts`

**Interfaces:**
- Consumes: `TransactionRunner` e `Database` (Task 1 e `client.ts`).
- Produces:
  - `type IUnitOfWork<TRepos> = <T>(work: (repos: TRepos) => Promise<T>) => Promise<T>`
  - `function createUnitOfWork<TRepos>(runner: TransactionRunner, buildRepos: (db: Database) => TRepos): IUnitOfWork<TRepos>`

**Por que esta task não tem teste próprio.** O §12 da spec fixou o inventário de
testes da fatia, e a casca não tem comportamento além de composição: o que ela
promete — atomicidade e isolamento — só é observável contra Postgres, e é a Task 4
que prova. Um teste unitário aqui afirmaria que `buildRepos` foi chamado com o
`tx`, o que o próprio compilador já garante pelos tipos. O portão desta task é
`pnpm typecheck` e `pnpm lint`.

- [ ] **Step 1: Criar o contrato puro**

Crie `src/shared/ports/unit-of-work.ts`. **Uma linha de código e nenhum import** —
se você precisou importar alguma coisa aqui, a fronteira da camada pura quebrou:

```ts
/**
 * Runs `work` inside a single transaction, handing it repositories bound to
 * that transaction. Commits when `work` resolves, rolls back when it throws —
 * and the throw propagates unchanged.
 *
 * `TRepos` is whatever the caller's factory produces: one module's repositories,
 * or several modules' merged onto the same transaction.
 *
 * Three things must stay OUTSIDE the callback, because the transaction is held
 * open for its whole duration: external I/O (email, HTTP — persist inside, send
 * after the commit), CPU-heavy work (argon2 — compute before and pass the
 * result in), and any write that has to survive a failure (a brute-force
 * counter is autocommit by design, and a rollback would erase the very record
 * that remembers the failure). Opening a second unit of work in there throws.
 *
 * And the rule that neither the compiler nor the linter can enforce: **a use
 * case that receives a unit of work must NOT also receive a repository
 * directly**. The injected singleton writes on an autocommit connection, so a
 * call to it inside the callback compiles, passes its unit test against a
 * passthrough double, and silently breaks atomicity in production. Everything
 * the callback writes has to come from its `repos` parameter.
 */
export type IUnitOfWork<TRepos> = <T>(work: (repos: TRepos) => Promise<T>) => Promise<T>
```

- [ ] **Step 2: Criar a casca genérica**

Crie `src/infra/database/unit-of-work.ts`:

```ts
import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { Database } from './client.js'
import type { TransactionRunner } from './transaction-runner.js'

/**
 * Pairs the context-free runner with a factory that binds repositories to the
 * transaction. Every module plugs in the same way, so the transaction mechanics
 * are never duplicated — and a use case that legitimately spans two modules
 * merges their factories onto the SAME transaction instead of stacking two
 * units of work, which would be two transactions:
 *
 * ```ts
 * createUnitOfWork(runner, (tx) => ({
 *   ...authRepositories(tx),
 *   ...billingRepositories(tx),
 * }))
 * ```
 */
export function createUnitOfWork<TRepos>(
  runner: TransactionRunner,
  buildRepos: (db: Database) => TRepos,
): IUnitOfWork<TRepos> {
  return <T>(work: (repos: TRepos) => Promise<T>): Promise<T> =>
    runner((tx) => work(buildRepos(tx)))
}
```

- [ ] **Step 3: Verificar**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Esperado: `tsc` silencioso, Biome sem achados, **155 passed** (150 de antes + 5 da
Task 1).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ports/unit-of-work.ts src/infra/database/unit-of-work.ts
git commit -m "feat: compose a transaction runner and a repository factory into a unit of work"
```

---

## Task 3: A fatia do módulo e a fiação do container

**Files:**
- Create: `src/modules/auth/repositories/unit-of-work.ts`
- Create: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Modify: `src/modules/auth/container.ts`
- Modify: `src/main/container.ts`

**Interfaces:**
- Consumes: `IUnitOfWork` (Task 2), `createUnitOfWork` (Task 2),
  `createTransactionRunner` e `TransactionRunner` (Task 1), `IUsersRepository` e
  `DrizzleUsersRepository` (já existem).
- Produces:
  - `interface AuthRepos { users: IUsersRepository }`
  - `type IAuthUnitOfWork = IUnitOfWork<AuthRepos>`
  - `function authRepositories(db: Database): AuthRepos`
  - `makeAuthContainer(db, config, runner)` — **terceiro parâmetro novo** — com
    `uow` no objeto devolvido.

**O portão desta task é a suíte inteira.** Ela mexe no composition root, que
`buildApp` monta e que toda suíte de integração exercita. Se `register`, `login`
ou `me` quebrarem, a refatoração da fábrica está errada.

- [ ] **Step 1: Criar o contrato do módulo**

Crie `src/modules/auth/repositories/unit-of-work.ts`:

```ts
import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * One entry today, on purpose: the refresh token slice adds `refreshTokens`
 * here and in `auth-repositories.ts`, and nothing else in the project changes.
 * That cost is what this slice exists to make small.
 */
export interface AuthRepos {
  users: IUsersRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
```

- [ ] **Step 2: Criar a fábrica de repositórios**

Crie `src/modules/auth/infra/drizzle/auth-repositories.ts`:

```ts
import type { Database } from '#infra/database/client'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { DrizzleUsersRepository } from './drizzle-users-repository.js'

/**
 * The only place that knows the module's full repository set.
 *
 * Serves both sides with one function: hand it the pool handle for the
 * autocommit singletons the container holds, or a transaction handle for
 * repositories bound to it. `Database` is the union of the two, which is why no
 * existing repository changes.
 */
export function authRepositories(db: Database): AuthRepos {
  return { users: new DrizzleUsersRepository(db) }
}
```

- [ ] **Step 3: Ligar o container do módulo**

Em `src/modules/auth/container.ts`, quatro edições.

Troque o import do repositório concreto pela fábrica, e acrescente os dois de
infra. **Ordem alfabética pelo especificador**, ou o lint falha:

```ts
import type { Database } from '#infra/database/client'
import type { TransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { SystemClock } from '#infra/providers/system-clock'
import { UuidIdGenerator } from '#infra/providers/uuid-id-generator'
import type { AuthConfig } from './config.js'
import { authRepositories } from './infra/drizzle/auth-repositories.js'
import { Argon2HashProvider } from './infra/providers/argon2-hash-provider.js'
import { JwtTokenSigner } from './infra/providers/jwt-token-signer.js'
import { GetUserProfileUseCase } from './use-cases/get-user-profile.js'
import { LoginUserUseCase } from './use-cases/login-user.js'
import { RegisterUserUseCase } from './use-cases/register-user.js'
```

A assinatura ganha o runner, e o repositório passa a vir da fábrica:

```ts
export function makeAuthContainer(
  db: Database,
  config: AuthConfig,
  runner: TransactionRunner,
) {
  const { users: usersRepository } = authRepositories(db)
```

E o objeto devolvido ganha o `uow`, depois de `verifyAccessToken`:

```ts
    /**
     * Published with no consumer yet: the rotation of the refresh token slice
     * is the first use case that writes twice and needs one transaction. Wired
     * here rather than only in the tests so that the first construction in
     * production does not happen in the same slice that first depends on it —
     * the worst place to find a wiring mistake.
     */
    uow: createUnitOfWork(runner, authRepositories),
```

- [ ] **Step 4: Criar o runner no composition root**

Em `src/main/container.ts`, acrescente o import (alfabeticamente após `client`) e
crie o runner:

```ts
import { createTransactionRunner } from '#infra/database/transaction-runner'
```

```ts
export function makeContainer(db: Database, env: Env) {
  // One per process, shared by every module's unit of work: it owns the nesting
  // guard, so a second runner would be a second guard and defeat it.
  const runner = createTransactionRunner(db)

  return { auth: makeAuthContainer(db, env, runner) }
}
```

- [ ] **Step 5: Verificar que nada regrediu**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
```

Esperado: **155 passed**, zero achado de lint, `tsc` silencioso.

Com o Postgres de pé, rode também a integração — ela exercita `buildApp` e é o
que prova que o container ainda monta:

```bash
pnpm test:integration
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/repositories/unit-of-work.ts \
        src/modules/auth/infra/drizzle/auth-repositories.ts \
        src/modules/auth/container.ts src/main/container.ts
git commit -m "feat: give the auth module a unit of work over its repositories"
```

---

## Task 4: A prova contra Postgres real

**Files:**
- Create: `tests/integration/unit-of-work.spec.ts`

**Interfaces:**
- Consumes: `createTransactionRunner`, `createUnitOfWork`, `authRepositories`,
  `AuthRepos`, `IUnitOfWork`, e o que já existe — `createDatabase`, `User`,
  `Email`, `EmailAlreadyInUseError`, `users`.
- Produces: nada. É a prova da fatia.

**Requer Postgres de pé** (`docker compose up -d`).

Esta task inverte a ordem normal do TDD, e de propósito: o comportamento que ela
mede — atomicidade e isolamento — não existe sem a cadeia inteira montada. Para
não perder a garantia que a fase vermelha dá, o Step 3 **falsifica** os testes de
propósito antes de aceitá-los.

- [ ] **Step 1: Escrever o spec**

Crie `tests/integration/unit-of-work.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { User } from '#modules/auth/entities/user'
import { EmailAlreadyInUseError } from '#modules/auth/errors/email-already-in-use-error'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import type { AuthRepos } from '#modules/auth/repositories/unit-of-work'
import { Email } from '#modules/auth/value-objects/email'
import type { IUnitOfWork } from '#shared/ports/unit-of-work'

const ID = '0f1c8a2e-7b4d-4c9f-9a3e-2d5b6c7e8f90'
const OTHER_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d'
const THIRD_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'

const EMAIL = 'joao@example.com'
const OTHER_EMAIL = 'maria@example.com'

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const NOW = new Date('2026-08-29T12:00:00.000Z')

const BOOM_MESSAGE = 'boom — abort the unit of work'

let db: Database
let pool: Pool
let unitOfWork: IUnitOfWork<AuthRepos>
/** Repositories over the pool handle: every call here commits on its own. */
let autocommit: AuthRepos

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  unitOfWork = createUnitOfWork(createTransactionRunner(db), authRepositories)
  autocommit = authRepositories(db)
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

describe('unit of work (integration — real Postgres)', () => {
  it('commits every write when the work resolves', async () => {
    await unitOfWork(async (repos) => {
      await repos.users.save(makeUser(ID, EMAIL))
      await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))
    })

    expect(await autocommit.users.findById(ID)).not.toBeNull()
    expect(await autocommit.users.findById(OTHER_ID)).not.toBeNull()
  })

  it('rolls back EVERY write when the work throws', async () => {
    const boom = new Error(BOOM_MESSAGE)

    await expect(
      unitOfWork(async (repos) => {
        await repos.users.save(makeUser(ID, EMAIL))
        await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))

        throw boom
      }),
    ).rejects.toBe(boom)

    expect(await autocommit.users.findById(ID)).toBeNull()
    expect(await autocommit.users.findById(OTHER_ID)).toBeNull()
  })

  it('hides uncommitted writes from a read outside the transaction', async () => {
    await unitOfWork(async (repos) => {
      await repos.users.save(makeUser(ID, EMAIL))

      // Reads through the pool handle, which takes a DIFFERENT connection: the
      // row is written but not committed, so it cannot be visible yet. This is
      // the isolation the refresh rotation leans on when it holds a row with
      // SELECT ... FOR UPDATE.
      expect(await autocommit.users.findById(ID)).toBeNull()
    })

    expect(await autocommit.users.findById(ID)).not.toBeNull()
  })

  it('lets a domain error cross the rollback unwrapped', async () => {
    await autocommit.users.save(makeUser(ID, EMAIL))

    await expect(
      unitOfWork(async (repos) => {
        await repos.users.save(makeUser(OTHER_ID, OTHER_EMAIL))
        // Same email as the committed row above: the unique index raises 23505
        // and the repository translates it into the domain error.
        await repos.users.save(makeUser(THIRD_ID, EMAIL))
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError)

    // The write that succeeded before the violation must be gone…
    expect(await autocommit.users.findById(OTHER_ID)).toBeNull()
    // …and the row written outside the transaction must survive.
    expect(await autocommit.users.findById(ID)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e confirmar que passa**

```bash
pnpm exec vitest run --project integration tests/integration/unit-of-work.spec.ts
```

Esperado: **4 passed**.

> `pnpm test:integration -- unit-of-work` **não** filtra — roda os 7 arquivos do projeto
> de integração. Verificado durante a execução da fatia.

- [ ] **Step 3: Falsificar — o passo que substitui a fase vermelha**

Um teste que nunca falhou não provou nada. Quebre a fiação **de propósito**, no
`beforeAll`, fazendo a fábrica ignorar o `tx` e escrever pelo pool:

```ts
  unitOfWork = createUnitOfWork(createTransactionRunner(db), () => authRepositories(db))
```

Rode de novo. Esperado:

| Teste | Resultado esperado com a fiação quebrada |
|---|---|
| 1 — commita | **passa** (escrita chega ao banco de qualquer jeito) |
| 2 — rollback | **FALHA** — as escritas sobrevivem ao rollback |
| 3 — isolamento | **FALHA** — a linha fica visível antes do commit |
| 4 — erro de domínio | **FALHA** — a primeira escrita sobrevive |

Se algum dos três continuar verde, o teste correspondente não tem dente e precisa
ser corrigido antes de seguir. **Desfaça a quebra** e confirme os 4 verdes de novo.

- [ ] **Step 4: Commit**

```bash
pnpm lint:fix && pnpm lint
git add tests/integration/unit-of-work.spec.ts
git commit -m "test: prove the unit of work commits, rolls back and isolates"
```

---

## Task 5: Emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md` (decisões 15, 21 e 22)
- Modify: `ARCHITECTURE.md` (árvore de diretórios e regras de fronteira)

Sem código e sem teste. O portão é revisão de leitura.

- [ ] **Step 1: Emendar a decisão 22**

Insira o bloco abaixo logo após o título `### 22 — Atomicidade: Unit of Work
explícito`, antes do parágrafo que começa em "Um use case que escreve":

```markdown
> **Emendada em 2026-08-29**, pela fatia que a implementou. O contrato nasceu
> **genérico e transversal** — `IUnitOfWork<TRepos>` em `shared/ports/` — e não
> `IAuthUnitOfWork` dentro do módulo: o padrão se repete em todo módulo, e o
> esboço abaixo o faria renascer inteiro no segundo.
>
> Ele vem em **duas camadas**. Um `TransactionRunner` sem contexto abre a
> transação, faz commit/rollback e recusa aninhamento; `createUnitOfWork(runner,
> buildRepos)` casa esse runner com a fábrica de repositórios de um módulo. A
> mecânica da transação passa a existir **uma vez** no projeto, e um use case que
> legitimamente atravesse dois módulos funde as duas fábricas sobre a **mesma**
> transação — empilhar dois Units of Work seriam duas transações, que é o defeito
> que a guarda existe para pegar.
>
> A forma é **chamável** (`uow(work)`), não objeto com `.run()`: o objeto não tem
> estado nem segunda responsabilidade, então era embalagem sem conteúdo.
>
> E ganhou **guarda de aninhamento**. O `db.transaction` do Drizzle sobre o
> handle do pool tira **outra conexão**, então um `uow` dentro de outro abre
> transação independente, não savepoint: a de dentro commita enquanto a de fora
> faz rollback, e as duas travam de vez quando a de fora segura um lock de linha
> que a de dentro pede — impasse que o Postgres não quebra, porque a transação
> externa não espera lock, espera JavaScript. Desenho completo em
> [`specs/2026-08-29-unit-of-work-design.md`](superpowers/specs/2026-08-29-unit-of-work-design.md) §4.
```

- [ ] **Step 2: Emendar a decisão 15**

Insira logo após o título `### 15 — ...`, antes do corpo:

```markdown
> **Emendada em 2026-08-29.** O ALS deixou de ser uso único: a guarda de
> aninhamento do Unit of Work é o segundo. A distinção que sustenta a exceção é a
> mesma que a decisão 22 usou para **rejeitar** ALS ali — ela recusou transação
> ambiente porque a transação sumiria da assinatura e o repositório resolveria a
> conexão a partir de estado invisível. Aqui o storage carrega um booleano, nenhum
> repositório o lê, a transação continua explícita no parâmetro `repos`, e o único
> efeito possível do flag é lançar. É **detecção**, não propagação.
```

- [ ] **Step 3: Emendar a decisão 21**

Insira logo após o título `### 21 — ...`, junto das emendas que a seção já tem:

```markdown
> **Emendada em 2026-08-29.** "Contrato em `shared/ports/`, implementação em
> `infra/providers/`" foi escrito quando o único port transversal era o `IClock`.
> Adapter de **banco** vai para `infra/database/`: é onde o `Database` de que ele
> depende é declarado, e o projeto já tinha o precedente — `DrizzleUsersRepository`
> mora em `modules/auth/infra/drizzle/`, pasta nomeada pela tecnologia, não em
> `infra/providers/`. A regra geral continua valendo; o que ela nomeia é a
> **camada**, não uma pasta única.
```

- [ ] **Step 4: Atualizar o `ARCHITECTURE.md`**

Duas edições:

1. Na árvore de diretórios, acrescentar `unit-of-work.ts` em `shared/ports/`,
   `transaction-runner.ts` e `unit-of-work.ts` em `infra/database/`, e
   `auth-repositories.ts` em `modules/auth/infra/drizzle/`.
2. Na seção de fronteira, registrar as duas regras que o lint não alcança:
   - **use case que recebe o UoW não recebe repositório direto** — o repositório
     singleton escreve fora da transação, compila, passa no teste unitário e
     quebra a atomicidade em produção;
   - **o que não pode entrar no callback** — I/O externo, CPU pesada (argon2) e
     escrita que precisa sobreviver ao rollback.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md ARCHITECTURE.md
git commit -m "docs: amend decisions 15, 21 and 22 for the unit of work"
```

---

## Verificação final da fatia

Com Postgres de pé:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Esperado: lint sem achados, `tsc` silencioso, **155 unitários** e a integração
inteira verde, incluindo os 4 casos novos.

Confira também, à mão:

- [ ] `src/shared/ports/unit-of-work.ts` **não tem import nenhum**.
- [ ] `src/modules/auth/repositories/unit-of-work.ts` importa apenas
      `#shared/ports/unit-of-work` e `./users-repository.js` — nada de
      `drizzle-orm`, `pg` ou `#infra/database/client`.
- [ ] `git grep -n "new DrizzleUsersRepository" src/` devolve **uma** linha, em
      `auth-repositories.ts`. Se aparecer no container, a fábrica não ficou sendo
      o único lugar que conhece o conjunto.
- [ ] `git grep -n "AsyncLocalStorage" src/` devolve **duas** ocorrências: a do
      `request-context.ts` e a do runner. Uma terceira significa que a exceção
      da decisão 15 escapou de novo.

## O que esta fatia deliberadamente NÃO entrega

- **Nenhum use case usa o `uow`.** O primeiro consumidor é a rotação da fatia 5.
  A chave no container fica publicada e ociosa por uma fatia — custo aceito no
  §11.1 da spec.
- **`IRefreshTokensRepository` e a tabela `refresh_tokens`.** Nascem com as regras
  que as governam.
- **Savepoint / aninhamento legítimo.** Aninhar lança. Suportá-lo exigiria levar o
  `tx` no contexto assíncrono, que é a propagação implícita que a decisão 22
  rejeitou.
- **Nível de isolamento configurável.** O default do Postgres serve a rotação, e
  `db.transaction` aceita config por chamada quando isso mudar.
