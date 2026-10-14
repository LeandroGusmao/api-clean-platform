# Architecture

How the code in this repository is organized, and the rules that apply to every
new file. Everything here is built; nothing is a plan.

The reason behind each piece lives in the comment on the code it governs. This
document gives the map and the rules; the detail of each `auth` flow is in
[`src/modules/auth/README.md`](src/modules/auth/README.md), and what each derived
product still has to decide is in
[`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md).

**Stack:** Node 24 LTS · TypeScript 7 ESM · Fastify 5 · Zod 4 · PostgreSQL ·
Drizzle · Redis · OpenAPI · Vitest · Biome · pnpm

---

## Table of contents

1. [The principle](#1-the-principle)
2. [The tree and the boundary](#2-the-tree-and-the-boundary)
3. [Imports](#3-imports)
4. [Machine-verified rules](#4-machine-verified-rules)
5. [Configuration and logging](#5-configuration-and-logging)
6. [Database](#6-database)
7. [HTTP and API documentation](#7-http-and-api-documentation)
8. [Errors](#8-errors)
9. [Tests](#9-tests)
10. [Commands](#10-commands)
11. [Versions](#11-versions)
12. [Flow of a request](#12-flow-of-a-request)
13. [How to add a new module](#13-how-to-add-a-new-module)
14. [What does not exist yet](#14-what-does-not-exist-yet)

---

## 1. The principle

> **Pure code never depends on code that touches the outside world.**

"The outside world" is the database, HTTP, the network, files, environment
variables, the clock and randomness. All of it comes in through a contract (an
interface in the pure layer) and is implemented in `infra/`. That is what keeps
entities, value objects and use cases testable in milliseconds, with no database
— and it is the principle that decides where each new file lands.

---

## 2. The tree and the boundary

```text
src/
├── shared/                  # PURE and cross-cutting — knows no module
│   ├── errors/              # error taxonomy (§8)
│   └── ports/               # cross-cutting contracts: IClock, IIdGenerator, IUnitOfWork
├── infra/                   # GLOBAL infra, owned by no module
│   ├── config/env.ts        # the ONLY place that reads process.env
│   ├── database/            # pool, transaction, unit of work, driver error conversion
│   ├── redis/               # Redis client
│   ├── health/checks/       # one file per dependency checked by /health
│   ├── http/                # Fastify instance (no routes), guard, rate limit, CORS, OpenAPI
│   │   └── errors/          # the ONLY place that translates an error into an HTTP status
│   ├── observability/       # logger, redaction, traceId
│   └── providers/           # adapters for the shared/ports/ contracts
├── modules/
│   └── <module>/            # today only `auth`
│       ├── entities/  value-objects/  services/  use-cases/  errors/  notifications/
│       ├── repositories/  ports/        # contracts ONLY
│       ├── config.ts                    # Zod schema of the module's env vars
│       ├── container.ts                 # assembles the module's concrete graph
│       └── infra/                       # everything in the module that touches the outside world
│           ├── drizzle/                 # schema/ (one file per table), mappers, repositories
│           ├── in-memory/               # repository doubles for tests
│           ├── providers/               # adapters for the ports/ contracts
│           ├── seeds/                   # `pnpm db:seed` scenarios
│           └── http/                    # endpoints/ (1 file = schema + handler + route), routes.ts
└── main/                    # composition root: the only one that knows every module
    ├── container.ts         # joins the module containers
    ├── app.ts               # composes the HTTP application, WITHOUT listening
    ├── http.ts  cron.ts     # entrypoints
    ├── seeds/               # entrypoint of `pnpm db:seed`
    └── reset/               # entrypoint of `pnpm db:reset`: drops, migrates, seeds

tests/integration/           # suites against a real Postgres and Redis
tools/boundaries/            # the boundary lint and its fixtures
drizzle/                     # generated, committed migrations
```

If you cannot say which module a piece belongs to, it is global
(`src/infra/` or `src/shared/`).

### The boundary rule

§1 applied by file path. This is the table the lint configures
(`tools/boundaries/layers.mjs`).

| Element | Pattern | May import |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,ports,use-cases,services,dtos,errors,notifications}/**` · `src/modules/*/config.ts` · `src/shared/**` | only `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · the `module-infra` **of its own module** |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | everything |
| `test` | `**/*.spec.ts` · `tests/**` · `**/fixtures/**` · `**/in-memory/**` | everything |

- **`composition` and `test` are deliberate exceptions.** The composition root
  exists to know the concrete; a test needs to reach the in-memory double.
- **`fixtures/` and `in-memory/` are `test` by folder name**, even though they
  live under `src/`. They are doubles — and stay out of the build for the same
  reason.
- **The order of the table is the precedence:** a file lands in the first element
  that matches, testing `test`, `composition`, `module-infra`, `pure` and
  `global-infra` in that order — a `.spec.ts` inside `use-cases/` is `test`, not
  `pure`.
- **Every file in `src/` lands in some element.** A new folder that no row
  classifies fails the lint; add the row before creating the folder.

**Who may import a `container.ts`:**

| Who | What | How |
|---|---|---|
| `src/main/**` | any module's `container.ts` | value |
| `src/modules/<m>/infra/**` | the **module's own** `container.ts` | **`import type` only** |
| anyone else | — | forbidden |

### A module does not import a module

No element of a module reaches another module — neither its `infra/` nor its pure
layer. The rule forbids the **import**, not the call: as between microservices,
the consumer holds a contract it defines itself. Three ways to cross, in order of
coupling:

1. **A repository port in the consumer** *(the most common)* — the calling module
   declares in its pure layer the narrow read port it needs; the adapter in
   `src/main/` delegates to the target module's repository.
2. **A use case port in the consumer** — when the crossing has a side effect or a
   rule from the other module (reserve stock, apply a coupon), the port describes
   the operation and the adapter runs the target's use case.
3. **A domain event** — through the transactional outbox, for full decoupling.

In all three cases the port belongs to the **consumer**, and the contract is
written in plain types (`string`, `Date`) — never in the other module's value
objects.

**Forbidden:** an internal HTTP call to the server itself, reusing another
module's HTTP handler, and importing another module's `infra/`.

### What lives in each pure folder

- **`use-cases/`** — orchestrates one use case. The input and output DTOs live in
  the use case's own file; `dtos/` only appears when a DTO is shared.
- **`services/`** — a domain operation that needs collaborators and does not
  belong to a single entity (e.g. `RefreshTokenIssuer`, used by login and by
  rotation). A `services/` that starts receiving a repository has become a use
  case.
- **`repositories/` and `ports/`** — interfaces only. A contract is born with the
  methods and fields that have a consumer, nothing more.
- **A command returns a receipt, a query returns a read model.** A use case that
  changes state returns the minimum (`{ id }`); a query returns a plain object,
  with value objects unwrapped and dates still as `Date`.

### Unit of Work: two rules the lint cannot reach

- **Inside the `uow` callback, every write comes from the `repos` it receives.**
  A repository injected directly writes in autocommit and would break atomicity
  only in production. A direct read is allowed, and the direct repository is
  declared with `Pick`, with only the methods the use case calls.
- **Three things stay out of the callback,** because the transaction is open for
  its entire duration: external I/O (persist inside, send after the commit),
  heavy CPU (argon2 — compute it beforehand) and a write that has to survive a
  failure (e.g. an attempt counter).

### Composition: each module has its container, `main/` joins them

Dependency injection is a **typed manual container** — no library, no decorator.

```ts
// modules/auth/container.ts — the module knows its own concrete
export function makeAuthContainer(db: Database, config: AuthContainerConfig, /* ... */) {
  const usersRepository = new DrizzleUsersRepository(db)
  // ...
  return {
    registerUser: new RegisterUserUseCase(usersRepository, hashProvider, clock, idGenerator),
    getUserProfile: new GetUserProfileUseCase(usersRepository),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>

// main/container.ts — the composition root joins the modules
export function makeContainer(db: Database, env: Env, logger: AppLogger) {
  return { auth: makeAuthContainer(db, env /* ... */) }
}
```

- **Each module receives only the slice of config it declares**, and the module's
  HTTP plugin receives only its slice of the container. Reaching another module's
  use case is a compile error.
- **The graph is assembled without Fastify**, to serve `http.ts`, `cron.ts` and a
  future worker equally.
- **A stateless object is a singleton** in the container.

Three cuts of responsibility:

| File | Does | Does not |
|---|---|---|
| `infra/http/server.ts` | creates and configures the Fastify instance, error handler and traceId | register routes |
| `main/app.ts` | assembles the database, Redis, container, docs and routes; closes everything in `onClose` | open a port |
| `main/http.ts` | `listen` and shutdown signals | assemble the graph |

That way a test assembles exactly the production application without opening a
port, and `app.close()` is the only teardown.

---

## 3. Imports

There is no path alias: the project uses **Node subpath imports**, declared in the
`imports` field of `package.json` and resolved by the runtime itself.

```jsonc
"#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" }
// likewise for #shared/*, #infra/* and #main/*
```

**Rules:**

- **Across top-level directories:** `#infra/...`, `#modules/...`, `#shared/...`,
  `#main/...`.
- **Within the same branch** (same folder or a subfolder): relative **with the
  `.js` extension** — `./schema/users.js`. ESM `nodenext` requires the extension.
- **Never climb with `..`**: `#modules/auth/errors/x`, not `../errors/x`.
- **Exception:** `vitest.config.ts` imports `./tests/...` by relative path — a
  Vite config file does not go through Node's resolver.

> ⚠️ **Without `--conditions=development` and with `dist/` present, the process
> runs stale compiled code while you edit `src/`**, with no warning. The `dev`
> script already carries the flag.

In `tsconfig`, `customConditions: ["development"]` (otherwise every `#` import
gives `TS2307`) and, only in `tsconfig.build.json`, `rootDir: "src"` /
`outDir: "dist"` (otherwise the output becomes `dist/src/...` and `imports` points
at nothing).

---

## 4. Machine-verified rules

A rule that no machine verifies does not survive N derived projects. These fail
`pnpm lint`:

| Rule | Mechanism |
|---|---|
| **R6** — only `src/infra/config/env.ts` reads `process.env` | Biome `style/noProcessEnv` |
| **Boundary** — the §2 table | `dependency-cruiser` + `tools/boundaries/check.mjs` |

These still depend on review:

| Rule | Status |
|---|---|
| **R7** — the pure layer produces no non-deterministic value (`new Date()`, `Math.random()`, `randomUUID()`); time and id come in through `IClock` and `IIdGenerator` | human review — the next one that deserves teeth |
| **R1** — the repository uses only Drizzle's core API, never `db.query.*` | human review |
| **R2** — every column explicitly named | covered in practice by the schema test |
| **R4** — forward-only migrations | convention + review |

The `architecture-audit` skill (`audit-scan.mjs`) is the review net: it flags, line
by line, what the table allows but deserves a look. `dependency-cruiser` is the
gate.

### Do not turn the boundary off without noticing

`dependency-cruiser` enforces **zero with exit 0** if any of these three leaves
`.dependency-cruiser.mjs` / `pnpm-workspace.yaml`:

1. **`tsPreCompilationDeps: true`** — without it, `import type` is invisible, and
   almost every dependency between layers is an interface.
2. **`conditionNames` with `development`** — without it, `#` resolves to `dist/`
   and the rules stop matching.
3. **A nested TypeScript `<7`** — `dependency-cruiser` does not speak TS 7; the
   `packageExtensions` in `pnpm-workspace.yaml` gives it a TypeScript 6 of its
   own.

`check.mjs` guards all three: it checks the resolved TypeScript version, compares
the crossed modules with the `.ts` files on disk and fails on a file with no
element. Changed a rule? Update the fixtures in `tools/boundaries/fixtures/` —
each negative asserts **which** rule fired.

### Do / don't

| ✅ | ❌ |
|---|---|
| Config arrives injected: `buildServer(env)` | `process.env.X` outside `env.ts` |
| A numeric env with `.int().positive()` | A bare `z.coerce.number()` — `PORT=` silently becomes `0` |
| Register routes in `main/app.ts` | Register routes in `server.ts` |
| `import '#infra/http/server'` | `import '../../infra/http/server.js'` |
| Log a chosen field | Log a whole request, entity or driver error object |
| A port in the consumer + an adapter in `main/` | One module importing another |
| A dependency at an exact version | `^` or `~` |

---

## 5. Configuration and logging

- **`env.ts` validates everything at boot and kills the process** with the list of
  invalid fields. An invalid env does not become a bug three hours later.
- **Each module declares the Zod schema of its env vars** in `config.ts`, and the
  schema is registered in the `env.ts` merge. Since only `env.ts` reads
  `process.env` (R6), forgetting the registration is a compile error, not
  `undefined` in production.
- **A blank numeric env fails at boot** instead of becoming `0` through coercion.

**Logging.** A single pino, created by `createLogger` in
`infra/observability/logger.ts` and shared by every entrypoint and by Fastify.
Rules:

- **Never log a whole object** — request, entity or raw error. `redact` covers
  password, token and authentication headers, but it is a safety net, not a
  guarantee: it is not recursive.
- **Every request log carries a `traceId`** — one UUID per request, the same one
  that comes back in the error body (§8). It lives in an `AsyncLocalStorage`
  (`request-context.ts`), so nothing has to pass it along as a parameter.
- In development the log goes through `pino-pretty`; in production, JSON.

---

## 6. Database

**PostgreSQL** through `pg` and Drizzle. The connection lives in
`src/infra/database/client.ts`, shared by all modules.

### Pool

```text
instances × DATABASE_POOL_MAX  ≤  max_connections − reserve
```

Raising the pool is the wrong lever with several replicas: the cost multiplies,
and each connection is a process in Postgres. Past the ceiling, the way out is a
**pooler in transaction mode** (PgBouncer, RDS Proxy) in front.

- **Do not use `.prepare()`.** Drizzle sends anonymous prepared statements, which
  survive the pooler; a named statement breaks that compatibility far from the
  cause.
- The pool and timeouts come from `DATABASE_POOL_MAX` and `DATABASE_*_TIMEOUT_MS`,
  with defaults in `env.ts`. **`0` on a timeout does not disable it** — it lets the
  server's own value apply.

### Migrations

```bash
pnpm db:generate --name=create_users_table   # ALWAYS with --name
```

- **Forward-only (R4).** A committed migration is immutable; fix it with a new
  one.
- **Never rename an applied migration.** The migrator compares by **folder
  name**: renaming it makes it run again.
- `drizzle/` stays outside Biome — it is tool output.
- **The current baseline was regenerated once, on 2026-09-22.** The previous
  history had eleven migrations, three of which only altered an already-created
  table — and `ALTER TABLE ADD COLUMN` appends the column at the end, so the
  physical order stopped saying what the table means. Since the boilerplate had
  never run outside a local machine, the eleven were replaced by eight, one per
  table, with each column in the position it occupies in the schema. R4 holds from
  this baseline on: whoever needs a change generates the next migration.
  **A local database created before it does not accept the new ones** — the
  migrator tries to recreate a table that already exists. Recreate it:
  `pnpm db:reset` for the development one, `docker compose restart postgres-test`
  for the test one, which is `tmpfs`.

### Repository rules

- **A driver error does not leave `infra/`.** A repository never rethrows the
  driver's error: the `message` of `DrizzleQueryError` carries every bound
  parameter, including the password hash. Convert it with `toPersistenceError`
  (`infra/database/driver-error.ts`), which copies only an allowlist of fields and
  keeps no `cause`.

  ```ts
  } catch (error) {
    if (isEmailAlreadyInUse(error)) throw new EmailAlreadyInUseError()
    throw toPersistenceError(error)   // never `throw error`
  }
  ```

- **A uniqueness violation matches the constraint name**, not only the `23505`
  code — otherwise a primary key collision becomes a domain error. The index name
  is a constant exported from the schema file.
- **Time is always `timestamptz`**, never `timestamp` without a time zone. JS's
  `Date` truncates microseconds to milliseconds on read — beware of an exact
  comparison between a database value and an `IClock` one.
- **`updated_at` is always sent, explicitly.** Omitting the column lets
  `$onUpdate` use the system clock instead of the `IClock`.

### Table ownership

Each module declares its own tables in `infra/drizzle/schema/`, **one file per
table, named after the table**. Foreign keys only between tables **of the same
module**; across modules, reference by id with no constraint. Everything lives in
the `public` schema.

### Local

`pnpm db:up` starts, through `docker-compose.yml`, the dev Postgres (5432,
persistent volume), the test one (5433, `tmpfs`), Redis and Mailpit. The
application runs on the host. The integration suite applies the committed
migrations by itself, in `globalSetup`.

---

## 7. HTTP and API documentation

- **An endpoint is a file**: Zod schemas, handler and route together, in
  `infra/http/endpoints/`. The schemas validate **and** generate the OpenAPI.
- **The handler is a translator.** It validates, calls the use case, picks the
  status. A business-rule `if` in it is in the wrong place, and it has no
  `try/catch`.
- **`/docs` and `/docs/json` only exist under `NODE_ENV=development`.** Outside it
  they answer 404. `registerOpenApi` runs before the routes, otherwise they vanish
  from the spec.
- A protected endpoint references `security: [{ bearerAuth: [] }]`, declared once
  in `openapi.ts`.

### Every endpoint declares every status it produces itself

```ts
response: {
  [CREATED_STATUS]: createdSchema,
  [BAD_REQUEST_STATUS]: errorResponseSchema,   // Zod validation
  [CONFLICT_STATUS]: errorResponseSchema,      // EmailAlreadyInUseError
},
```

The OpenAPI is the contract the client generates code from. Declare what that
route's handler and schema can generate — including `503` on a route that opens a
transaction. Do **not** declare what the framework produces on any route (`500`,
`415`).

- A status not declared in the schema is a **compile error** in the handler.
- The response schema **validates** the body: a shape that does not match becomes
  a `500`.
- `204` is `z.null()` in the schema and `.send(null)` in the handler.

### A date in a response: `z.date()`, not `z.iso.datetime()`

The handler hands over the `Date` and the serializer emits ISO. That way the use
case returns the shape the contract publishes, with no `.toISOString()` in the
handler. Formatting is the transport's job, not the pure layer's.

### Health

`GET /health` aggregates the checks in `infra/health/checks/`, one file per
dependency. Only the database decides the status (`200` / `503`); Redis is
reported without taking the probe down. The process starts even with the database
down, so that `/health` can report the failure.

The database check has a deadline **on the client**
(`DATABASE_HEALTH_CHECK_TIMEOUT_MS`): the pool's timeouts are enforced by the
server, and a server that stopped answering enforces none. A query that blows the
deadline discards the connection instead of returning it to the pool.

---

## 8. Errors

Every failure answers in the **same envelope**:

```jsonc
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found", "traceId": "6eedbea3-…" } }
```

**`code` is a contract** — stable, usable as an i18n key. **`message` is not** —
it is for logs and must never be shown raw to the user.

### The taxonomy

`src/shared/errors/app-error.ts` is pure and does not mention HTTP: seven sibling
categories, all extending `AppError` directly. Each domain error extends one of
them and **declares** its `code` (never derived from the class name).

`infra/http/errors/error-handler.ts` is the **only** place that translates an
error into a status. The use case only `throw`s.

| category | status |
|---|---|
| `ValidationError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `BusinessRuleError` | 422 |
| `TransientError` | 503 + `Retry-After` |

An error with `securityEvent = true` (e.g. `RefreshTokenReusedError`) answers the
same, but also produces a `warn` in the log.

### What does not come from the taxonomy

| origin | response |
|---|---|
| Fastify/Zod validation | 400 `VALIDATION_ERROR` + `details[]` per field |
| Fastify's own 4xx (413, 415…) | status preserved, `code` `BAD_REQUEST` |
| nonexistent route | 404 `ROUTE_NOT_FOUND` |
| rate limit | 429 `TOO_MANY_REQUESTS` + the limiter's `Retry-After` |
| anything else | 500 `INTERNAL_SERVER_ERROR`, generic body, detail only in the log |

The `code` of each `details[]` item is the Zod issue code in upper case
(`TOO_SMALL`, `INVALID_FORMAT`…); the ones that only reveal how the schema was
composed collapse into `INVALID_VALUE`.

The error handler, the not-found handler and the `traceId` hook are registered in
`buildServer`, so every server assembled in a test already inherits the contract.

---

## 9. Tests

**Vitest**, split by *project*:

| project | where | needs a database | command |
|---|---|---|---|
| `unit` | `src/**/*.spec.ts`, next to the code | no | `pnpm test:unit` |
| `integration` | `tests/integration/**/*.spec.ts` | yes | `pnpm test:integration` |

- **A use case is tested against the in-memory repository**, with no real infra.
- **No test reads `process.env`.** The suite env comes from `test.env` in
  `vitest.config.ts`, and R6 holds without exception.
- **Integration runs one file at a time** and shares the same Postgres. Each spec
  cleans its own tables in **`beforeEach`** — never assume an empty database.
- **The outside world comes in through injection in tests too**: `parseEnv(source)`
  separates validation from `process.exit`, and `buildServer(env, { logStream })`
  receives the log destination.

---

## 10. Commands

```bash
pnpm dev               # watch, resolves # to src/
pnpm build             # tsc -> dist/ (without the specs)
pnpm start             # node dist/main/http.js
pnpm typecheck         # tsc --noEmit — the authority, above the editor
pnpm lint              # biome + boundary (§4)
pnpm lint:fix          # biome check --write
pnpm test              # unit + integration
pnpm test:unit         # no I/O
pnpm test:integration  # real Postgres and Redis (pnpm db:up first)
pnpm test:watch
pnpm db:up             # start postgres, postgres-test, redis and mailpit
pnpm db:down           # stop them; the dev volume survives
pnpm db:logs           # dev postgres logs
pnpm db:generate --name=<name>   # generate a migration — ALWAYS with --name
pnpm db:migrate        # apply pending migrations
pnpm db:studio         # drizzle-kit studio
pnpm db:seed           # known state in the LOCAL database (--list, --all, auth, auth:<scenario>)
pnpm db:reset          # drop the schema, reapply ALL migrations and run the default seed
```

---

## 11. Versions

- **Every dependency at an exact version. No `^`, no `~`.** Two apps generated
  from the same commit must resolve the same tree. `savePrefix: ''` makes every
  `pnpm add` save an exact version; upgrading is a deliberate commit that goes
  through the suite.
- **Node** is guaranteed by `engines` + `engineStrict: true` (`pnpm install`
  refuses a wrong version); `.nvmrc` is a convenience. `@types/node` follows the
  major of the Node in use, not npm's `latest`.
- **TypeScript 7** at the root; `dependency-cruiser` gets a TypeScript 6 of its own
  through `packageExtensions` in `pnpm-workspace.yaml` (§4). If the editor
  disagrees with `pnpm typecheck`, the editor is wrong.
- **Biome** in place of ESLint + Prettier.
- `pnpm-workspace.yaml` holds pnpm's settings; without `packages:`, this remains a
  single package, not a monorepo.
- **No stable release of the boilerplate until Drizzle is GA** — it is pinned to a
  release candidate. R1, R2 and R4 reduce what a Drizzle change can break.

---

## 12. Flow of a request

`POST /auth/login`, file by file:

```text
1. main/http.ts → main/app.ts
   Validates the env, opens the database and Redis, assembles the container and
   registers each module with its prefix and ITS SLICE of the container.

2. modules/auth/infra/http/routes.ts
   Aggregates the module's endpoints.

3. modules/auth/infra/http/endpoints/login.ts
   Validates the body against the Zod schema, calls the use case, translates the
   return into an HTTP response. No business rule.

4. modules/auth/use-cases/login-user.ts
   Looks up the user, compares the hash (ALWAYS — against a dummyHash when the
   account does not exist, so the response time does not reveal which e-mails
   exist), signs the access token and issues the refresh token inside uow.run.
   Knows neither HTTP nor Drizzle, does not log, does not call new Date().

5. modules/auth/infra/drizzle/drizzle-users-repository.ts
   Runs the SQL and converts the row into an entity.

   If 3, 4 or 5 throw:
6. infra/http/errors/error-handler.ts
   Maps it to a status and builds the envelope with the traceId.
```

---

## 13. How to add a new module

**First, read [`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md)** — a module
that stores sensitive data reopens decisions that `auth` left open.

