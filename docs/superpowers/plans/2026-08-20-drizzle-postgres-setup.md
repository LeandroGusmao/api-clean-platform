# Drizzle + Postgres Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the project to a real Postgres via Drizzle (connection + migration tooling), and make `GET /health` report whether that connection is actually up.

**Architecture:** `src/infra/database/client.ts` is new global infra (no module owns it, same category as `env.ts`/`server.ts`) exposing a `pg` pool and a Drizzle instance. `main/http.ts` opens it at boot and hands it to `healthRoute` as a plugin option — the same mechanism modules use to receive their container slice. No business module or table is created; `drizzle.config.ts`'s schema glob is prepared for the first module that will use it.

**Tech Stack:** `pg` 8.23.0, `drizzle-orm` 1.0.0-rc.4, `drizzle-kit` 1.0.0-rc.4, `@types/pg` 8.23.1, Postgres `18.4-alpine3.24` (Docker Compose, local dev only).

**Spec:** `docs/superpowers/specs/2026-08-20-drizzle-postgres-setup-design.md`

## Global Constraints

- Every new dependency is pinned to an **exact** version — no `^`, no `~` (project-wide rule, `DECISIONS.md` §7 for the same rule applied to Drizzle itself).
- `drizzle-orm` and `drizzle-kit` must stay in lockstep at `1.0.0-rc.4` exact.
- `pg` at `8.23.0` exact, `@types/pg` at `8.23.1` exact, both `devDependencies`/`dependencies` as noted per task.
- Postgres version is `18.4-alpine3.24` everywhere it's referenced (compose file and the root `ARCHITECTURE.md`).
- `DATABASE_URL` is required with **no default** — the process must fail fast at boot if it's missing, same pattern as every other var in `env.ts`.
- **No preflight DB connectivity check at boot.** The server must call `app.listen()` regardless of whether the database is reachable, so `/health` can report an outage instead of the process crash-looping.
- `/health` contract: `200 { status: "ok", database: "up" }` on success, `503 { status: "error", database: "down" }` on failure.
- Only the root `ARCHITECTURE.md` is edited for documentation. `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/STRUCTURE.md` are local reference material (gitignored) and are out of scope.
- There is no test runner in this project (no Vitest, no Jest). Every verification step in this plan is a manual command with an exact expected output — do not invent a test file.
- Every shell command that touches `pnpm`/`node` must run under Node `24.19.0` (the version pinned in `.nvmrc` and `engines`). If the active Node differs, prefix the command with:
  ```bash
  eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
  ```

---

### Task 1: Add and pin the Postgres/Drizzle dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `pg`, `drizzle-orm`, `drizzle-kit`, `@types/pg` available as installed packages; `pnpm db:generate` and `pnpm db:migrate` scripts. Later tasks import from `pg` and `drizzle-orm/*`.

- [ ] **Step 1: Install the runtime dependencies, pinned exact**

```bash
eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
pnpm add pg@8.23.0 drizzle-orm@1.0.0-rc.4 --save-exact
```

- [ ] **Step 2: Install the dev dependencies, pinned exact**

```bash
pnpm add -D @types/pg@8.23.1 drizzle-kit@1.0.0-rc.4 --save-exact
```

- [ ] **Step 3: Add the migration scripts to `package.json`**

In the `"scripts"` object, add these two entries (keep the existing ones untouched):

```jsonc
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```

- [ ] **Step 4: Verify no caret/tilde slipped in**

Run: `grep -E '"\^|"~' package.json`
Expected: no output (empty match means nothing is range-pinned).

