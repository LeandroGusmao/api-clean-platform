---
name: architecture-audit
description: Use when auditing, reviewing or validating this repository's code against its architecture — before a commit, PR or merge, when reviewing a freshly implemented diff/branch/slice, or when asked for an "audit", "architecture review", "boundary check", "pure layer", "data/secret leak in logs", "module isolation", R6, R7.
---

# Architecture and Security Audit

Audit of this repository against the rules in `ARCHITECTURE.md` and `CLAUDE.md`.
Two passes: the scanner proves what a regex can prove; you read what only
reading catches.

**The principle that orders everything:** pure code never depends on code that
touches the outside world, and no secret crosses a boundary. A leak or a breach
of the pure layer is **CRITICAL** — there is no "just this once".

## Procedure

### 1. Define the scope and state it

| Situation | Command |
|---|---|
| Uncommitted work (default) | `node .claude/skills/architecture-audit/scripts/audit-scan.mjs` |
| Branch against its base | `… /audit-scan.mjs --base main` |
| Whole tree | `… /audit-scan.mjs --all` |
| Specific files/folders | `… /audit-scan.mjs src/modules/auth package.json` |

`--json` to consume the output; `--strict` as a CI gate (exit 2 on CRITICAL).
The report always names the audited scope — an audit without a declared scope is
not verifiable.

### 2. Run the scanner

Each finding comes with a severity, the check id, `file:line`, the rule and the
snippet. Full catalog, with what each check proves and how to fix it:
[references/checks.md](references/checks.md).

**The scanner is a floor, not a ceiling.** It does not open a file to understand
intent.

### 2b. Run the gates the repository already has

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm lint && pnpm typecheck && pnpm test:unit
```

**Never pipe a gate.** `pnpm lint | tail -1` returns the status of `tail`, which
is always 0: the `&&` carries on over a red check and the audit approves what
failed. Same family: `pnpm test:unit -- <filter>` swallows the filter and runs
the whole suite, so "passed" does not mean your case passed. Run each gate on its
own and read the exit code — or `set -o pipefail`, if you need the pipe.

Without the `PATH`, `pnpm` refuses with `ERR_PNPM_UNSUPPORTED_ENGINE` — the
shell's `node` is older than the project's `engines`, and that is not an audit
finding.

A red gate is a finding: **HIGH** if it is lint or typecheck, **CRITICAL** if it
is a broken test. Approving a slice with a red suite is approving what nobody
verified — and `pnpm lint` is where R6 really has teeth.

### 3. Read what the scanner does not prove

Mandatory for every file in scope. None of these is detectable by a textual
pattern:

- **The endpoint declares every status it produces itself** (§7). Has a `body`
  schema but does not declare 400? Calls a use case that throws `ConflictError`
  but does not declare 409? Has a `guard` but does not declare 401? The client
  finds out by trial and error.
- **The response schema does not publish a sensitive field.** Compare field by
  field with the use case's read model. `passwordHash` out, and every new field
  justified.
- **A route that calls `getPrincipal` has `preHandler: guard`.** Without the
  guard the route answers **500**, not 401 — a wiring failure disguised as
  normal traffic.
- **A new error extends one of the seven categories** and declares a literal
  `code`, never one derived from the class name (§8).
- **A use case receives `IClock`/`IIdGenerator`** (`#shared/ports/`) instead of
  generating the value — even when the value is born inside an entity.
- **The repository inserts and handles the violation**, never query-then-insert
  (race), and matches the constraint by **name**, not only by the `23505` code
  (§6).
- **The ownership filter reaches the query.** The scanner flags an ownership
  parameter that is received and never used; it does **not** see the case where
  the parameter is used but never enters the `where`. Read the query: without the
  owner in it, whoever discovers the id of someone else's resource reads
  someone else's resource.
- **A field that looks like a credential** (`*Token`, `*Secret`, `*Key`)
  published in a response: either it carries entropy — and then it cannot leave —
  or it is derivable from what the response already exposes, and then it
  authorizes nothing and lies about protecting.
- **Every imported package is in `package.json`**, at the exact version. Importing
  an undeclared dependency is not a build detail: the slice never ran.
- **A table declared in `schema/` has a committed migration** in `drizzle/`.
  A schema without a migration is a slice that breaks on the first `select`.
- **The mapper persists the real value.** An entity that does not expose the
  field forces the mapper to invent a literal — and the stored data stops being
  the received data.
- **A new migration in a new folder**, with `--name`; an applied migration is
  immutable (R4).
- **A test placed next to the new code**; an integration spec cleans its own
  table in `beforeEach` (§9).
- **Magic string/number** the scanner does not cover (headers, keys, limits) —
  except names in `infra/drizzle/schema/*.ts`, which `CLAUDE.md` exempts.
