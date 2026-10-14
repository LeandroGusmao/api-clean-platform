# Check catalog

What each check in `scripts/audit-scan.mjs` proves, and how to fix the finding.
Reference — read on demand, when an id shows up in the report.

## How a file is classified

The scanner derives the layer from the path, exactly like the boundary table in
`ARCHITECTURE.md` §2. Order matters: `infra/` wins before the pure folders.

| Layer | Pattern | May import |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,ports,use-cases,dtos,errors}/**` · `src/modules/*/config.ts` · `src/shared/**` | only `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · the module's own `module-infra` |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | everything |
| `test` | `**/*.spec.ts` · `tests/**` | everything |
| `unknown` | any other `src/**` | — triggers `LAYER-UNKNOWN` |

> **`ports/` is the contract; `infra/providers/` is the implementation.** Both
> used to be called `providers/` and were indistinguishable in the tree without
> opening both folders — `repositories/` never had the problem because its
> adapter lives in `infra/drizzle/`, named after the technology. Only the
> contract side was renamed: `infra/providers/` stays as it is.

`composition` and `test` are deliberate exceptions: the composition root exists to
know the concrete, and the unit test needs to reach the in-memory repository.
`test` is exempt from **imports**, never from secrets.

---

## Boundary

### `PURE-IO` — CRITICAL
Pure layer importing an IO package (`fastify`, `drizzle-orm`, `pg`, `pino`,
`jose`, `@node-rs/*`, `node:*`, HTTP clients…) or `#infra/*` / `#main/*`.

**Fix:** declare the contract in the module's `ports/` or `repositories/` (or
`#shared/ports/` if it is cross-cutting) and implement the adapter in `infra/`.
The container injects it. That is what makes the use case testable in
milliseconds, with no database.

It applies to `import type` as well: a type imported from infra is still the pure
layer knowing the outside world, and the next `import` in the same file stops
hurting.

### `PURE-XMOD` — CRITICAL (if it reaches the other module's `infra/`) · MEDIUM (otherwise)
The pure layer of one module importing another module. Between modules you
reference by id, with no constraint and no import; integrity stays in the
application (§6).

### `SHARED-XMOD` — CRITICAL
`src/shared/**` importing `#modules/*`. `shared/` is cross-cutting by definition:
if it knows a module, it is no longer shareable and has become a circular
dependency waiting to happen.

### `XMOD-INFRA` — CRITICAL
One module's `infra/` importing another's `infra/`. It is the crossing that the
`module-infra` row of the table exists to prevent.

**Fix:** what is common moves up to `src/infra/**` (ownerless infra); what belongs
to the other module's domain crosses through a contract injected at the
composition root.

### `GLOBAL-INFRA-XMOD` — CRITICAL (module `infra/` or container) · MEDIUM (otherwise)
`src/infra/**` knowing a module. The model is `infra/http/auth-guard.ts`: it
protects routes without importing `#modules/auth` — the verifier arrives injected.

**Exception that does not fire:** `#modules/<m>/config` in `env.ts`. The table
classifies a module's `config.ts` as `pure`, and merging the schemas at boot is
exactly what lets each module declare its own env vars while boot validates them
all at once.

### `XMOD-PURE` — MEDIUM
One module's `infra/` importing the **pure** layer of another. The table allows
it — `module-infra` may import `pure` —, so this is a signal, not a verdict:
confirm whether the coupling between domains is intentional or whether what is
wanted there is a contract of its own. One day that import becomes the path by
which a row from another table crosses the boundary.

### `PURE-CONTAINER` / `XMOD-CONTAINER` / `CONTAINER-VALUE` — HIGH
Who may import a container: `src/main/**` as a **value**, and the module's
**own** `infra/` only as a **type** (`import type`). Nobody else.

`CONTAINER-VALUE` is the subtle case: `import { }` in place of `import type { }`
inside the module itself creates a runtime dependency and opens the way for a
cycle. As an `import type`, it vanishes at compile time.

### `INFRA-MAIN` — CRITICAL
Infra importing `#main/*`. The composition root depends on the layers, never the
other way round.

### `LAYER-UNKNOWN` — MEDIUM
A file in `src/` that falls into no row of the table — for example
`src/modules/auth/helpers.ts`. Either it belongs in one of the named folders, or
the table needs a new row, which is a conscious and documented decision. A file
outside the map is a file whose boundary nobody verifies.

---

## Configuration and determinism

### `ENV` — CRITICAL (R6)
`process.env` outside `src/infra/config/env.ts`.

**Fix:** the module declares the Zod schema of its variables in `config.ts`;
`env.ts` merges them and boot dies listing everything that is invalid. The config
arrives injected and typed — and forgetting the merge becomes a compile error
instead of `undefined` in production.

The only check with teeth in lint today (Biome `style/noProcessEnv`). The scanner
keeps it because the audit also runs in scopes where lint did not.

### `TEST-ENV` — HIGH
A test reading `process.env`. The suite env is injected through `test.env` in
`vitest.config.ts` — which is what lets R6 hold with no exception at all in
`biome.jsonc`.

### `R7-CLOCK` / `R7-RANDOM` — HIGH
`new Date()`, `Date.now()`, `Math.random()`, `randomUUID()`, `randomBytes()`,
`performance.now()`, `process.hrtime` in the pure layer.

**Fix:** `IClock` (`#shared/ports/clock`) for time, `IIdGenerator`
(`#shared/ports/id-generator`) for identity. They are two ports on purpose:
an entity id and a cryptographic secret have different security profiles.

`new Date(value)` **with an argument** does not fire — it is a defensive copy, it
is deterministic, and the repository uses that pattern.

---

## Data leaks

### `DRIVER-RETHROW` — CRITICAL
`catch (error) { … throw error }` in `infra/drizzle/**`.

The `message` of `DrizzleQueryError` is `Failed query: ${query}\nparams: ${params}`
— the text **plus every bound parameter**. In an INSERT into `users`, one of them
is the password hash. The `stack` derives from the `message` and `params` is an
own enumerable property: three carriers of the same secret in the same object.

```diff
- throw error
+ throw toPersistenceError(error)
```

### `CATCH-UNSANITIZED` — HIGH
A `catch` in the Drizzle layer that never calls `toPersistenceError`. Either the
error escapes some other way, or the failure is being swallowed silently.
Translate the expected violation into a domain error and convert the rest.

### `DRIVER-LOG` — CRITICAL
Any `log.*`/`console.*` inside `infra/drizzle/**`. It is where the dangerous
object still exists; logging there is exactly the leak. The central
`error-handler` already records the failure with a `traceId`.

### `DRIVER-RAW` — CRITICAL
Reading/propagating `error.message`, `.stack`, `.params`, `.detail` in the
Drizzle layer. Postgres' `detail` embeds the conflicting value:
`Key (email)=(joao@example.com) already exists.` What survives is an **allowlist**
(`code`, `constraint`, `query` with placeholders), not a denylist.

### `LOG-OBJECT` — HIGH
`log.*({ request })`, `{ body }`, `{ user }`, `{ headers }`… pino's `redact` is
**not recursive** (`*.x` matches exactly one level) and Fastify's default `req`
serializer does not emit headers: the redact list is a safety net, not a
guarantee. Log the chosen field.

### `LOG-ERR-MODULE` — HIGH
An error logged inside `src/modules/*/infra/**`. The central `error-handler`
already logs with a `traceId`; a local log duplicates the line and, when the
object is the driver's, escapes sanitization. `infra/http/**/error-handler.ts` is
the only exemption — it is the place designed for this, with the registered
`error-serializer` behind it.

### `SECRET-HTTP` — CRITICAL
`passwordHash`, `JWT_SECRET`, `SECRET_KEY`, `PRIVATE_KEY` mentioned in the HTTP
layer. Confirm whether it enters a response schema or `send()`; the use case's
read model already delivers the publishable shape (`a command returns a receipt,
a query returns a read model`).

### `OWNERSHIP-UNUSED` — HIGH
A use case whose `execute` receives `userId`/`ownerId`/`tenantId`/`accountId` and
never uses it — the identifier appears exactly once in the file, its own
declaration. The query is by global id: whoever obtains the id of someone else's
resource reaches it. It is the IDOR pattern, and the signature lies by suggesting
ownership is checked.

**Fix:** carry the owner into the query and answer 404, not 403 — confirming that
the resource exists but belongs to someone else is already an existence leak.

```diff
- const notification = await this.repository.findById(id)
- if (notification === null) throw new NotificationNotFoundError()
+ const notification = await this.repository.findByIdAndOwner(id, userId)
+ if (notification === null) throw new NotificationNotFoundError()
```

The check only sees the parameter that is **never** used. Used but absent from
the `where` is what step 3 of the skill catches.

### `CONSOLE` — MEDIUM
`console.*` in module code: no `traceId`, no redact, no level. `env.ts` and
`database/client.ts` are exempt — they run before the logger exists.

---

## HTTP and conventions

### `ZOD-DATE` — MEDIUM
`z.iso.datetime()` in an endpoint. In a **response** schema use `z.date()`: the
`serializerCompiler` accepts the `Date` and emits ISO on its own, and OpenAPI
publishes the same `format: date-time`. With `z.iso.datetime()` every handler has
to call `.toISOString()`, and therefore know the domain's internal types.

In a **request** schema the extra `pattern` has a consumer and the form is
legitimate — hence MEDIUM rather than automatic: read which half of the schema it
is in.

### `HANDLER-CATCH` — MEDIUM
`try/catch` in `infra/http/endpoints/**`. The use case only `throw`s; the
`error-handler` translates it to a status through the seven categories. Catching in
the endpoint is where the error envelope starts to diverge from route to route.

### `HTTP-MAGIC` — MEDIUM
Inline status: `.status(201)`, `.code(404)`, `{ 200: schema }`. Use the constants
in the module's `infra/http/constants.ts` (`CLAUDE.md`, no magic number).

### `IMPORT-PARENT` — HIGH
`from '../…'` in `src/`. Across branches you use a subpath import: a `#` path
stays correct after the file moves, a `../../..` does not. Exempt in `tests/`.

### `IMPORT-EXT` — HIGH
A relative import without `.js`. ESM with `nodenext` requires the extension —
`tsc` fails with `TS2835`. Within the same branch: `./user-mapper.js`,
`./schema/users.js`.

### `IMPORT-DEEP` — HIGH
A specifier pointing at `src/` or `dist/`. `tsc` **does not rewrite**
specifiers: the condition decides the tree (`development` → `src/`,
`default` → `dist/`).

### `DRIZZLE-QUERY-API` — MEDIUM (R1)
`db.query.*` in the repository. The rule is to use only the core API
(`select`/`insert`/`update`/`delete`).

### `DEP-RANGE` — HIGH
`^` or `~` in `package.json`. In a boilerplate copied N times, a caret means two
apps generated from the same commit resolve different trees — and the divergence
shows up as a bug that does not reproduce. `savePrefix: ''` already takes care of
the future; this check catches what was added by hand.

### `MD-LINK` — MEDIUM
A broken relative link in a tracked `.md`. It enters the scope with `--all` (every
`.md` tracked by git) and, in diff scopes, when the file itself changed.

It is the only form of "document that lies" a machine can prove. A folder move
does not touch the link text: it stays green in the diff and dead on reading. A
bare anchor (`#section`), a URL and an absolute path are skipped — the last
depends on a root the script does not know. A link inside a fenced block does not
count.

### `TEST-ONLY` — MEDIUM
A committed `.only` silences the rest of the suite.

---

## Known limitations

The scanner does not replace step 3 of the skill. What it does **not** see:

- **Intent.** `SECRET-HTTP` flags the mention, it does not prove the field goes
  into the response. Read the schema.
- **Undeclared dependency.** Importing a package absent from `package.json`, and
  a table declared without a committed migration: neither is a textual pattern in
  the audited file.
- **Flow across files.** A sensitive value that reaches the log after three hops
  passes: each line, on its own, is innocent.
- **Undeclared status.** Absence does not match a regex — no check proves that an
  endpoint forgot to declare the 409 it produces.
- **A comment that lies.** The scanner strips comments precisely so it does not
  fire on prose; the flip side is that it does not read them either.
- **A multi-line import above 12 lines** and exotic re-exports fall out of the
  extraction.
- **A fixture with a deliberate violation** fires like a real violation — which is
  why the test fixtures live in `.ts.txt`, out of reach of tsc and Biome.