- [ ] **Step 5: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: exits 0, no output (nothing consumes the new packages yet, so this only proves the install didn't break anything existing).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
build: add pinned Postgres and Drizzle dependencies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Docker Compose for local Postgres

**Files:**
- Create: `docker-compose.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces: a reachable Postgres at `postgres://postgres:postgres@localhost:5432/app` when the container is up. Task 3 depends on `.env.example` having the matching `DATABASE_URL` line.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

- [ ] **Step 2: Add `DATABASE_URL` to `.env.example`**

Append this line to the existing file (which currently has `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`):

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app
```

- [ ] **Step 3: Start the container**

```bash
docker compose up -d
```

Expected: `docker compose ps` shows the `postgres` service as `running` (or `healthy` if a healthcheck is later added — none is defined here, so `running` is sufficient).

- [ ] **Step 4: Verify connectivity from inside the container**

```bash
docker compose exec postgres psql -U postgres -d app -c 'select 1;'
```

Expected: prints a `?column?` table with one row containing `1`.

- [ ] **Step 5: Leave the container running** — later tasks (3, 4, 5) need it up. Do not `docker compose down` yet.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "$(cat <<'EOF'
feat: add Docker Compose for local Postgres

Only infra, per the project's existing convention: the application
keeps running on the host via `pnpm dev`.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `DATABASE_URL` in `env.ts`

**Files:**
- Modify: `src/infra/config/env.ts:18-23` (the `envSchema` object)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Env['DATABASE_URL']: string`, required, validated as a URL. Task 4's `createDatabase(env: Env)` depends on this field existing.

- [ ] **Step 1: Add `DATABASE_URL` to the schema**

In `src/infra/config/env.ts`, the current schema is:

```ts
const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(NODE_ENV_DEVELOPMENT),
  HOST: z.string().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
})
```

Change it to:

```ts
const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(NODE_ENV_DEVELOPMENT),
  HOST: z.string().min(1).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  DATABASE_URL: z.url(),
})
```

No default value — the process must fail to boot if it's missing, same as every required var here.

- [ ] **Step 2: Create a local `.env`** (gitignored, never committed)

```bash
cp .env.example .env
```

- [ ] **Step 3: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: exits 0, no output.

- [ ] **Step 4: Verify fail-fast when `DATABASE_URL` is missing**

```bash
eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
cp .env /tmp/health-db-env-backup
sed -i '/^DATABASE_URL=/d' .env
timeout 3 pnpm dev > /tmp/env-missing.log 2>&1
cat /tmp/env-missing.log
cp /tmp/health-db-env-backup .env
```

Expected: `/tmp/env-missing.log` contains `Invalid environment variables` and a line mentioning `DATABASE_URL` (from `z.prettifyError`), and the process exits before printing `Server listening at`.

- [ ] **Step 5: Verify the server boots with `DATABASE_URL` restored**

```bash
timeout 3 pnpm dev > /tmp/env-present.log 2>&1
cat /tmp/env-present.log
```

Expected: `/tmp/env-present.log` contains `Server listening at http://127.0.0.1:3000`.

- [ ] **Step 6: Commit**

```bash
git add src/infra/config/env.ts
git commit -m "$(cat <<'EOF'
feat: require DATABASE_URL in env validation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(`.env` stays untracked — do not `git add` it.)

---

### Task 4: Drizzle client and `drizzle-kit` config

**Files:**
- Create: `src/infra/database/client.ts`
- Create: `drizzle.config.ts` (repo root)
- Modify: `biome.json` (add an override for `drizzle.config.ts`)

**Interfaces:**
- Consumes: `Env` (from `#infra/config/env`, produced in Task 3), specifically `env.DATABASE_URL`.
- Produces: `export type Database = NodePgDatabase<Record<string, never>> | PgTransaction<any, any, any>` and `export function createDatabase(env: Env): { db: Database; pool: Pool }`. Task 5 imports both from `#infra/database/client`.

- [ ] **Step 1: Write `src/infra/database/client.ts`**

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import type { Env } from '#infra/config/env'

// The object Drizzle hands to a `db.transaction()` callback isn't the same
// type as the top-level handle; repositories accepting both need this union.
// biome-ignore lint/suspicious/noExplicitAny: PgTransaction's generics track Drizzle's internal query-builder state, not domain data — pinning them to one schema/config combination breaks the union for every other case.
export type Database = NodePgDatabase<Record<string, never>> | PgTransaction<any, any, any>

export function createDatabase(env: Env): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: env.DATABASE_URL })
  const db = drizzle(pool)
  return { db, pool }
}
```

- [ ] **Step 2: Write `drizzle.config.ts` at the repo root**

```ts
import { defineConfig } from 'drizzle-kit'