- **A comment that lies**: the text describes a behavior the code no longer has.
  It counts as a finding.

### 4. Classify

| Severity | What falls here |
|---|---|
| **CRITICAL** | Secret/sensitive data crossing a boundary (log, response, driver error); pure layer importing IO/infra; `process.env` outside `env.ts`; one module's infra reaching another's |
| **HIGH** | R7 (non-determinism in the pure layer); import outside the pattern; test reading `process.env`; container reached by someone who may not; dependency with `^`/`~` |
| **MEDIUM** | Convention with a local effect: `z.iso.datetime()` in a response, `try/catch` in the endpoint, inline status, `db.query.*`, file outside the boundary map |
| **LOW** | Style, naming, outdated comment with no effect |

**Overall status — derived, not opined:**

- 🔴 **Failed** — at least one CRITICAL.
- 🟡 **Approved with Caveats** — no CRITICAL, at least one HIGH or MEDIUM.
- 🟢 **Approved** — only LOW, or nothing.

### 5. Issue the report

An audit **reports**; fixing is the reader's decision. Apply a fix only if
explicitly asked, and as a separate step, after the report.

## The report

Markdown, exactly these three sections, in this order.

````markdown
## 1. Executive Summary

**Status:** 🔴 Failed
**Scope:** 12 files (diff against `main`)

| Severity | Total |
|---|---|
| CRITICAL | 2 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 0 |

<one sentence saying what decided the status — the most serious finding, not a summary>

## 2. Violations Found

### 🔴 CRITICAL — Data Leak · `src/modules/x/infra/drizzle/x-repository.ts:31`

**Rule violated:** ARCHITECTURE §6 — driver errors do not leave `infra/`
**Problem:** <what happens in production, not the rule rewritten>

```diff
- throw error
+ throw toPersistenceError(error)
```

### 🟡 MEDIUM — API Documentation · `…:18`
<same shape>

## 3. Verification Checklist Executed

| # | Check | Status |
|---|---|---|
| 1 | No IO/infra import in the pure layer | ✅ |
| 2 | No `process.env` outside `src/infra/config/env.ts` | ✅ |
| 3 | No credential/hash/query leak in a log or response | ❌ 1 |
| 4 | `module-infra` isolation between modules | ✅ |
| 5 | `IClock`/`IIdGenerator` in place of a non-deterministic value | ✅ |
| 6 | Database error translated without exposing the raw driver error | ❌ 1 |
| 7 | Subpath imports (`#…`) and `.js` extension on relative ones | ✅ |
| 8 | Date in a response schema as `z.date()` | ⚠️ 1 |
| 9 | Endpoint declares every status it produces | ✅ |
| 10 | Response schema without a sensitive field | ✅ |
| 11 | `pnpm lint`, `pnpm typecheck` and `pnpm test:unit` green | ✅ |
````

**The checklist is derived from section 2, not filled in separately.** Before
closing, run each violation in section 2 against the checklist line that covers
it: if one falls there, the line is ❌ with the count. A ✅ line above a finding
that belongs to it is the easiest defect to commit in this report — and it is
what makes the reader trust the summary instead of the body.

**Rules of form:** one block per violation, CRITICAL first. `file:line` always —
a finding without a line is not actionable. Every block carries a fix diff; when
the fix depends on a decision (two valid paths), write both and say which you
recommend. A checklist line is marked `n/a` when the scope has no file from that
layer — never ✅. And ✅ only after looking: an item you did not verify is `n/a`,
not approved.

## Rationalizations that invalidate the audit

| Thought | Reality |
|---|---|
| "The scanner flagged nothing, so it passed" | It covers what a regex proves. Step 3 exists because the rest is not provable that way. |
| "It's just a test, tests are an exception" | The boundary table exempts `test` from **imports**, not from secrets. A spec that logs a raw error leaks just the same. |
| "Lint already catches this" | R6 and the boundary have teeth (§4); R7 does not. And the gate sees the graph, not the intent — which is why this skill exists. |
| "It's a single line, I'll mark it MEDIUM" | A leak has no severity proportional to the count. One line is enough for the hash to reach the log. |
| "Pre-existing code, not part of the diff" | Report it with the scope marked. Age does not lower severity. |
| "I'll fix it while I audit" | Report first. A fix mixed in hides what was found. |
| "The intent was right" | The rule applies to what the code does. |

## Maintenance

Edited the scanner, or did a boundary rule change in `ARCHITECTURE.md`?

```bash
node .claude/skills/architecture-audit/tests/run-tests.mjs
```

It asserts both directions: every planted violation is detected at the right
line, and the two **correct** fixtures produce zero findings. A new rule comes
with a new fixture — a violation and a clean counter-example — before the code of
the check.
