# Tabela `users` e primeira migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a tabela `users` no módulo `auth` e a primeira migration do
projeto, exercendo pela primeira vez o caminho `db:generate` → SQL commitada →
`db:migrate` → CI.

**Architecture:** O schema Drizzle mora dentro do módulo
(`src/modules/auth/infra/drizzle/schema.ts`), que é onde o glob do
`drizzle.config.ts` já procura e hoje não encontra nada. Todo default de coluna
é defense-in-depth para escrita direta — a partir da próxima fatia a aplicação é
a fonte de `id` e dos timestamps, via `IIdGenerator` e `IClock` (R7). Unicidade
de e-mail case-insensitive sai de um índice único funcional em `lower(email)`,
sem a extensão `citext`. Um `globalSetup` do Vitest aplica as migrations antes
da suíte de integração, porque o banco de teste é `tmpfs` e nasce vazio a cada
restart do container.

**Tech Stack:** TypeScript 7 (ESM, `nodenext`), Node 24.19.0, pnpm 11.7.0,
Drizzle ORM + drizzle-kit `1.0.0-rc.4`, `pg` (node-postgres), PostgreSQL
18.4, Vitest 4, Biome 2.

**Spec:** [`docs/superpowers/specs/2026-08-25-users-schema-first-migration-design.md`](../specs/2026-08-25-users-schema-first-migration-design.md)

## Global Constraints

- **Node `>=24.19.0 <25`.** A máquina tem `v24.16.0` como default e o `pnpm`
  **recusa todo script** com `Your Node version is incompatible`. Rode
  `fnm use` (lê o `.nvmrc`) antes de qualquer comando, em cada shell novo.
- **Idioma:** todo código, identificador, string e **comentário** em inglês.
  Markdown pode ser português.
- **Sem magic string/number:** extrair para constante `UPPER_SNAKE_CASE`.
  **Exceção única:** nomes de tabela, coluna e índice dentro de
  `src/modules/*/infra/drizzle/schema.ts` são escritos inline (`CLAUDE.md`).
  Todo outro literal desses arquivos segue a regra.
- **Imports:** entre diretórios de topo use `#modules/*`, `#shared/*`,
  `#infra/*`, `#main/*`. Dentro da mesma pasta, relativo **com sufixo `.js`**
  (exigência do ESM `nodenext`).
- **R2 — coluna sempre nomeada explicitamente**, nunca inferência de casing.
- **R4 — migrations forward-only**, sem `down`.
- **R6 — só `src/infra/config/env.ts` lê `process.env`.**
- **FK entre módulos é proibida** (§5 da spec). Nesta fatia só existe um
  módulo, então não é exercida — mas vale para o schema que sai daqui.
- Toda migration gerada é **commitada**.

---

### Task 1: Schema `users` e a primeira migration

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema.ts`
- Create (gerados por `drizzle-kit`): `drizzle/0000_*.sql`,
  `drizzle/meta/_journal.json`, `drizzle/meta/0000_snapshot.json`

**Interfaces:**
- Consumes: nada. É o primeiro arquivo sob `src/modules/`.
- Produces: `users`, exportado de `#modules/auth/infra/drizzle/schema`.
  Propriedades TypeScript e respectivas colunas:
  `id` → `id` (uuid, PK), `email` → `email` (text), `passwordHash` →
  `password_hash` (text), `createdAt` → `created_at` (timestamptz),
  `updatedAt` → `updated_at` (timestamptz). Índice único funcional
  `users_email_lower_unique` sobre `lower(email)`.

- [ ] **Step 1: Ativar a versão de Node do projeto**

```bash
fnm use
node -v   # precisa imprimir v24.19.0
```

- [ ] **Step 2: Confirmar o estado "antes" — o glob não casa com nada**

Run: `pnpm db:generate`

Expected: falha com
`Error  No schema files found for path config ['./src/modules/*/infra/drizzle/schema.ts']`

Este é o problema que a fatia existe para resolver. Se este comando **não**
falhar assim, pare: o repositório não está no estado que o plano assume.

- [ ] **Step 3: Criar o arquivo de schema**

Create `src/modules/auth/infra/drizzle/schema.ts`:

```ts
import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Credentials of an application user. This module owns the table: a foreign key
 * may point here only from inside `auth`. Other modules reference a user by id,
 * with no database constraint, so that a module stays extractable.
 *
 * Every default below is defense-in-depth for direct writes (seeds, psql). The
 * application is the source of truth: from the next slice on, `IIdGenerator` and
 * `IClock` produce `id`, `created_at` and `updated_at`, and the repository sends
 * them explicitly.
 *
 * The domain normalizes email to lowercase; the functional unique index enforces
 * case-insensitive uniqueness without requiring the `citext` extension.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`)],
)
```

- [ ] **Step 4: Gerar a migration**

Run: `pnpm db:generate`

Expected: sucesso, criando `drizzle/0000_<nome-aleatorio>.sql` e a pasta
`drizzle/meta/`. O nome do arquivo é sorteado pelo drizzle-kit — anote o nome
real, ele é usado no `git add` do Step 7.

- [ ] **Step 5: Conferir o SQL gerado**

Run: `cat drizzle/0000_*.sql`

Expected: o arquivo precisa conter, em alguma forma equivalente:

```sql
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));
```

Duas conferências que **não** são cosméticas:

1. O índice precisa dizer `lower("email")`, não `("email")`. Sem o `lower`, a
   unicidade vira case-**sensitive** e o Task 2 vai pegar isso.
2. `timestamp with time zone` nos dois timestamps. Se aparecer `timestamp` sem
   timezone, o `withTimezone: true` foi perdido.

Se qualquer uma falhar, corrija `schema.ts`, apague `drizzle/` inteiro e
recomece do Step 4.

- [ ] **Step 6: Aplicar a migration num banco limpo**

```bash
docker compose restart postgres-test
until docker exec api-clean-platform-postgres-test pg_isready -U api_clean_platform -d api_clean_platform_test >/dev/null 2>&1; do sleep 1; done
DATABASE_URL='postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test' pnpm db:migrate
```

Expected: aplica sem erro. Confirme a tabela e o índice:

```bash
docker exec api-clean-platform-postgres-test psql -U api_clean_platform -d api_clean_platform_test -Atc "select indexdef from pg_indexes where tablename = 'users';"
```

Expected: uma das linhas contém `lower(email)`.

- [ ] **Step 7: Lint, typecheck e commit**

```bash
pnpm lint && pnpm typecheck
git add src/modules/auth/infra/drizzle/schema.ts drizzle/
git commit -m "feat: add the users table and the project's first migration

The drizzle.config.ts glob has pointed at
src/modules/*/infra/drizzle/schema.ts since the Drizzle setup landed,
but nothing had ever matched it, so db:generate had never produced a
migration and the CI db:migrate step ran over an empty folder.

Column defaults are defense-in-depth for direct writes only. The
application becomes the source of id and timestamps in the next slice,
through IIdGenerator and IClock.

Email uniqueness is a functional unique index over lower(email), which
avoids depending on the citext extension in every derived database."
```

---

### Task 2: Migrations automáticas na suíte de integração, e as provas do schema

**Files:**
- Create: `tests/integration/setup/test-database-url.ts`
- Create: `tests/integration/setup/migrate-test-database.ts`
- Create: `tests/integration/users-schema.spec.ts`
- Modify: `vitest.config.ts` (importar a constante, registrar o `globalSetup`)

**Interfaces:**
- Consumes: `users` de `#modules/auth/infra/drizzle/schema` (Task 1);
  `createDatabase` e o tipo `Database` de `#infra/database/client`; `env` de
  `#infra/config/env`.
- Produces: `TEST_DATABASE_URL` (string) exportada de
  `tests/integration/setup/test-database-url.ts`; `setup()` (async, sem
  argumentos) exportada de `tests/integration/setup/migrate-test-database.ts`.

**Contexto para quem executa:** o serviço `postgres-test` do
`docker-compose.yml` usa `tmpfs`, então **todo restart do container zera o
banco**. Isso foi verificado. É por isso que um passo manual de migration não
serve e o `globalSetup` é necessário.

- [ ] **Step 1: Zerar o banco de teste, para o teste falhar pelo motivo certo**

```bash
fnm use
docker compose restart postgres-test
until docker exec api-clean-platform-postgres-test pg_isready -U api_clean_platform -d api_clean_platform_test >/dev/null 2>&1; do sleep 1; done
docker exec api-clean-platform-postgres-test psql -U api_clean_platform -d api_clean_platform_test -Atc "select to_regclass('public.users') is null as esta_limpo;"
```

Expected: `t`. A tabela criada no Task 1 sumiu com o restart — é exatamente o
estado de uma máquina nova ou de um runner de CI.

- [ ] **Step 2: Escrever o teste que ainda falha**

Create `tests/integration/users-schema.spec.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { users } from '#modules/auth/infra/drizzle/schema'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming
// the index would break the database and still keep this suite green.
const EMAIL_LOWER_UNIQUE_INDEX = 'users_email_lower_unique'
const EMAIL = 'joao@example.com'
const EMAIL_DIFFERING_ONLY_BY_CASE = 'JOAO@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let db: Database
let pool: Pool

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(users)
})

describe('users table', () => {
  it('stores a row and reads it back', async () => {
    const [inserted] = await db
      .insert(users)
      .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
      .returning()

    const found = await db.select().from(users).where(eq(users.email, EMAIL))

    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe(inserted?.id)
    expect(found[0]?.passwordHash).toBe(PASSWORD_HASH)
  })

  it('rejects an email that differs from an existing one only by case', async () => {
    await db.insert(users).values({ email: EMAIL, passwordHash: PASSWORD_HASH })

    // Asserting on the index name, not just on "it threw": that is what proves
    // the rejection came from the functional index over lower(email) rather
    // than from any other constraint.
    await expect(
      db
        .insert(users)
        .values({ email: EMAIL_DIFFERING_ONLY_BY_CASE, passwordHash: PASSWORD_HASH }),
    ).rejects.toThrow(EMAIL_LOWER_UNIQUE_INDEX)
  })

  it('fills id and both timestamps from the column defaults', async () => {
    // Inserting only the two required columns: whatever comes back was produced
    // by the database, which is the defense-in-depth the defaults exist for.
    const [inserted] = await db
      .insert(users)
      .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
      .returning()

    expect(inserted?.id).toMatch(UUID_PATTERN)
    expect(inserted?.createdAt).toBeInstanceOf(Date)
    expect(inserted?.updatedAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar pelo motivo certo**

Run: `pnpm test:integration`

Expected: os três testes de `users-schema.spec.ts` falham com
`relation "users" does not exist` (código Postgres `42P01`).

Este é o ponto do exercício: a suíte não tem como aplicar migration sozinha
ainda. Se falhar com outra mensagem, investigue antes de seguir.

- [ ] **Step 4: Extrair a URL do banco de teste para uma fonte única**

Create `tests/integration/setup/test-database-url.ts`:

```ts
/**
 * The one place this URL is written outside CI. `vitest.config.ts` injects it as
 * `DATABASE_URL` for the tests, and the global setup connects with it to apply
 * migrations.
 *
 * `.github/workflows/ci.yml` deliberately keeps its own copy: the Postgres
 * service container is configured before any of this code could be read.
 */
