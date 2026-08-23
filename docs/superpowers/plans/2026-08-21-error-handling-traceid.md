# Error Handling, Taxonomy and traceId Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the project a single, testable error contract — a semantic error taxonomy in the pure layer, one global HTTP handler that owns every status code, and a `traceId` that is identical in the log line and in the error body.

**Architecture:** `src/shared/errors/app-error.ts` is the project's first pure-layer file: six abstract categories that know nothing about HTTP. `src/infra/http/error-handler.ts` is the only place in the system that maps those categories to status codes, and it is registered inside `buildServer` (instance configuration, not a route), so every server — production, unit spec, integration spec — inherits the same contract. `src/infra/observability/request-context.ts` wraps `AsyncLocalStorage` so the `traceId` reaches the handler without being threaded through any signature.

**Tech Stack:** Fastify 5.12.1, Zod 4.4.3, `fastify-type-provider-zod` 7.0.0, Vitest 4.1.11, Node 24.19.0 (`node:async_hooks`, `node:crypto`). **No new dependency is added by this plan.**

**Spec:** `docs/superpowers/specs/2026-08-21-error-handling-traceid-design.md`

## Global Constraints

- **Language:** every identifier, string, log message, error message and code comment is in **English**. Markdown files may be Portuguese (`CLAUDE.md`).
- **No magic strings or numbers.** Every literal — status codes, contract codes, paths, log messages — is a named constant in `UPPER_SNAKE_CASE`, declared close to where it is used (`CLAUDE.md`).
- **No new dependency.** If a step seems to need one, stop: the design was built specifically to avoid it.
- **Imports:** across top-level directories use subpath imports (`#shared/...`, `#infra/...`); inside the same folder use a relative specifier **with the `.js` extension** (`./error-response.js`). ESM with `nodenext` fails with `TS2835` without the extension (`ARCHITECTURE.md` §3).
- **`server.ts` registers no routes.** Hooks, error handler and not-found handler are instance configuration and belong there; routes belong to `main/http.ts`.
- **No test reads `process.env`** (rule R6). The suite's env comes from `test.env` in `vitest.config.ts` and from the `Env` object each spec builds.
- **Every spec in this plan lives in the `unit` project** (`src/**/*.spec.ts`). Nothing here touches Postgres, so nothing goes in `tests/integration/`.
- **Only the root `ARCHITECTURE.md` is edited.** `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/STRUCTURE.md` and `docs/TODO.md` are local reference material (gitignored) and are out of scope.
- **Node version:** every `pnpm`/`node` command must run under Node `24.19.0`. If the active Node differs, prefix with:
  ```bash
  eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
  ```
- **Before every commit:** run `pnpm lint:fix`, then `pnpm typecheck` and `pnpm test` must both be green. Biome enforces formatting and import ordering; a commit with unformatted code will fail `pnpm lint`.

## Contract Codes Produced by This Plan

These strings are **public contract**. Once shipped, changing one requires a coordinated mobile release. They are listed here so no task invents a variant.

| constant | value | where |
|---|---|---|
| `VALIDATION_ERROR_CODE` | `VALIDATION_ERROR` | Task 6 |
| `INTERNAL_SERVER_ERROR_CODE` | `INTERNAL_SERVER_ERROR` | Task 5 |
| `BAD_REQUEST_CODE` | `BAD_REQUEST` | Task 7 |
| `ROUTE_NOT_FOUND_CODE` | `ROUTE_NOT_FOUND` | Task 7 |
| `INVALID_TYPE_CODE` | `INVALID_TYPE` | Task 4 |
| `TOO_SHORT_CODE` | `TOO_SHORT` | Task 4 |
| `TOO_SMALL_CODE` | `TOO_SMALL` | Task 4 |
| `TOO_LONG_CODE` | `TOO_LONG` | Task 4 |
| `TOO_LARGE_CODE` | `TOO_LARGE` | Task 4 |
| `INVALID_FORMAT_CODE` | `INVALID_FORMAT` | Task 4 |
| `NOT_MULTIPLE_OF_CODE` | `NOT_MULTIPLE_OF` | Task 4 |
| `UNRECOGNIZED_KEYS_CODE` | `UNRECOGNIZED_KEYS` | Task 4 |
| `INVALID_VALUE_CODE` | `INVALID_VALUE` | Task 4 |

## File Structure

| file | responsibility |
|---|---|
| `src/shared/errors/app-error.ts` | **Create.** `AppError` + the six abstract categories. Pure: no import, no HTTP. |
| `src/shared/errors/app-error.spec.ts` | **Create.** Pins the prototype chain the handler's `instanceof` depends on. |
| `src/infra/observability/request-context.ts` | **Create.** `AsyncLocalStorage` wrapper — the only place that knows the mechanism. |
| `src/infra/observability/request-context.spec.ts` | **Create.** Isolation between concurrent flows. |
| `src/infra/http/error-response.ts` | **Create.** Zod schema of the error envelope + the contract codes and messages. Single source for handler, OpenAPI and docs. |
| `src/infra/http/validation-issues.ts` | **Create.** Pure translation: Zod issue → contract code and field path. |
| `src/infra/http/validation-issues.spec.ts` | **Create.** The normative table, one case per row. |
| `src/infra/http/error-handler.ts` | **Create.** The only file in the system that knows HTTP status codes. |
| `src/infra/http/error-handler.spec.ts` | **Create.** Every branch, end to end through `app.inject()`. |
| `src/infra/http/server.ts` | **Modify.** `genReqId`, the `onRequest` hook, and the call that registers the handlers. |
| `src/infra/http/server.spec.ts` | **Modify.** Adds the correlation tests; refactors log parsing to handle multi-line output. |
| `ARCHITECTURE.md` | **Modify.** New §8, tree, §5 note, renumbering. |

---

### Task 1: The error taxonomy (pure layer)

This creates `src/shared/`, the project's first pure-layer directory. `#shared/*` is already declared in `package.json` `imports` — do not touch that file.

**Files:**
- Create: `src/shared/errors/app-error.ts`
- Test: `src/shared/errors/app-error.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppError` (abstract, `readonly code: string`), and the abstract categories `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`, `ValidationError`, `BusinessRuleError`. All extend `AppError` **directly** — they are siblings, never a chain. Task 5 relies on that.

- [ ] **Step 1: Write the failing test**

Create `src/shared/errors/app-error.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '#shared/errors/app-error'

const USER_NOT_FOUND_CODE = 'USER_NOT_FOUND'
const USER_NOT_FOUND_MESSAGE = 'User not found'

/** Stands in for a real module error; the taxonomy has no concrete errors of its own. */
class UserNotFoundError extends NotFoundError {
  readonly code = USER_NOT_FOUND_CODE

  constructor() {
    super(USER_NOT_FOUND_MESSAGE)
  }
}

describe('error taxonomy', () => {
  it('keeps the prototype chain intact across two levels of subclassing', () => {
    const error = new UserNotFoundError()

    // This is what `instanceof` in the error handler depends on. Subclassing
    // `Error` silently breaks it when the compile target is ES5, so it is
    // pinned here rather than assumed.
    expect(error).toBeInstanceOf(UserNotFoundError)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
  })

  it('does not match a sibling category', () => {
    const error = new UserNotFoundError()

    // Categories are siblings, never a chain. If one ever extended another,
    // the handler's mapping table would start depending on row order.
    expect(error).not.toBeInstanceOf(UnauthorizedError)
    expect(error).not.toBeInstanceOf(ConflictError)
  })

  it('carries the contract code and the human-readable message', () => {
    const error = new UserNotFoundError()

    expect(error.code).toBe(USER_NOT_FOUND_CODE)
    expect(error.message).toBe(USER_NOT_FOUND_MESSAGE)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
pnpm exec vitest run --project unit src/shared/errors/app-error.spec.ts
```