const SCHEMA_GLOB = './src/modules/*/infra/drizzle/schema.ts'
const MIGRATIONS_OUT_DIR = './drizzle'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run drizzle-kit')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: SCHEMA_GLOB,
  out: MIGRATIONS_OUT_DIR,
  dbCredentials: { url: databaseUrl },
})
```

This file sits outside `src/`, so `tsconfig.json`'s `rootDir: "src"` / `include: ["src/**/*.ts"]` correctly excludes it from `pnpm typecheck` — it's only ever loaded by the `drizzle-kit` CLI, not by `tsc`.

- [ ] **Step 3: Allow `process.env` in `drizzle.config.ts` via `biome.json`**

`drizzle.config.ts` reads `process.env` directly, same justification as R6's existing exception for `env.ts` (CLI-only config, not application runtime code) — but the current `biome.json` override only covers `src/infra/config/env.ts`, so this file would otherwise fail `pnpm lint` on `noProcessEnv`.

Current `overrides` array:

```json
  "overrides": [
    {
      "includes": ["src/infra/config/env.ts"],
      "linter": {
        "rules": {
          "style": {
            "noProcessEnv": "off"
          }
        }
      }
    }
  ]
```

Add a second entry:

```json
  "overrides": [
    {
      "includes": ["src/infra/config/env.ts"],
      "linter": {
        "rules": {
          "style": {
            "noProcessEnv": "off"
          }
        }
      }
    },
    {
      "includes": ["drizzle.config.ts"],
      "linter": {
        "rules": {
          "style": {
            "noProcessEnv": "off"
          }
        }
      }
    }
  ]
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0, no output.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: exits 0. If formatting is off (e.g. import order), run `pnpm lint:fix` and re-run `pnpm lint` to confirm exit 0.

- [ ] **Step 6: Verify `drizzle.config.ts` loads correctly**

```bash
pnpm db:generate
```

Expected: the command completes without a config-loading error (no stack trace about a missing/invalid `DATABASE_URL`, no TypeScript import error). Since no module declares a schema yet, `drizzle-kit` finding zero tables and producing no migration file is the correct outcome here, not a failure — do not treat that as something to fix.

- [ ] **Step 7: Commit**

```bash
git add src/infra/database/client.ts drizzle.config.ts biome.json
git commit -m "$(cat <<'EOF'
feat: add Drizzle client and drizzle-kit config

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `/health` reports the database connection

**Files:**
- Modify: `src/infra/http/endpoints/health.ts` (full rewrite)
- Modify: `src/main/http.ts` (full rewrite)

**Interfaces:**
- Consumes: `Database` and `createDatabase` from `#infra/database/client` (Task 4).
- Produces: `GET /health` now returns `200 { status: "ok", database: "up" }` or `503 { status: "error", database: "down" }`.

- [ ] **Step 1: Rewrite `src/infra/http/endpoints/health.ts`**

Replace the entire file with:

```ts
import { sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { Database } from '#infra/database/client'

const HEALTH_CHECK_PATH = '/health'
const OK_STATUS = 'ok' as const
const ERROR_STATUS = 'error' as const
const DATABASE_UP = 'up' as const
const DATABASE_DOWN = 'down' as const
const SERVICE_UNAVAILABLE_STATUS = 503

const okSchema = z.object({ status: z.literal(OK_STATUS), database: z.literal(DATABASE_UP) })
const downSchema = z.object({ status: z.literal(ERROR_STATUS), database: z.literal(DATABASE_DOWN) })

export const healthRoute: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    HEALTH_CHECK_PATH,
    { schema: { response: { 200: okSchema, [SERVICE_UNAVAILABLE_STATUS]: downSchema } } },
    async (_request, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { status: OK_STATUS, database: DATABASE_UP }
      } catch {
        return reply
          .status(SERVICE_UNAVAILABLE_STATUS)
          .send({ status: ERROR_STATUS, database: DATABASE_DOWN })
      }
    },
  )
}
```

- [ ] **Step 2: Rewrite `src/main/http.ts`**

Replace the entire file with:

```ts
import { env } from '#infra/config/env'
import { createDatabase } from '#infra/database/client'
import { healthRoute } from '#infra/http/endpoints/health'
import { buildServer } from '#infra/http/server'

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const app = buildServer(env)
const { db, pool } = createDatabase(env)

await app.register(healthRoute, { db })

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    Promise.all([app.close(), pool.end()]).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}

try {
  await app.listen({ host: env.HOST, port: env.PORT })
} catch (err) {
  app.log.fatal(err, 'failed to start the server')
  process.exit(1)
}
```

Note there is deliberately no connectivity check between `createDatabase(env)` and `app.listen()` — `new Pool(...)` doesn't connect eagerly, and the server must come up regardless of database reachability (Global Constraints).

- [ ] **Step 3: Typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both exit 0. If lint fails only on formatting, run `pnpm lint:fix` then re-run `pnpm lint`.