export const TEST_DATABASE_URL =
  'postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test'
```

- [ ] **Step 5: Escrever o global setup que aplica as migrations**

Create `tests/integration/setup/migrate-test-database.ts`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './test-database-url.js'

const MIGRATIONS_FOLDER = './drizzle'

/**
 * Applies every committed migration before the integration suite runs.
 *
 * The test database is `tmpfs` (see docker-compose.yml), so it is empty again
 * after every container restart. CI applies migrations as its own pipeline step;
 * this keeps the local run identical without asking anyone to remember a manual
 * command.
 *
 * Idempotent: Drizzle records which migrations it has already applied.
 */
export async function setup() {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL })

  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}
```

- [ ] **Step 6: Registrar o global setup e remover a URL duplicada**

Modify `vitest.config.ts`. Três mudanças:

1. Adicionar o import, logo abaixo do import existente do `vitest/config`:

```ts
import { TEST_DATABASE_URL } from './tests/integration/setup/test-database-url.js'
```

2. **Apagar** a declaração local que existe hoje (o `const TEST_DATABASE_URL =`
   com a string literal). O `env` mais abaixo passa a usar a importada, sem
   nenhuma outra mudança.

3. Declarar a constante do caminho e registrar o `globalSetup` **somente no
   projeto `integration`** — o projeto `unit` não toca banco:

```ts
const INTEGRATION_GLOBAL_SETUP = './tests/integration/setup/migrate-test-database.ts'
```

```ts
      {
        test: {
          name: INTEGRATION_PROJECT,
          include: [INTEGRATION_INCLUDE],
          // Migrations run before the suite: the test database is tmpfs, so it
          // is empty after every container restart.
          globalSetup: [INTEGRATION_GLOBAL_SETUP],
          // Every integration file shares the same Postgres, so they run
          // serially — parallel files would step on each other's state.
          fileParallelism: false,
        },
      },
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test:integration`

Expected: PASS — 2 arquivos, 5 testes (os 2 de `health.spec.ts` mais os 3
novos).

- [ ] **Step 8: Provar que o teste do índice detecta um índice não funcional**

Sem esta verificação, o teste de case-insensitivity poderia estar passando por
acidente. Quebre o índice **direto no banco** (sem tocar em `schema.ts`, e sem
gerar migration nenhuma):