Expected: FAIL — the module `#shared/errors/app-error` cannot be resolved (the file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/shared/errors/app-error.ts`:

```ts
/**
 * Semantic error taxonomy — the PURE layer.
 *
 * Nothing here knows what HTTP is. "Not found" and "conflict" are application
 * concepts that mean the same in a worker or a cron, where a status code would
 * be meaningless. The translation to HTTP lives in exactly one place:
 * `src/infra/http/error-handler.ts`.
 *
 * `code` is public contract: the mobile client branches on it and uses it as an
 * i18n key. `message` is not contract — it is for logs, debugging and clients
 * without translations, and must never be shown raw in a localized UI.
 */
export abstract class AppError extends Error {
  abstract readonly code: string
}

export abstract class NotFoundError extends AppError {}
export abstract class ConflictError extends AppError {}
export abstract class UnauthorizedError extends AppError {}
export abstract class ForbiddenError extends AppError {}
export abstract class ValidationError extends AppError {}
export abstract class BusinessRuleError extends AppError {}
```

Do **not** add `statusCode`, `name`, `cause`, timestamps or a `details` field. The spec rejects each of them; nothing enters this file without a test that demands it.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run --project unit src/shared/errors/app-error.spec.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Verify the whole suite and the typecheck**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: lint clean, typecheck clean, all tests green (8 pre-existing + 3 new = 11).

- [ ] **Step 6: Commit**

```bash
git add src/shared/errors/app-error.ts src/shared/errors/app-error.spec.ts
git commit -m "feat: add semantic error taxonomy in the pure layer"
```

---

### Task 2: Request context (AsyncLocalStorage)

**Files:**
- Create: `src/infra/observability/request-context.ts`
- Test: `src/infra/observability/request-context.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `runWithRequestContext<T>(traceId: string, fn: () => T): T`
  - `getTraceId(): string | undefined`

  Task 3 calls the first from a Fastify hook; Tasks 5 and 7 call the second from the handlers.

- [ ] **Step 1: Write the failing test**

Create `src/infra/observability/request-context.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getTraceId, runWithRequestContext } from '#infra/observability/request-context'

const FIRST_TRACE_ID = 'trace-first'
const SECOND_TRACE_ID = 'trace-second'
const SHORT_DELAY_MS = 5
const LONG_DELAY_MS = 20

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('request context', () => {
  it('reports no traceId outside any context', () => {
    expect(getTraceId()).toBeUndefined()
  })

  it('keeps the traceId readable after an await', async () => {
    const seen = await runWithRequestContext(FIRST_TRACE_ID, async () => {
      await delay(SHORT_DELAY_MS)
      return getTraceId()
    })

    expect(seen).toBe(FIRST_TRACE_ID)
  })

  it('isolates concurrent flows from each other', async () => {
    // The slower flow starts first and finishes last: if the store leaked
    // between flows, this is where it would show.
    const readAfter = (traceId: string, ms: number) =>
      runWithRequestContext(traceId, async () => {
        await delay(ms)
        return getTraceId()
      })

    const [first, second] = await Promise.all([
      readAfter(FIRST_TRACE_ID, LONG_DELAY_MS),
      readAfter(SECOND_TRACE_ID, SHORT_DELAY_MS),
    ])

    expect(first).toBe(FIRST_TRACE_ID)
    expect(second).toBe(SECOND_TRACE_ID)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run --project unit src/infra/observability/request-context.spec.ts
```

Expected: FAIL — `#infra/observability/request-context` cannot be resolved.

- [ ] **Step 3: Write the minimal implementation**

Create `src/infra/observability/request-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  traceId: string
}

/**
 * Ambient per-request context. It exists so the traceId reaches the logger and
 * the error handler without being threaded through every signature — a `ctx`
 * parameter is viral and forgetting to pass it breaks correlation silently.
 *
 * This is the only implicit-context point in the project, and it is deliberately
 * isolated here: migrating to OpenTelemetry later replaces this file alone, with
 * `getTraceId` reading from the active span instead.
 */
const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn)
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run --project unit src/infra/observability/request-context.spec.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 14 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/infra/observability/request-context.ts src/infra/observability/request-context.spec.ts
git commit -m "feat: add per-request context via AsyncLocalStorage"
```

---

### Task 3: Wire the traceId into the server

Replaces Fastify's default `genReqId`, which is a **per-process counter** (`req-1`, `req-2`). With two replicas both emit `req-1`, and a restart resets the counter — grepping a traceId in the log aggregator returns unrelated requests.

**Files:**
- Modify: `src/infra/http/server.ts`
- Test: `src/infra/http/server.spec.ts` (existing file — add to it)

**Interfaces:**
- Consumes: `runWithRequestContext`, `getTraceId` from Task 2.
- Produces: every server built by `buildServer` generates a UUID traceId, logs it under the `traceId` label, and makes it readable via `getTraceId()` anywhere downstream of the `onRequest` hook.

- [ ] **Step 1: Add the log-line parsing helper and the failing tests**

In `src/infra/http/server.spec.ts`, add these imports to the existing import block (Biome will order them on `lint:fix`):

```ts
import type { FastifyInstance } from 'fastify'
import { getTraceId } from '#infra/observability/request-context'
```

Add these constants next to the existing `SECRET_VALUE` / `LOG_MESSAGE`:

```ts
const TRACE_PROBE_PATH = '/trace-probe'
const GET_METHOD = 'GET'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
```

Add this helper below `createLogCollector`:

```ts
/**
 * pino writes one JSON object per line. A single request produces several, so
 * the collected chunks are joined and split rather than parsed whole.
 */
function parseLogLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
```

Then replace the last line of the existing `logAndCapture` — currently `return JSON.parse(lines.join(''))` — with:

```ts
  return parseLogLines(lines)[0]
```

Finally add this new describe block at the end of the file:

```ts
describe('buildServer request correlation', () => {
  async function injectProbe(): Promise<{ body: { traceId?: string }; logged: Array<Record<string, unknown>> }> {
    const { lines, stream } = createLogCollector()
    const app: FastifyInstance = buildServer(testEnv, { logStream: stream })
    close = () => app.close()

    app.get(TRACE_PROBE_PATH, async () => ({ traceId: getTraceId() }))

    const response = await app.inject({ method: GET_METHOD, url: TRACE_PROBE_PATH })

    return { body: response.json(), logged: parseLogLines(lines) }
  }

  it('generates a uuid traceId instead of a per-process counter', async () => {
    const { body } = await injectProbe()

    // `req-1` from two replicas is the same string: the default counter cannot
    // correlate anything beyond a single process.
    expect(body.traceId).toMatch(UUID_PATTERN)
  })

  it('logs the same traceId the request context exposes', async () => {
    const { body, logged } = await injectProbe()

    expect(logged.length).toBeGreaterThan(0)
    expect(logged.every((entry) => entry.traceId === body.traceId)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/infra/http/server.spec.ts
```

Expected: FAIL — both new tests. `body.traceId` is `undefined` (no hook opens the context) and the logged `traceId` is `req-1`.

- [ ] **Step 3: Write the minimal implementation**

In `src/infra/http/server.ts`, add the imports:

```ts
import { randomUUID } from 'node:crypto'
import { runWithRequestContext } from '#infra/observability/request-context'
```

Add `genReqId` as the first option of the `Fastify({ ... })` call, above `logController`:

```ts
    // Fastify's default is a per-process counter (`req-1`): two replicas emit
    // the same id and a restart resets it, so a traceId cannot correlate
    // anything beyond a single process.
    genReqId: () => randomUUID(),
```

Then, after the two `setValidatorCompiler` / `setSerializerCompiler` calls and before `return app`, add:

```ts
  // Opens the ambient context for everything downstream — routes, hooks and the
  // error handler alike. Verified: the store survives an `await` and is still
  // readable inside `setErrorHandler` and `setNotFoundHandler`.
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestContext(request.id, done)
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/infra/http/server.spec.ts
```

Expected: PASS — 5 tests (3 pre-existing redaction tests + 2 new).

- [ ] **Step 5: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 16 tests green, including the two integration tests against Postgres. If the integration project fails to connect, start the databases first with `docker compose up -d`.

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/server.ts src/infra/http/server.spec.ts
git commit -m "feat: correlate requests with a uuid traceId in the ambient context"
```

---

### Task 4: Translate Zod issues into contract codes

A pure function, no Fastify instance involved. The spec's normative table becomes a test table.

The parameter type is Fastify's own `FastifySchemaValidationError`, **not** the library's `ZodFastifySchemaValidationError`. The narrower type is assignable to the wider one, and the wider one keeps this function free of a symbol-branded type that is awkward to construct in a test.

Verified field shapes (Zod 4.4.3, `fastify-type-provider-zod` 7.0.0): `keyword` carries the Zod issue code, `instancePath` is the slash-joined path (`/items/0/email`, or `/` at the root), `params` is `Record<string, unknown>` holding everything else — including `origin`, which is `string`, `array` or `number`.

**Files:**
- Create: `src/infra/http/validation-issues.ts`
- Test: `src/infra/http/validation-issues.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ValidationDetail { field?: string; code: string }`
  - `toValidationDetails(issues: readonly FastifySchemaValidationError[]): ValidationDetail[]`
  - The nine exported code constants listed in **Contract Codes Produced by This Plan**.

  Task 6 calls `toValidationDetails` from the error handler.

- [ ] **Step 1: Write the failing test**

Create `src/infra/http/validation-issues.spec.ts`:

```ts
import type { FastifySchemaValidationError } from 'fastify'
import { describe, expect, it } from 'vitest'
import { toValidationDetails } from '#infra/http/validation-issues'

const STRING_ORIGIN = 'string'
const ARRAY_ORIGIN = 'array'
const NUMBER_ORIGIN = 'number'

const EMAIL_PATH = '/email'
const EMAIL_FIELD = 'email'
const NESTED_PATH = '/items/0/email'
const NESTED_FIELD = 'items.0.email'
const ROOT_PATH = '/'

const PASSWORD_PATH = '/password'
const PASSWORD_FIELD = 'password'

function issue(
  keyword: string,
  instancePath: string,
  params: Record<string, unknown> = {},
): FastifySchemaValidationError {
  return { keyword, instancePath, schemaPath: `#${instancePath}/${keyword}`, params }
}

// The normative table from the design spec, one row per case.
const TRANSLATION_TABLE: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ['invalid_type', {}, 'INVALID_TYPE'],
  ['too_small', { origin: STRING_ORIGIN }, 'TOO_SHORT'],
  ['too_small', { origin: ARRAY_ORIGIN }, 'TOO_SHORT'],
  ['too_small', { origin: NUMBER_ORIGIN }, 'TOO_SMALL'],
  ['too_big', { origin: STRING_ORIGIN }, 'TOO_LONG'],
  ['too_big', { origin: ARRAY_ORIGIN }, 'TOO_LONG'],
  ['too_big', { origin: NUMBER_ORIGIN }, 'TOO_LARGE'],
  ['invalid_format', {}, 'INVALID_FORMAT'],
  ['not_multiple_of', {}, 'NOT_MULTIPLE_OF'],
  ['unrecognized_keys', {}, 'UNRECOGNIZED_KEYS'],
  ['custom', {}, 'INVALID_VALUE'],
  ['a_code_a_future_zod_version_adds', {}, 'INVALID_VALUE'],
]