- [ ] **Step 4: Verify `GET /health` with the database up**

```bash
eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
docker compose up -d
for i in $(seq 1 10); do docker compose exec postgres pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done

pnpm dev > /tmp/health-db-up.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null | grep -q 200 && break
  sleep 0.5
done
curl -s -i http://localhost:3000/health
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: `HTTP/1.1 200 OK` with body `{"status":"ok","database":"up"}`.

- [ ] **Step 5: Verify `GET /health` with the database down**

```bash
docker compose stop postgres

pnpm dev > /tmp/health-db-down.log 2>&1 &
SERVER_PID=$!
sleep 3
curl -s -i http://localhost:3000/health
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

docker compose start postgres
```

Expected: `HTTP/1.1 503 Service Unavailable` with body `{"status":"error","database":"down"}`. Crucially, `pnpm dev` must have stayed up long enough to serve that response — check `/tmp/health-db-down.log` contains `Server listening at http://127.0.0.1:3000` (proving the process didn't refuse to boot without the database).

- [ ] **Step 6: Clean up temp files**

```bash
rm -f /tmp/health-db-up.log /tmp/health-db-down.log /tmp/env-missing.log /tmp/env-present.log /tmp/health-db-env-backup
```

- [ ] **Step 7: Commit**

```bash
git add src/infra/http/endpoints/health.ts src/main/http.ts
git commit -m "$(cat <<'EOF'
feat: /health reports database connectivity

GET /health now runs a lightweight query against Postgres. Returns
200 when reachable, 503 otherwise, so an orchestrator can use it to
pull an unhealthy instance out of rotation. The server still boots
without a live database — only /health reflects the outage.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Document the database in the root `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md` (repo root)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the stack line**

Current (line 9):

```
**Stack hoje:** Node 24 LTS (Krypton) · TypeScript 7 ESM · Fastify 5 · Zod 4 · Biome · pnpm
```

New:

```
**Stack hoje:** Node 24 LTS (Krypton) · TypeScript 7 ESM · Fastify 5 · Zod 4 · PostgreSQL · Drizzle · Biome · pnpm
```

- [ ] **Step 2: Update the tree in §2**

Current (lines 27-34):

```text
src/
├── infra/                  # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts       # ÚNICO lugar que lê process.env
│   └── http/server.ts      # instância Fastify, SEM rotas
└── main/
    └── http.ts             # entrypoint: valida env, sobe o servidor
```

New:

```text
src/
├── infra/                  # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts       # ÚNICO lugar que lê process.env
│   ├── database/client.ts  # pool pg + instância Drizzle
│   └── http/
│       ├── server.ts       # instância Fastify, SEM rotas
│       └── endpoints/
│           └── health.ts   # GET /health — liveness + conexão com o banco
└── main/
    └── http.ts             # entrypoint: valida env, abre o banco, sobe o servidor
```

- [ ] **Step 3: Fix the two other lines that reference "banco" as not-yet-built**

Line 4 currently says the doc is verifiable "rodando os comandos da §6" — after
this task, Comandos becomes §7 (Step 5 below renumbers it), so this line must
follow. Current:

```
se está escrito, está construído e verificável rodando os comandos da §6.
```

New:

```
se está escrito, está construído e verificável rodando os comandos da §7.
```

Lines 36-39 currently list the database connection as a future addition to
`src/infra/`. Current:

```
`src/infra/` é infra **sem dono** — o servidor, a config, futuramente o logger e a
conexão do banco. Quando existirem módulos, `src/modules/<m>/infra/` será a infra
**daquele domínio**. Se você não consegue dizer de qual módulo uma peça é, ela é
global.
```

New (the connection now exists; the logger note is untouched — out of scope
for this task):

```
`src/infra/` é infra **sem dono** — o servidor, a config e a conexão do banco.
Futuramente, o logger. Quando existirem módulos, `src/modules/<m>/infra/` será a
infra **daquele domínio**. Se você não consegue dizer de qual módulo uma peça é,
ela é global.
```

- [ ] **Step 4: Insert a new "Banco de dados" section after §5**

Current §5 ends right before this line (line 158):

```
---

## 6. Comandos
```

Replace that with a new §6 inserted before the renumbered "Comandos", and bump every following section number by one (§6→§7, §7→§8, §8→§9, §9→§10):

```
---

## 6. Banco de dados