```bash
docker exec api-clean-platform-postgres-test psql -U api_clean_platform -d api_clean_platform_test -c "DROP INDEX users_email_lower_unique; CREATE UNIQUE INDEX users_email_lower_unique ON users (email);"
pnpm test:integration
```

Expected: **`rejects an email that differs from an existing one only by case`
FALHA.** Os outros quatro continuam passando.

Se ele passar mesmo com o índice quebrado, o teste não vale nada — pare e
conserte antes de continuar.

Agora restaure. O `tmpfs` faz a limpeza de graça:

```bash
docker compose restart postgres-test
until docker exec api-clean-platform-postgres-test pg_isready -U api_clean_platform -d api_clean_platform_test >/dev/null 2>&1; do sleep 1; done
pnpm test:integration
```

Expected: PASS nos 5. Isso também reprova, de quebra, que o `globalSetup`
recria tudo a partir de um banco zerado.

- [ ] **Step 9: Suíte completa, lint, typecheck, build**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: tudo verde.

- [ ] **Step 10: Commit**

```bash
git add tests/integration/setup/ tests/integration/users-schema.spec.ts vitest.config.ts
git commit -m "test: prove the users migration, and apply migrations before the suite

The integration suite had no way to create its own schema. That went
unnoticed while no table existed, and would have surfaced as a bare
'relation does not exist' the moment one did, since the test database
is tmpfs and empties on every container restart. A Vitest globalSetup,
registered only on the integration project, now applies the committed
migrations before the suite runs, matching what CI already does.

The case-insensitivity test asserts on the index name so that it fails
if the uniqueness ever stops coming from the functional index over
lower(email). Verified by replacing the index with a plain one and
watching only that test fail.

The test database URL was a literal in vitest.config.ts and is now
imported from one module, so the global setup did not become a third
copy. CI keeps its own, as its comment already explains."
```

---

### Task 3: Propagar as duas regras novas para a documentação viva

**Files:**
- Modify: `docs/DECISIONS.md` (nova decisão na seção 2; item novo na seção 6)
- Modify: `docs/STRUCTURE.md` (nota na §4)
- Modify: `ARCHITECTURE.md` (§6, Banco de dados)

**Interfaces:**
- Consumes: as decisões registradas na §5 e na §6 da spec.
- Produces: nada em código.

**Por que existe:** a spec em `docs/superpowers/specs/` é um documento de
desenho arquivado, não a referência viva do projeto. A regra de FK entre módulos
só passa a valer para quem escrever o segundo módulo se estiver nos documentos
que essa pessoa vai ler.

- [ ] **Step 1: Registrar a decisão em `docs/DECISIONS.md`**

Adicionar ao fim da seção `## 2. Decisões fechadas`, seguindo o formato das
decisões existentes (número, título, corpo curto, `---` de separação):

```markdown
### 24 — Schema mora no módulo; FK só dentro do módulo

O arquivo de schema fica em `src/modules/<m>/infra/drizzle/schema.ts`, onde o
glob da decisão 06 já procura. Consequência direta da linha `module-infra` da
regra de fronteira (decisão 18): um módulo não importa o `infra/` de outro,
então **um schema não pode referenciar a tabela de outro módulo**.

| Foreign key | Situação |
|---|---|
| `refresh_tokens.user_id → users.id` (ambos em `auth`) | Legal — mesmo módulo |
| `orders.user_id → users.id` (`orders` → `auth`) | Proibida |

Entre módulos, referencia-se **por id, sem constraint**: coluna `uuid('user_id')`
sem `.references()`, integridade na aplicação.

**Por que não é limitação:** é a mesma restrição que existiria se os módulos já
fossem serviços separados, e é o que faz "módulo extraível" ser real. Com FK
física de `orders` para `users`, extrair `orders` vira migração de dados em vez
de mover arquivos.

**Custo aceito:** sem integridade referencial no banco entre módulos. `ON DELETE`
passa a ser regra de aplicação ou evento de domínio, não constraint.

Desenho completo em
[`specs/2026-08-25-users-schema-first-migration-design.md`](superpowers/specs/2026-08-25-users-schema-first-migration-design.md) §5.

---
```

- [ ] **Step 2: Registrar o que ficou em aberto, em `docs/DECISIONS.md`**

Na seção `## 6. Decisões em aberto`, dentro do bloco **"Podem esperar o primeiro
módulo existir"**, acrescentar:

```markdown
- **Colisão de nome de tabela entre módulos.** Nada impede dois módulos
  declararem `users`. O `drizzle-kit` junta os globs e gera a migration com as
  duas — e o erro aparece no `db:migrate`, não no lint. Saídas possíveis:
  disciplina, prefixo por módulo (`auth_users`), ou um schema do Postgres por
  módulo (`pgSchema('auth')`). Decidido ficar em `public` por ora, já que
  `ALTER TABLE ... SET SCHEMA` torna a migração posterior barata.
```