The order forces the domain to be designed before the infrastructure:

1. `mkdir src/modules/<module>` with the §2 anatomy — only the folders you will
   use.
2. **Domain:** entities and value objects, without thinking about the database or
   HTTP.
3. **Contracts:** `repositories/` and `ports/` with what the domain needs from the
   outside world.
4. **Use cases by TDD**, against the in-memory repository.
5. **Infra:** Drizzle schema, mapper, concrete repository,
   `pnpm db:generate --name=...`. The use case tests do not change.
6. **HTTP:** `infra/http/endpoints/` and `routes.ts`.
7. **`config.ts`**, if there are env vars of its own, registered in the merge in
   `infra/config/env.ts`.
8. **`container.ts`**, and register the slice in `main/container.ts` and the routes
   in `main/app.ts`.
9. **`pnpm lint`** — the boundary is verified; if the module needs another one,
   use a port in the consumer (§2).

---

## 14. What does not exist yet

- **A second module.** `auth` is the only one; the communication rules between
  modules (§2) have not yet been exercised by a real case.
- **A `worker.ts` entrypoint.** `cron.ts` exists; a queue worker does not.
- **Teeth for R7** (§4).

What is a product choice — MFA, lockout, RBAC, multi-tenancy, `kid` in the JWT,
encryption at rest — is in
[`docs/PRODUCT-CHOICES.md`](docs/PRODUCT-CHOICES.md).