describe('toValidationDetails', () => {
  it.each(TRANSLATION_TABLE)(
    'translates %s with params %o into %s',
    (keyword, params, expected) => {
      const details = toValidationDetails([issue(keyword, EMAIL_PATH, params)])

      expect(details).toEqual([{ field: EMAIL_FIELD, code: expected }])
    },
  )

  it('flattens a nested path into a dotted field', () => {
    const details = toValidationDetails([issue('invalid_type', NESTED_PATH)])

    expect(details).toEqual([{ field: NESTED_FIELD, code: 'INVALID_TYPE' }])
  })

  it('omits the field when the issue points at the whole body', () => {
    // `unrecognized_keys` arrives with an empty path: the object is wrong, not
    // one of its fields. Verified against Zod 4.4.3.
    const details = toValidationDetails([issue('unrecognized_keys', ROOT_PATH)])

    expect(details).toEqual([{ code: 'UNRECOGNIZED_KEYS' }])
    expect(details[0]).not.toHaveProperty('field')
  })

  it('preserves order across several issues', () => {
    const details = toValidationDetails([
      issue('invalid_format', EMAIL_PATH),
      issue('too_small', PASSWORD_PATH, { origin: STRING_ORIGIN }),
    ])

    expect(details).toEqual([
      { field: EMAIL_FIELD, code: 'INVALID_FORMAT' },
      { field: PASSWORD_FIELD, code: 'TOO_SHORT' },
    ])
  })
})
```

The expected codes are written as literals on purpose: they **are** the public contract. Importing the constants would make the assertions tautological — renaming `TOO_SHORT` to `TOO_BRIEF` would break every mobile client while keeping this suite green. (Same rule already applied in `tests/integration/health.spec.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run --project unit src/infra/http/validation-issues.spec.ts
```

Expected: FAIL — `#infra/http/validation-issues` cannot be resolved.

- [ ] **Step 3: Write the minimal implementation**

Create `src/infra/http/validation-issues.ts`:

```ts
import type { FastifySchemaValidationError } from 'fastify'

/** Issue codes as Zod 4 emits them. */
const ZOD_INVALID_TYPE = 'invalid_type'
const ZOD_TOO_SMALL = 'too_small'
const ZOD_TOO_BIG = 'too_big'
const ZOD_INVALID_FORMAT = 'invalid_format'
const ZOD_NOT_MULTIPLE_OF = 'not_multiple_of'
const ZOD_UNRECOGNIZED_KEYS = 'unrecognized_keys'

/**
 * Codes as the API publishes them. They are NOT the Zod codes: the client
 * branches on these, so they are ours to keep stable across Zod upgrades.
 */
export const INVALID_TYPE_CODE = 'INVALID_TYPE'
export const TOO_SHORT_CODE = 'TOO_SHORT'
export const TOO_SMALL_CODE = 'TOO_SMALL'
export const TOO_LONG_CODE = 'TOO_LONG'
export const TOO_LARGE_CODE = 'TOO_LARGE'
export const INVALID_FORMAT_CODE = 'INVALID_FORMAT'
export const NOT_MULTIPLE_OF_CODE = 'NOT_MULTIPLE_OF'
export const UNRECOGNIZED_KEYS_CODE = 'UNRECOGNIZED_KEYS'
export const INVALID_VALUE_CODE = 'INVALID_VALUE'

const ORIGIN_PARAM = 'origin'
/** Origins whose size is a length, so "too small" reads as "too short". */
const LENGTH_ORIGINS = new Set(['string', 'array', 'set', 'file'])

const PATH_SEPARATOR = '/'
const FIELD_SEPARATOR = '.'

export interface ValidationDetail {
  field?: string
  code: string
}

function toFieldPath(instancePath: string): string {
  return instancePath
    .split(PATH_SEPARATOR)
    .filter((segment) => segment.length > 0)
    .join(FIELD_SEPARATOR)
}

function hasLengthOrigin(params: Record<string, unknown>): boolean {
  const origin = params[ORIGIN_PARAM]
  return typeof origin === 'string' && LENGTH_ORIGINS.has(origin)
}

function toContractCode(issue: FastifySchemaValidationError): string {
  switch (issue.keyword) {
    case ZOD_INVALID_TYPE:
      return INVALID_TYPE_CODE
    case ZOD_TOO_SMALL:
      return hasLengthOrigin(issue.params) ? TOO_SHORT_CODE : TOO_SMALL_CODE
    case ZOD_TOO_BIG:
      return hasLengthOrigin(issue.params) ? TOO_LONG_CODE : TOO_LARGE_CODE
    case ZOD_INVALID_FORMAT:
      return INVALID_FORMAT_CODE
    case ZOD_NOT_MULTIPLE_OF:
      return NOT_MULTIPLE_OF_CODE
    case ZOD_UNRECOGNIZED_KEYS:
      return UNRECOGNIZED_KEYS_CODE
    default:
      // Anything unnamed above — `custom`, and whatever a future Zod adds —
      // becomes INVALID_VALUE. Without this, a Zod upgrade could put
      // `undefined` into a public contract.
      return INVALID_VALUE_CODE
  }
}

export function toValidationDetails(
  issues: readonly FastifySchemaValidationError[],
): ValidationDetail[] {
  return issues.map((issue) => {
    const field = toFieldPath(issue.instancePath)
    const code = toContractCode(issue)

    // `exactOptionalPropertyTypes` is on: the key is omitted, never set to
    // undefined. An empty path means the body as a whole is wrong.
    return field.length > 0 ? { field, code } : { code }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run --project unit src/infra/http/validation-issues.spec.ts
```

Expected: PASS — 15 tests (12 table rows + 3 named cases).

- [ ] **Step 5: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 31 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/validation-issues.ts src/infra/http/validation-issues.spec.ts
git commit -m "feat: translate zod validation issues into stable contract codes"
```

---

### Task 5: The error handler — taxonomy and unexpected errors

The core of the block. Two branches now; Tasks 6 and 7 add the other two.

**Files:**
- Create: `src/infra/http/error-response.ts`
- Create: `src/infra/http/error-handler.ts`
- Test: `src/infra/http/error-handler.spec.ts`
- Modify: `src/infra/http/server.ts`

**Interfaces:**
- Consumes: `AppError` and the six categories (Task 1); `getTraceId` (Task 2).
- Produces:
  - From `error-response.ts`: `errorResponseSchema` (Zod), `type ErrorResponse`, `INTERNAL_SERVER_ERROR_CODE`, `INTERNAL_SERVER_ERROR_MESSAGE`.
  - From `error-handler.ts`: `registerErrorHandling(app: FastifyInstance): void`. Task 7 extends this same function; Task 6 extends the handler it installs.

- [ ] **Step 1: Write the failing test**

Create `src/infra/http/error-handler.spec.ts`:

```ts
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  type Env,
  NODE_ENV_TEST,
} from '#infra/config/env'
import { errorResponseSchema } from '#infra/http/error-response'
import { buildServer } from '#infra/http/server'
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '#shared/errors/app-error'

// Duplicated from server.spec.ts on purpose: it is a fixture, not a shared
// constant, and it is built from the same exported defaults, so the values
// cannot drift. Extract it to a fixture module when a third spec needs it.
const TEST_DATABASE_URL = 'postgres://user:pass@localhost:5432/app'
const testEnv: Env = {
  NODE_ENV: NODE_ENV_TEST,
  HOST: DEFAULT_HOST,
  PORT: DEFAULT_PORT,
  LOG_LEVEL: DEFAULT_LOG_LEVEL,
  DATABASE_URL: TEST_DATABASE_URL,
}

const THROW_PATH = '/probe/throw'
const GET_METHOD = 'GET'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const PROBE_ERROR_CODE = 'PROBE_ERROR'
const PROBE_ERROR_MESSAGE = 'Probe failed'
/** Stands in for anything a driver might put in an error: never client-visible. */
const INTERNAL_DETAIL = 'connection to 10.0.0.5:5432 refused'

// Wire contract — spelled out rather than imported, so a rename of the
// constants cannot keep this suite green while breaking every client.
const BAD_REQUEST_STATUS = 400
const UNAUTHORIZED_STATUS = 401
const FORBIDDEN_STATUS = 403
const NOT_FOUND_STATUS = 404
const CONFLICT_STATUS = 409
const UNPROCESSABLE_ENTITY_STATUS = 422
const INTERNAL_SERVER_ERROR_STATUS = 500
const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR'
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

class ProbeNotFoundError extends NotFoundError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeConflictError extends ConflictError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeUnauthorizedError extends UnauthorizedError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeForbiddenError extends ForbiddenError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeValidationError extends ValidationError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
class ProbeBusinessRuleError extends BusinessRuleError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(PROBE_ERROR_MESSAGE)
  }
}
/** Extends the base directly, skipping the taxonomy: a programming mistake. */
class RogueAppError extends AppError {
  readonly code = PROBE_ERROR_CODE
  constructor() {
    super(INTERNAL_DETAIL)
  }
}

const openApps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

/** A server whose log is captured instead of printed. Closed in `afterEach`. */
function createApp(): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  const app = buildServer(testEnv, { logStream: stream })
  openApps.push(app)

  return { app, lines }
}

async function injectThrow(error: unknown): Promise<{
  statusCode: number
  body: string
  json: () => unknown
  log: string
}> {
  const { app, lines } = createApp()

  app.get(THROW_PATH, async () => {
    throw error
  })

  const response = await app.inject({ method: GET_METHOD, url: THROW_PATH })

  return {
    statusCode: response.statusCode,
    body: response.body,
    json: () => response.json(),
    log: lines.join(''),
  }
}