- [ ] **Step 3: Anotar a consequência para schema em `docs/STRUCTURE.md`**

Ao fim da §4 (`A regra de fronteira`), logo após a lista "As quatro coisas que
isso garante", acrescentar:

```markdown
### O que isso significa para arquivo de schema

`infra/drizzle/schema.ts` é `module-infra`, então a linha 3 vale nele como em
qualquer outro arquivo: **FK dentro do módulo é normal, FK para a tabela de
outro módulo é proibida.** Entre módulos, coluna de id sem `.references()`, com
a integridade na aplicação. Ver decisão 24.
```

- [ ] **Step 4: Anotar em `ARCHITECTURE.md` §6**

Ao fim da §6 (`Banco de dados`), acrescentar:

```markdown
### Posse de tabela

Cada módulo declara suas tabelas em `infra/drizzle/schema.ts`. Uma foreign key
só atravessa arquivos **do mesmo módulo**; entre módulos, referencia-se por id
sem constraint, e a integridade fica na aplicação. Todas as tabelas vivem em
`public` — um schema do Postgres por módulo foi considerado e adiado. Decisão 24.
```

- [ ] **Step 5: Conferir os links e commitar**

```bash
pnpm lint
git add docs/DECISIONS.md docs/STRUCTURE.md ARCHITECTURE.md
git commit -m "docs: record that a schema belongs to its module and FKs do not cross

The boundary rule already forbade a module's infra from importing
another module's infra, but nobody had drawn the consequence for
schema files, where it decides whether a foreign key may exist at all.
Recorded as decision 24 and cross-referenced from the two documents
someone writing the second module would actually read.

Table-name collision between modules goes to the open list rather than
being quietly assumed away: nothing catches it until db:migrate."
```

---

## Auto-revisão do plano

**Cobertura da spec:**

| Seção da spec | Onde é implementada |
|---|---|
| §1 escopo | Tasks 1–3 |
| §2 ordem invertida | Nada a implementar — decisão registrada |
| §3 R7 / defaults defense-in-depth | Task 1 Step 3 (`.defaultRandom()`, `.defaultNow()`), Task 2 Step 2 (terceiro teste) |
| §4 schema | Task 1 Steps 3–5 |
| §5 posse de tabela e FK | Task 1 Step 3 (comentário), Task 3 (documentação viva) |
| §6 exceção da `CLAUDE.md` | Já commitada em `88cb138`, antes deste plano |
| §7 migration + globalSetup + dedup da URL | Task 2 Steps 4–7 |
| §8 colunas de fora | Task 1 Step 3 — a tabela não tem `tokens_valid_after` nem `email_verified_at` |
| §9 as três provas | Task 2 Step 2 |
| §10 critério de aceite | Task 1 Steps 5–6, Task 2 Steps 7–9 |
| §11 Node | Global Constraints e Task 1 Step 1 |

**Critério de aceite da spec §10, um a um:**

- `db:generate` produz `drizzle/0000_*.sql` commitada → Task 1 Steps 4, 7
- `db:migrate` aplica num banco limpo → Task 1 Step 6
- `test:integration` passa de um banco recém-criado, sem passo manual → Task 2
  Step 8 (segunda metade)
- O teste do índice falha se o `lower()` sumir → Task 2 Step 8 (primeira metade)
- `lint`, `typecheck`, `build` verdes → Task 2 Step 9
- `TEST_DATABASE_URL` uma única vez fora do `ci.yml` → Task 2 Steps 4, 6

**Consistência de tipos:** `users` é produzida no Task 1 e consumida no Task 2
com os mesmos nomes de propriedade (`passwordHash`, `createdAt`, `updatedAt`).
`TEST_DATABASE_URL` e `setup()` são produzidas no Task 2 Steps 4–5 e consumidas
no Step 6. `createDatabase` e `Database` já existem em
`src/infra/database/client.ts` com as assinaturas usadas.

**Verificado empiricamente antes de escrever este plano**, para que nenhum passo
dependa de suposição:

- `globalSetup` no nível de projeto funciona no Vitest 4 — provado com sentinela.
- `docker compose restart postgres-test` zera o `tmpfs` — provado com tabela.
- `vitest.config.ts` importa `./tests/.../*.js` sem erro de resolução, com
  `typecheck` verde.
- `drizzle-kit` resolve `DATABASE_URL` do `.env` sozinho.
- O glob hoje falha com a mensagem exata citada no Task 1 Step 2.