**PostgreSQL**, acessado via `pg` (driver `node-postgres`) e Drizzle. A conexão
mora em `src/infra/database/client.ts`, infra global — ainda não há módulo
dono de tabela nenhuma.

```ts
// src/infra/database/client.ts
export type Database = NodePgDatabase<Record<string, never>>
                     | PgTransaction<any, any, any>   // o que o callback de transaction recebe
```

`DATABASE_URL` é validada em `env.ts` (§5), sem valor default — o boot falha
se faltar, mesma regra das demais variáveis.

Localmente, o Postgres sobe via `docker-compose.yml` (`postgres:18.4-alpine3.24`),
infra apenas — a aplicação roda no host:

```bash
docker compose up -d    # sobe só o Postgres
pnpm dev                # aplicação, no host
```

`drizzle.config.ts` (raiz) já está pronto para gerar e aplicar migrations, mas
seu glob de schema (`src/modules/*/infra/drizzle/schema.ts`) não casa com nada
até o primeiro módulo existir — não há migration real neste repositório ainda.

`GET /health` consulta o banco (`select 1`) a cada chamada: responde `200` com
o banco no ar, `503` com o banco fora. Sem preflight no boot — o processo sobe
mesmo com o banco inatingível, para que `/health` consiga reportar a falha em
vez do processo crash-loopar.

---

## 7. Comandos
```

- [ ] **Step 5: Update the (renumbered) §7 Comandos block**

Current (right after the heading, was §6):

````
```bash
pnpm dev        # tsx + watch, resolve # para src/
pnpm build      # tsc -> dist/
pnpm start      # node dist/main/http.js, resolve # para dist/
pnpm typecheck  # tsc --noEmit
pnpm lint       # biome check  (formatação + lint + ordem de imports)
pnpm lint:fix   # biome check --write
```

O servidor sobe sem nenhuma rota: `GET /` responde **404**, e isso é o esperado.
````

New:

````
```bash
pnpm dev          # tsx + watch, resolve # para src/
pnpm build        # tsc -> dist/
pnpm start        # node dist/main/http.js, resolve # para dist/
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check  (formatação + lint + ordem de imports)
pnpm lint:fix     # biome check --write
pnpm db:generate  # drizzle-kit generate — gera migration a partir do schema dos módulos
pnpm db:migrate   # drizzle-kit migrate — aplica migrations pendentes
```

O servidor sobe com uma única rota, `GET /health` (§6). Qualquer outro caminho
responde **404**, e isso é o esperado.
````

(This also fixes a doc/code mismatch that predates this task: the old text said the server had *no* routes, which stopped being true when `/health` was added earlier.)

- [ ] **Step 6: Update the (renumbered) §10 "O que ainda não existe"**

Current:

```
módulos e camada pura · regra de fronteira no lint · error handler e taxonomia de
erro · `traceId` por `AsyncLocalStorage` · testes · banco e migrations · rotas,
validação de schema e OpenAPI · Docker · CI
```

New (the connection now exists and is verifiable; real migrations still don't, since no module owns a schema yet):

```
módulos e camada pura · regra de fronteira no lint · error handler e taxonomia de
erro · `traceId` por `AsyncLocalStorage` · testes · migrations · rotas,
validação de schema e OpenAPI · Docker · CI
```

- [ ] **Step 7: Re-read the file top to bottom and confirm section numbers are sequential 1–10 with no gaps or duplicates, and that both fixes from Step 3 (the §6/§7 cross-reference and the "futuramente" wording) landed correctly.**

- [ ] **Step 8: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs: document the database connection in ARCHITECTURE.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** §2 (Postgres version) → Task 2 Step 1 + Task 6 Step 1. §3 (`DATABASE_URL`) → Task 3. §4 (Docker Compose) → Task 2. §5 (client.ts) → Task 4 Step 1. §6 (drizzle.config.ts) → Task 4 Step 2. §7 (`/health`) → Task 5. §8 (dependencies) → Task 1. §9 (docs) → Task 6. §10 (testing) → manual verification steps embedded in Tasks 3, 4, 5 (no test runner exists).
- **Placeholder scan:** no TBD/TODO; every step has literal file content or an exact command with an exact expected output.
- **Type consistency:** `Database` and `createDatabase` (Task 4) are used with the same names and shapes in Task 5's `main/http.ts` and `health.ts`. `Env['DATABASE_URL']` (Task 3) is the only field Task 4's `createDatabase` reads from `Env`.