describe('error handler — taxonomy', () => {
  const STATUS_TABLE: ReadonlyArray<[string, () => AppError, number]> = [
    ['NotFoundError', () => new ProbeNotFoundError(), NOT_FOUND_STATUS],
    ['ConflictError', () => new ProbeConflictError(), CONFLICT_STATUS],
    ['UnauthorizedError', () => new ProbeUnauthorizedError(), UNAUTHORIZED_STATUS],
    ['ForbiddenError', () => new ProbeForbiddenError(), FORBIDDEN_STATUS],
    ['ValidationError', () => new ProbeValidationError(), BAD_REQUEST_STATUS],
    ['BusinessRuleError', () => new ProbeBusinessRuleError(), UNPROCESSABLE_ENTITY_STATUS],
  ]

  it.each(STATUS_TABLE)('answers %s with %i', async (_name, create, expectedStatus) => {
    const result = await injectThrow(create())

    expect(result.statusCode).toBe(expectedStatus)
  })

  it('answers with the contract envelope', async () => {
    const result = await injectThrow(new ProbeNotFoundError())

    expect(result.json()).toEqual({
      error: {
        code: PROBE_ERROR_CODE,
        message: PROBE_ERROR_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a body that satisfies the published error schema', async () => {
    // Keeps the handler and the schema that OpenAPI publishes from drifting
    // apart: they are the same contract, described in two places.
    const result = await injectThrow(new ProbeNotFoundError())

    expect(errorResponseSchema.safeParse(result.json()).success).toBe(true)
  })
})

describe('error handler — unexpected errors', () => {
  it('answers 500 with a generic envelope', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.json()).toEqual({
      error: {
        code: INTERNAL_ERROR_CODE,
        message: INTERNAL_ERROR_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('never leaks the internal message to the client', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.body).not.toContain(INTERNAL_DETAIL)
  })

  it('records the internal message in the log', async () => {
    const result = await injectThrow(new Error(INTERNAL_DETAIL))

    expect(result.log).toContain(INTERNAL_DETAIL)
  })

  it('treats an AppError outside the six categories as unexpected', async () => {
    const result = await injectThrow(new RogueAppError())

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.body).not.toContain(PROBE_ERROR_CODE)
    expect(result.log).toContain(INTERNAL_DETAIL)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: FAIL — every case. Fastify's default handler answers `500 {"statusCode":500,"error":"Internal Server Error","message":"Probe failed"}`, which is both the wrong status and a leak of the internal message.

- [ ] **Step 3: Create the error envelope**

Create `src/infra/http/error-response.ts`:

```ts
import { z } from 'zod'

export const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR'
export const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal server error'

const validationDetailSchema = z.object({
  field: z.string().optional(),
  code: z.string(),
})

/**
 * The public shape of every error this API returns. Single source of truth for
 * the handler, for OpenAPI, and for the example in ARCHITECTURE.md.
 *
 * `code` is contract and stable; `message` is for logs and debugging and must
 * never be shown raw in a localized client.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(validationDetailSchema).optional(),
    traceId: z.string(),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>
```

- [ ] **Step 4: Write the handler**

Create `src/infra/http/error-handler.ts`:

```ts
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getTraceId } from '#infra/observability/request-context'
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '#shared/errors/app-error'
import {
  type ErrorResponse,
  INTERNAL_SERVER_ERROR_CODE,
  INTERNAL_SERVER_ERROR_MESSAGE,
} from './error-response.js'

const BAD_REQUEST_STATUS = 400
const UNAUTHORIZED_STATUS = 401
const FORBIDDEN_STATUS = 403
const NOT_FOUND_STATUS = 404
const CONFLICT_STATUS = 409
const UNPROCESSABLE_ENTITY_STATUS = 422
const INTERNAL_SERVER_ERROR_STATUS = 500

const UNHANDLED_ERROR_LOG_MESSAGE = 'unhandled error'

/**
 * The only HTTP mapping in the system. It does not grow with the number of
 * domain errors — a hundred of them still land in these six categories.
 *
 * The six are siblings: each extends `AppError` directly. If one ever extended
 * another, this table would silently start depending on row order.
 */
const STATUS_BY_CATEGORY: ReadonlyArray<[abstract new (...args: never[]) => AppError, number]> = [
  [NotFoundError, NOT_FOUND_STATUS],
  [ConflictError, CONFLICT_STATUS],
  [UnauthorizedError, UNAUTHORIZED_STATUS],
  [ForbiddenError, FORBIDDEN_STATUS],
  [ValidationError, BAD_REQUEST_STATUS],
  [BusinessRuleError, UNPROCESSABLE_ENTITY_STATUS],
]

function statusForCategory(error: AppError): number | undefined {
  for (const [category, status] of STATUS_BY_CATEGORY) {
    if (error instanceof category) return status
  }
  return undefined
}

function buildErrorResponse(code: string, message: string, traceId: string): ErrorResponse {
  return { error: { code, message, traceId } }
}

/**
 * `getTraceId()` is always set inside a request — the `onRequest` hook in
 * `server.ts` opens the context before any handler runs, and that was verified
 * for both handlers. The fallback exists only to satisfy the type.
 */
function traceIdFor(request: FastifyRequest): string {
  return getTraceId() ?? request.id
}

function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const traceId = traceIdFor(request)

  if (error instanceof AppError) {
    const status = statusForCategory(error)

    if (status !== undefined) {
      return reply.status(status).send(buildErrorResponse(error.code, error.message, traceId))
    }
    // An AppError outside the taxonomy is a programming mistake, not a client
    // problem: it falls through to the generic branch rather than guessing.
  }

  request.log.error({ err: error }, UNHANDLED_ERROR_LOG_MESSAGE)

  return reply
    .status(INTERNAL_SERVER_ERROR_STATUS)
    .send(buildErrorResponse(INTERNAL_SERVER_ERROR_CODE, INTERNAL_SERVER_ERROR_MESSAGE, traceId))
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(handleError)
}
```

- [ ] **Step 5: Register it in the server**

In `src/infra/http/server.ts`, add the import:

```ts
import { registerErrorHandling } from './error-handler.js'
```

Then call it right after the `onRequest` hook added in Task 3, before `return app`:

```ts
  // Instance configuration, not a route: every server built here — production,
  // unit spec, integration spec — answers errors with the same contract.
  registerErrorHandling(app)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: PASS — 12 tests (6 table rows + 2 envelope + 4 unexpected).

- [ ] **Step 7: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 43 tests green. In particular `tests/integration/health.spec.ts` must stay green: `/health` returns its 503 by `reply.status(...).send(...)` rather than by throwing, so the new handler does not intercept it.

- [ ] **Step 8: Commit**

```bash
git add src/infra/http/error-response.ts src/infra/http/error-handler.ts src/infra/http/error-handler.spec.ts src/infra/http/server.ts
git commit -m "feat: add global error handler mapping the error taxonomy to http"
```

---

### Task 6: The validation branch

A Fastify validation failure is **not** part of the taxonomy: an invalid body arrives as a plain `Error` carrying `code: 'FST_ERR_VALIDATION'`, never as an instance of `ValidationError` — and it could not be, since the taxonomy is abstract and lives in the pure layer. Without this branch, every invalid payload would answer 500.

This branch goes at the **top** of the chain, above the `AppError` check.

**Files:**
- Modify: `src/infra/http/error-response.ts`
- Modify: `src/infra/http/error-handler.ts`
- Test: `src/infra/http/error-handler.spec.ts` (add to it)

**Interfaces:**
- Consumes: `toValidationDetails`, `ValidationDetail` (Task 4); `createApp` (Task 5 spec helper).
- Produces: `VALIDATION_ERROR_CODE`, `VALIDATION_ERROR_MESSAGE` exported from `error-response.ts`.

- [ ] **Step 1: Write the failing test**

In `src/infra/http/error-handler.spec.ts`, add these imports to the existing block:

```ts
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
```

Add these constants next to the existing ones:

```ts
const VALIDATE_PATH = '/probe/validate'
const POST_METHOD = 'POST'
const MIN_PASSWORD_LENGTH = 8
const INVALID_EMAIL = 'not-an-email'
const SHORT_PASSWORD = 'abc'

// Wire contract, spelled out.
const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
const VALIDATION_ERROR_MESSAGE = 'Invalid payload'
const EMAIL_FIELD = 'email'
const PASSWORD_FIELD = 'password'
const INVALID_FORMAT_CODE = 'INVALID_FORMAT'
const TOO_SHORT_CODE = 'TOO_SHORT'
```

Add this helper below `injectThrow`:

```ts
async function injectPayload(payload: unknown) {
  const { app } = createApp()

  app.withTypeProvider<ZodTypeProvider>().post(
    VALIDATE_PATH,
    {
      schema: {
        body: z.object({
          email: z.email(),
          password: z.string().min(MIN_PASSWORD_LENGTH),
        }),
      },
    },
    async () => ({ accepted: true }),
  )

  return app.inject({ method: POST_METHOD, url: VALIDATE_PATH, payload })
}
```

And this describe block at the end of the file:

```ts
describe('error handler — validation', () => {
  it('answers 400 rather than 500 for an invalid payload', async () => {
    const response = await injectPayload({ email: INVALID_EMAIL, password: SHORT_PASSWORD })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS)
  })

  it('reports one detail per invalid field, in the contract codes', async () => {
    const response = await injectPayload({ email: INVALID_EMAIL, password: SHORT_PASSWORD })

    expect(response.json()).toEqual({
      error: {
        code: VALIDATION_ERROR_CODE,
        message: VALIDATION_ERROR_MESSAGE,
        details: [
          { field: EMAIL_FIELD, code: INVALID_FORMAT_CODE },
          { field: PASSWORD_FIELD, code: TOO_SHORT_CODE },
        ],
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a body that satisfies the published error schema', async () => {
    const response = await injectPayload({ email: INVALID_EMAIL, password: SHORT_PASSWORD })

    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: FAIL — both new tests answer `500` with the generic envelope, because the validation error is not an `AppError` and falls into the unexpected branch.

- [ ] **Step 3: Add the two constants to the envelope module**

In `src/infra/http/error-response.ts`, above `INTERNAL_SERVER_ERROR_CODE`:

```ts
export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
export const VALIDATION_ERROR_MESSAGE = 'Invalid payload'
```

- [ ] **Step 4: Add the branch to the handler**

In `src/infra/http/error-handler.ts`, add the imports:

```ts
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { type ValidationDetail, toValidationDetails } from './validation-issues.js'
```

and extend the existing import from `./error-response.js` with `VALIDATION_ERROR_CODE` and `VALIDATION_ERROR_MESSAGE`.

Add this builder next to `buildErrorResponse`:

```ts
function buildValidationResponse(details: ValidationDetail[], traceId: string): ErrorResponse {
  return {
    error: {
      code: VALIDATION_ERROR_CODE,
      message: VALIDATION_ERROR_MESSAGE,
      details,
      traceId,
    },
  }
}
```

Then insert this as the **first** branch of `handleError`, immediately after `const traceId = traceIdFor(request)`:

```ts
  // Must come first: FST_ERR_VALIDATION carries a 4xx statusCode, so a later
  // branch would swallow it. The library's guard is used instead of comparing
  // `error.code`, because it also confirms the issues came from Zod and are
  // therefore translatable.
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply
      .status(BAD_REQUEST_STATUS)
      .send(buildValidationResponse(toValidationDetails(error.validation), traceId))
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: PASS — 15 tests.

- [ ] **Step 6: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 46 tests green.

- [ ] **Step 7: Commit**

```bash
git add src/infra/http/error-response.ts src/infra/http/error-handler.ts src/infra/http/error-handler.spec.ts
git commit -m "feat: answer invalid payloads with 400 and per-field contract codes"
```

---

### Task 7: Fastify's own 4xx errors and the missing route

Closes the last two holes in the envelope. A `Content-Type: text/plain` on a POST raises `FST_ERR_CTP_INVALID_MEDIA_TYPE`, which is not an `AppError` — without this branch the client gets **500 for its own mistake** and the log fills with fake internal errors. A request to an unregistered path gets Fastify's own `{"message":…,"error":"Not Found","statusCode":404}`, which is not the envelope.

**Files:**
- Modify: `src/infra/http/error-response.ts`
- Modify: `src/infra/http/error-handler.ts`
- Test: `src/infra/http/error-handler.spec.ts` (add to it)

**Interfaces:**
- Consumes: everything from Tasks 5 and 6; `registerOpenApi` and `DOCS_ROUTE_PREFIX` from `#infra/http/openapi`.
- Produces: `BAD_REQUEST_CODE`, `ROUTE_NOT_FOUND_CODE`, `ROUTE_NOT_FOUND_MESSAGE` exported from `error-response.ts`; `registerErrorHandling` now also installs the not-found handler.

- [ ] **Step 1: Write the failing test**

In `src/infra/http/error-handler.spec.ts`, add these imports:

```ts
import { NODE_ENV_DEVELOPMENT } from '#infra/config/env'
import { DOCS_ROUTE_PREFIX, registerOpenApi } from '#infra/http/openapi'
```

Add these constants:

```ts
const UNKNOWN_PATH = '/definitely-not-a-route'
const PLAIN_TEXT_CONTENT_TYPE = 'text/plain'
const CONTENT_TYPE_HEADER = 'content-type'
const PLAIN_TEXT_PAYLOAD = 'not json'
const UNSUPPORTED_MEDIA_TYPE_STATUS = 415
const SERVICE_UNAVAILABLE_STATUS = 503
const OK_STATUS = 200
const DOCS_JSON_PATH = `${DOCS_ROUTE_PREFIX}/json`

// Wire contract, spelled out.
const BAD_REQUEST_CODE = 'BAD_REQUEST'
const ROUTE_NOT_FOUND_CODE = 'ROUTE_NOT_FOUND'
const ROUTE_NOT_FOUND_MESSAGE = 'Route not found'
```

Add this describe block at the end of the file:

```ts
describe('error handler — framework errors', () => {
  it('answers an unsupported content type with 415 in the envelope', async () => {
    const { app } = createApp()

    app.post(VALIDATE_PATH, async () => ({ accepted: true }))

    const response = await app.inject({
      method: POST_METHOD,
      url: VALIDATE_PATH,
      payload: PLAIN_TEXT_PAYLOAD,
      headers: { [CONTENT_TYPE_HEADER]: PLAIN_TEXT_CONTENT_TYPE },
    })

    expect(response.statusCode).toBe(UNSUPPORTED_MEDIA_TYPE_STATUS)
    expect(response.json()).toMatchObject({
      error: {
        code: BAD_REQUEST_CODE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('does not pass through a 5xx raised by the framework', async () => {
    const frameworkError = Object.assign(new Error(INTERNAL_DETAIL), {
      statusCode: SERVICE_UNAVAILABLE_STATUS,
    })

    const result = await injectThrow(frameworkError)

    expect(result.statusCode).toBe(INTERNAL_SERVER_ERROR_STATUS)
    expect(result.body).not.toContain(INTERNAL_DETAIL)
  })

  it('answers an unregistered route with the envelope, not Fastify default shape', async () => {
    const { app } = createApp()

    const response = await app.inject({ method: GET_METHOD, url: UNKNOWN_PATH })

    expect(response.statusCode).toBe(NOT_FOUND_STATUS)
    expect(response.json()).toEqual({
      error: {
        code: ROUTE_NOT_FOUND_CODE,
        message: ROUTE_NOT_FOUND_MESSAGE,
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('leaves the OpenAPI document reachable', async () => {
    // The one open question from the design spec: a custom not-found handler
    // installed on the root instance could plausibly shadow the docs routes.
    const developmentEnv: Env = { ...testEnv, NODE_ENV: NODE_ENV_DEVELOPMENT }
    const { app } = createApp()

    await registerOpenApi(app, developmentEnv)
    app.post(VALIDATE_PATH, async () => ({ accepted: true }))
    await app.ready()

    const response = await app.inject({ method: GET_METHOD, url: DOCS_JSON_PATH })

    expect(response.statusCode).toBe(OK_STATUS)
  })
})
```

> **Note on the last test:** `createApp` builds with `testEnv` (`NODE_ENV=test`), while `registerOpenApi` is given `developmentEnv`. That is deliberate — it exercises the docs routes without switching on the `pino-pretty` transport, which is mutually exclusive with the injected `logStream`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: FAIL — the 415 case answers 500 with the generic envelope, and the unknown-route case answers Fastify's default `{"message":…,"error":"Not Found","statusCode":404}`.

- [ ] **Step 3: Add the constants to the envelope module**

In `src/infra/http/error-response.ts`, next to the existing exported constants:

```ts
export const BAD_REQUEST_CODE = 'BAD_REQUEST'
export const ROUTE_NOT_FOUND_CODE = 'ROUTE_NOT_FOUND'
export const ROUTE_NOT_FOUND_MESSAGE = 'Route not found'
```

- [ ] **Step 4: Add the branch and the not-found handler**

In `src/infra/http/error-handler.ts`, extend the import from `./error-response.js` with `BAD_REQUEST_CODE`, `ROUTE_NOT_FOUND_CODE` and `ROUTE_NOT_FOUND_MESSAGE`.

Add these constants next to the status codes:

```ts
const CLIENT_ERROR_MIN_STATUS = 400
const CLIENT_ERROR_MAX_STATUS = 499
```

Add this predicate next to `statusForCategory`:

```ts
function isClientError(error: FastifyError): error is FastifyError & { statusCode: number } {
  return (
    typeof error.statusCode === 'number' &&
    error.statusCode >= CLIENT_ERROR_MIN_STATUS &&
    error.statusCode <= CLIENT_ERROR_MAX_STATUS
  )
}
```

Insert this branch in `handleError`, **after** the `AppError` block and **before** the `request.log.error(...)` line:

```ts
  if (isClientError(error)) {
    // 4xx means the client is at fault, and Fastify's message for these talks
    // about the request rather than about internals. One code, not a table
    // keyed by FST_ERR_*: the framework name must not become public contract,
    // and the HTTP status already tells 413 from 415.
    return reply
      .status(error.statusCode)
      .send(buildErrorResponse(BAD_REQUEST_CODE, error.message, traceId))
  }
```

Add the not-found handler above `registerErrorHandling`:

```ts
function handleNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .status(NOT_FOUND_STATUS)
    .send(
      buildErrorResponse(ROUTE_NOT_FOUND_CODE, ROUTE_NOT_FOUND_MESSAGE, traceIdFor(request)),
    )
}
```

And register it:

```ts
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(handleError)
  // Without this, the most common 404 of all — a typo in the path — answers in
  // Fastify's own shape and puts a hole in the envelope contract.
  app.setNotFoundHandler(handleNotFound)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/infra/http/error-handler.spec.ts
```

Expected: PASS — 19 tests.

- [ ] **Step 6: Verify the whole suite**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
```

Expected: 50 tests green.

- [ ] **Step 7: Verify the running server end to end**

```bash
docker compose up -d
pnpm dev &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/definitely-not-a-route
kill %1
```

Expected: `200` for `/health`, and for the unknown route a body shaped
`{"error":{"code":"ROUTE_NOT_FOUND","message":"Route not found","traceId":"<uuid>"}}` — with a real UUID, not `req-1`.

- [ ] **Step 8: Commit**

```bash
git add src/infra/http/error-response.ts src/infra/http/error-handler.ts src/infra/http/error-handler.spec.ts
git commit -m "feat: keep framework 4xx and unknown routes inside the error envelope"
```

---

### Task 8: Document it in ARCHITECTURE.md

`ARCHITECTURE.md` documents **what exists**, so it is updated last, when everything it describes is verifiable. It is written in Portuguese (`CLAUDE.md` allows it for Markdown); keep that voice.

**Files:**
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–7.
- Produces: nothing consumed by code.

- [ ] **Step 1: Fix the claim in §1 that is now false**

§1 currently ends with:

```
Ainda não há código puro no repositório — existe `infra/` e existe `main/`. O
princípio está aqui porque é ele que decide onde cada arquivo novo vai cair.
```

Replace with:

```
O primeiro código puro do repositório é a taxonomia de erro em `src/shared/`
(§8) — nenhum import, nenhuma menção a protocolo. O resto ainda é `infra/` e
`main/`.
```

- [ ] **Step 2: Add the new files to the tree in §2**

Inside the `src/` block, add `shared/` after the `infra/` subtree and before `main/`, and add the four new `infra/` files:

```text
│   ├── http/
│   │   ├── server.ts               # instância Fastify, SEM rotas
│   │   ├── server.spec.ts          # unitário colocado
│   │   ├── error-handler.ts        # ÚNICO lugar que conhece status HTTP
│   │   ├── error-handler.spec.ts
│   │   ├── error-response.ts       # schema Zod do envelope de erro
│   │   ├── validation-issues.ts    # tradução Zod -> códigos do contrato
│   │   ├── openapi.ts              # OpenAPI + UI dos docs (só em development)
│   │   └── endpoints/
│   │       └── health.ts           # GET /health — agrega os checks
│   └── observability/
│       ├── redact-paths.ts         # paths redigidos pelo logger
│       └── request-context.ts      # AsyncLocalStorage do traceId
├── shared/                         # camada PURA, sem dono de módulo
│   └── errors/
│       └── app-error.ts            # taxonomia: AppError + as 6 categorias
└── main/
    └── http.ts                     # entrypoint: valida env, abre o banco, sobe o servidor
```

- [ ] **Step 3: Add the `genReqId` note to §5**

In §5, after the `logController` bullet and before the `redact` bullet, insert:

```markdown
- **`genReqId: () => randomUUID()`** — o padrão do Fastify é um **contador por
  processo** (`req-1`, `req-2`). Com duas réplicas as duas emitem `req-1`, e um
  restart reinicia a contagem: grepar um `traceId` no agregador devolveria
  requisições sem relação entre si. É o mesmo valor que aparece no corpo de erro
  (§8), então o `traceId` de um print do usuário grepa a linha exata do log.
```

- [ ] **Step 4: Insert the new §8**

Insert this whole section between the current §7 (HTTP e documentação da API) and the current §8 (Testes):

````markdown
## 8. Erros

Toda falha responde no **mesmo envelope**, com um `code` estável que o cliente
pode ramificar:

```jsonc
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found", "traceId": "6eedbea3-…" } }
```

`code` é contrato e serve de chave de i18n. **`message` não é contrato** — existe
para log e debug, e nunca deve ser exibida crua num app traduzido, ou vira texto
em inglês numa tela em português.

### A taxonomia é semântica, não protocolar

`src/shared/errors/app-error.ts` é camada pura e **não menciona HTTP**. "Não
encontrado" e "conflito" são conceitos de aplicação: significam a mesma coisa num
worker ou num cron, onde status code não quer dizer nada.

```ts
export abstract class AppError extends Error {
  abstract readonly code: string
}
export abstract class NotFoundError extends AppError {}
// ConflictError, UnauthorizedError, ForbiddenError, ValidationError, BusinessRuleError
```

O `code` é **declarado**, nunca derivado do nome da classe. Derivar faria o nome
da classe virar contrato público em silêncio: um PR de renome passaria no
typecheck, no lint e em todo teste, e quebraria o `switch (error.code)` de todo
app em produção sem deixar rastro no diff.

### O mapa não cresce

`infra/http/error-handler.ts` é o **único** arquivo do sistema que conhece status
HTTP. Cem erros de domínio continuam caindo nestas seis linhas:

| categoria | status |
|---|---|
| `ValidationError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `BusinessRuleError` | 422 |

As seis são **irmãs** — todas estendem `AppError` direto. Se alguma passar a
estender outra, o mapa começa a depender da ordem das linhas.

O use case só faz `throw`; o endpoint não tem `try/catch`.

### As quatro coisas que não são da taxonomia

| origem | resposta | por quê |
|---|---|---|
| validação do Fastify/Zod | 400 `VALIDATION_ERROR` + `details[]` | chega como `Error` com `FST_ERR_VALIDATION`, não como `ValidationError` — sem esse ramo, todo payload inválido daria 500 |
| 4xx do próprio Fastify (415, 413…) | status preservado, `code` `BAD_REQUEST` | 4xx é culpa do cliente; virar 500 encheria o log de erro interno falso |
| rota inexistente | 404 `ROUTE_NOT_FOUND` | sem `setNotFoundHandler` o 404 sai no formato do Fastify e fura o envelope |
| qualquer outra coisa | 500 `INTERNAL_SERVER_ERROR` | corpo genérico, **sem stack e sem mensagem de driver**; o log registra tudo |

Um `AppError` que estenda a base **fora** das seis categorias também cai no
último ramo: é erro de programação, não problema do cliente.

O `code` do 4xx do Fastify é um só, e não uma tabela por `FST_ERR_*`: repassar o
código do framework faria o nome dele virar contrato público, e distinguir 413 de
415 é o que o status HTTP já faz.

### Erro de validação carrega detalhe por campo

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid payload",
    "details": [
      { "field": "email",    "code": "INVALID_FORMAT" },
      { "field": "password", "code": "TOO_SHORT" }
    ],
    "traceId": "6eedbea3-…"
  }
}
```

Os códigos do `details` **não são os do Zod** — o Zod emite `invalid_format` e
`too_small`; o contrato publica `INVALID_FORMAT` e `TOO_SHORT`. A tradução mora
em `infra/http/validation-issues.ts` e é normativa: sem ela, cada app derivado
publicaria um contrato de validação diferente.

| issue do Zod | condição | `code` |
|---|---|---|
| `invalid_type` | — | `INVALID_TYPE` |
| `too_small` | `origin` string/array | `TOO_SHORT` |
| `too_small` | `origin` number/date | `TOO_SMALL` |
| `too_big` | `origin` string/array | `TOO_LONG` |
| `too_big` | `origin` number/date | `TOO_LARGE` |
| `invalid_format` | — | `INVALID_FORMAT` |
| `not_multiple_of` | — | `NOT_MULTIPLE_OF` |
| `unrecognized_keys` | — | `UNRECOGNIZED_KEYS` |
| qualquer outro | — | `INVALID_VALUE` |

O fallback existe para que uma versão nova do Zod não coloque `undefined` num
contrato público. `field` é omitido quando o issue aponta para o corpo inteiro em
vez de um campo — é o caso de `unrecognized_keys`.

### `traceId`: o mesmo no log e no corpo

`infra/observability/request-context.ts` isola um `AsyncLocalStorage` em três
funções. Um hook `onRequest` abre o escopo com o `request.id`, e tudo a jusante
— rotas, hooks, error handler e not-found handler — lê o mesmo valor sem receber
parâmetro nenhum.

O caminho explícito (`ctx` em toda assinatura) foi descartado por ser viral:
contamina até a assinatura dos repositórios, e esquecer de repassar quebra a
correlação em silêncio.

> Hoje o error handler poderia usar `request.id` direto — o ALS ainda não tem
> consumidor fora do fluxo de request. Ele existe assim mesmo porque num
> boilerplate o que não entra hoje não chega aos apps já derivados, e porque é
> ele que mantém a migração para OpenTelemetry como troca de **um arquivo**.

### Onde tudo isso é registrado

Error handler, not-found handler e o hook do ALS ficam em **`buildServer`**, não
em `main/http.ts`. A regra "`server.ts` não registra rotas" continua valendo:
isto é configuração da instância, não roteamento. O efeito é que todo servidor
montado num teste já herda o contrato de erro inteiro.
````

- [ ] **Step 5: Renumber the sections below**

The old §8 through §12 shift down by one:

| antes | depois |
|---|---|
| §8 Testes | §9 |
| §9 Comandos | §10 |
| §10 Versões | §11 |
| §11 Decisões travadas | §12 |
| §12 O que ainda não existe | §13 |

- [ ] **Step 6: Fix the two cross-references affected by the renumbering**

Only two references in the document point at a section at or below the insertion point. Confirm with:

```bash
grep -n '§[0-9]' ARCHITECTURE.md
```

- Near the top: `verificável rodando os comandos da §9` → **§10**
- In §3: `ficam só no `tsconfig.build.json` — ver §8` → **ver §9**

Every other `§` reference points at §1, §4, §5 or §7 and stays as is.

- [ ] **Step 7: Update the "what does not exist yet" list**

The last line of the (now) §13 currently reads:

```
módulos e camada pura · regra de fronteira no lint · error handler e taxonomia de
erro · `traceId` por `AsyncLocalStorage` · migrations · Docker · CI
```

Replace with:

```
módulos de negócio · regra de fronteira no lint · migrations · Docker · CI
```

- [ ] **Step 8: Add the new specs to what the suite covers, in §9**

In the (now) §9, the paragraph starting `O que a suíte cobre hoje:` — append to it:

```
Somam-se a isso o contrato de erro do §8 inteiro: as seis categorias mapeadas
uma a uma, a tabela de tradução do Zod linha a linha, e a garantia de
não-vazamento — um erro inesperado responde genérico e a mensagem interna
aparece **só** no log.
```

- [ ] **Step 9: Verify the document is accurate**

```bash
pnpm lint:fix && pnpm typecheck && pnpm test
grep -n '^## ' ARCHITECTURE.md
```

Expected: 50 tests green, and the section headings numbered 1 through 13 with no gap and no repeat. Re-read the new §8 against the code as it was actually written — if any of it describes something that is not there, the code is right and the document is wrong.

- [ ] **Step 10: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: document the error contract, taxonomy and traceId"
```

---

## Done When

- `pnpm typecheck`, `pnpm lint` and `pnpm test` are all green.
- `pnpm build` emits `dist/` with **no** `.spec.js` in it (`ls dist/shared/errors/` shows only `app-error.js`).
- A request to an unknown path on the running server answers the envelope with a real UUID `traceId`, and that same `traceId` appears in the log line for that request.
- `ARCHITECTURE.md` §8 describes only what the code actually does.
