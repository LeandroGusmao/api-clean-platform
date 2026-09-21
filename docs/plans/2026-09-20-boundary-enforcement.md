# Fronteira com dente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a tabela de fronteira do `ARCHITECTURE.md` §2 falhar o `pnpm lint` quando um import a cruza, com fixtures que provam que o portão pega o que deve e libera o que deve.

**Architecture:** `dependency-cruiser` cruza o grafo resolvido; os padrões da tabela moram num único `layers.mjs` que tanto a config do depcruise quanto o `audit-scan.mjs` consomem; um `check.mjs` embrulha a chamada com pré-voo do transpiler, guarda de cobertura e classificação total, porque o depcruise falha **em silêncio com exit 0** em três configurações diferentes.

**Tech Stack:** Node 24, pnpm 11, TypeScript 7 (com TypeScript 6.0.3 aninhado só para o depcruise), vitest 4, dependency-cruiser 18.4.0.

**Spec:** [`docs/specs/2026-09-20-boundary-enforcement-design.md`](../specs/2026-09-20-boundary-enforcement-design.md)

## Global Constraints

- **Toda dependência é pinada em versão exata.** Nenhum `^`, nenhum `~`. O `savePrefix: ''` do `pnpm-workspace.yaml` já garante isso em `pnpm add`.
- **Código, identificadores, strings e comentários em inglês.** Markdown (`*.md`) pode ser português.
- **Sem magic string ou magic number.** Constantes nomeadas em `UPPER_SNAKE_CASE`, declaradas perto de onde são usadas.
- **Comentário explica o código, nunca a task.** Nada de "a revisão pediu", "a fatia 28 mudou". Citar o documento (`§4`, `decisão 14`), nunca re-argumentar.
- **NUNCA rodar `pnpm install --ignore-workspace`** — descarta as settings do `pnpm-workspace.yaml`, incluindo o `packageExtensions` de que este trabalho inteiro depende, sem emitir erro.
- Se o `pnpm` falhar com `ERR_PNPM_UNEXPECTED_STORE`, rodar com `--store-dir ~/.pnpm-store`.
- Node do shell precisa ser 24.19.0 (`engineStrict: true` recusa fora da faixa).

---

### Task 1: O classificador único (`layers.mjs`)

**Files:**
- Create: `tools/boundaries/layers.mjs`
- Create: `tools/boundaries/layers.spec.mjs`
- Modify: `vitest.config.ts` (o `UNIT_INCLUDE`)

**Interfaces:**
- Produces: `PURE`, `MODULE_INFRA`, `GLOBAL_INFRA`, `COMPOSITION`, `TEST` (strings de regex, não `RegExp`, porque o depcruise recebe string), `UNCLASSIFIED` e `classify(path): 'pure' | 'module-infra' | 'global-infra' | 'composition' | 'test' | 'unknown'`.

- [ ] **Step 1: Fazer o vitest enxergar `tools/`**

O projeto `unit` hoje inclui só `src/**/*.spec.ts`, e o CI roda `pnpm test:unit`, nunca `pnpm test`. Sem isto, todo teste deste plano é escrito e nunca executado.

Os testes desta fatia são `.mjs`, não `.ts`: o `include` do `tsconfig.json` cobre `src/`, `tests/` e dois arquivos de config, mas **não** `tools/`. Um `.spec.ts` ali ficaria fora do `pnpm typecheck` e importaria um `.mjs` sem declarações. Ferramenta em `.mjs` com JSDoc é o padrão que o `audit-scan.mjs` já estabelece neste repo.

Em `vitest.config.ts`, trocar:

```ts
const UNIT_INCLUDE = 'src/**/*.spec.ts'
```

por:

```ts
const UNIT_INCLUDE = ['src/**/*.spec.ts', 'tools/**/*.spec.mjs']
```

e, na definição do projeto, `include: UNIT_INCLUDE` (era `include: [UNIT_INCLUDE]`).

- [ ] **Step 2: Escrever o teste que falha**

`tools/boundaries/layers.spec.mjs`:

```ts
import { describe, expect, it } from 'vitest'
import { classify } from './layers.mjs'

describe('classify', () => {
  it('classifies the pure layer of a module', () => {
    expect(classify('src/modules/auth/use-cases/login-user.ts')).toBe('pure')
    expect(classify('src/modules/auth/value-objects/email.ts')).toBe('pure')
    expect(classify('src/modules/auth/config.ts')).toBe('pure')
    expect(classify('src/shared/ports/clock.ts')).toBe('pure')
  })

  it('classifies infrastructure', () => {
    expect(classify('src/modules/auth/infra/drizzle/drizzle-users-repository.ts')).toBe('module-infra')
    expect(classify('src/infra/http/server.ts')).toBe('global-infra')
  })

  it('classifies composition', () => {
    expect(classify('src/main/app.ts')).toBe('composition')
    expect(classify('src/modules/auth/container.ts')).toBe('composition')
  })

  // ARCHITECTURE.md §2: `fixtures/` e `in-memory/` entram em `test` pelo nome
  // da pasta. Classificá-los como produção faria o portão aprovar o import que
  // ele existe para barrar.
  it('classifies test doubles by folder name, not by path', () => {
    expect(classify('src/modules/auth/use-cases/login-user.spec.ts')).toBe('test')
    expect(classify('tests/integration/register.spec.ts')).toBe('test')
    expect(classify('src/modules/auth/infra/in-memory/in-memory-users-repository.ts')).toBe('test')
    expect(classify('src/infra/config/fixtures/test-env.ts')).toBe('test')
  })

  it('reports a production file that no element covers', () => {
    expect(classify('src/modules/auth/helpers/format.ts')).toBe('unknown')
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run --project unit tools/boundaries/layers.spec.mjs`
Expected: FAIL — `Failed to load ./layers.mjs`

- [ ] **Step 4: Implementar**

`tools/boundaries/layers.mjs`:

```js
/**
 * The boundary table of ARCHITECTURE.md §2, expressed once.
 *
 * Both consumers read from here: `.dependency-cruiser.mjs` (the gate) and the
 * `architecture-audit` scanner (the review net). Patterns are strings, not
 * RegExp, because dependency-cruiser takes them as strings.
 */
export const PURE =
  '^src/(shared/|modules/[^/]+/(entities|value-objects|repositories|ports|use-cases|services|dtos|errors|notifications)/|modules/[^/]+/config\\.ts$)'
export const MODULE_INFRA = '^src/modules/[^/]+/infra/'
export const GLOBAL_INFRA = '^src/infra/'
export const COMPOSITION = '^(src/main/|src/modules/[^/]+/container\\.ts$)'
export const TEST = '(\\.spec\\.ts$|^tests/|/fixtures/|/in-memory/)'

const ELEMENTS = [
  // `test` comes first: a `.spec.ts` inside `use-cases/` is a test, not pure.
  // The order IS the precedence rule of §2.
  ['test', TEST],
  ['composition', COMPOSITION],
  ['module-infra', MODULE_INFRA],
  ['pure', PURE],
  ['global-infra', GLOBAL_INFRA],
]

export const UNCLASSIFIED = 'unknown'

/** @param {string} filePath repo-relative, POSIX separators. */
export function classify(filePath) {
  for (const [element, pattern] of ELEMENTS) {
    if (new RegExp(pattern).test(filePath)) return element
  }
  return UNCLASSIFIED
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run --project unit tools/boundaries/layers.spec.mjs`
Expected: PASS, 5 testes.

- [ ] **Step 6: Commit**

```bash
git add tools/boundaries/layers.mjs tools/boundaries/layers.spec.mjs vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(tools): express the §2 boundary table as one classifier

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: O depcruise instalado e o pré-voo do transpiler

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `pnpm-workspace.yaml`
- Create: `tools/boundaries/preflight.mjs`
- Create: `tools/boundaries/preflight.spec.mjs`

**Interfaces:**
- Produces: `assertTranspilerSupported(resolvedVersion, supportedRange)` — lança `Error` com mensagem explicativa quando a versão está fora da faixa; `readTranspilerState()` — retorna `{ resolvedVersion, supportedRange }` lendo do depcruise instalado.

**Por que esta task existe:** o `dependency-cruiser` 18.4.0 suporta `typescript >=2.0.0 <7.0.0`. Este projeto usa TypeScript 7. Com TS 7 ele cruza **zero** módulos e sai com **exit 0** — CI verde, enforcement nenhum. Medido, não deduzido.

- [ ] **Step 1: Instalar o depcruise**

```bash
pnpm add -D dependency-cruiser@18.4.0
```

Conferir que `package.json` gravou `"dependency-cruiser": "18.4.0"` — sem caret.

- [ ] **Step 2: Aninhar o TypeScript 6 sob o depcruise**

Acrescentar ao **fim** de `pnpm-workspace.yaml`:

```yaml
# dependency-cruiser supports `typescript >=2.0.0 <7.0.0` and resolves the
# compiler from its OWN directory, not the project root. With the project's
# TypeScript 7 it cruises zero modules and exits 0 — a green CI that enforces
# nothing (ARCHITECTURE.md §4). Nesting 6.0.3 here keeps the project on 7:
# `build`, `typecheck` and the editor are untouched. Remove this block when
# dependency-cruiser supports TypeScript 7.
packageExtensions:
  dependency-cruiser:
    dependencies:
      typescript: 6.0.3
```

Depois:

```bash
pnpm install
```

- [ ] **Step 3: Provar que o aninhamento pegou**

```bash
node -e 'const {createRequire}=require("node:module"),fs=require("fs");
const dc=fs.realpathSync("node_modules/dependency-cruiser");
console.log("root:", require("./node_modules/typescript/package.json").version);
console.log("depcruise sees:", createRequire(dc+"/src/x.mjs")("typescript/package.json").version);'
```

Expected: `root: 7.0.2` e `depcruise sees: 6.0.3`. Se as duas derem 7.0.2, o `packageExtensions` não foi aplicado — confirmar que ninguém rodou `pnpm install --ignore-workspace`.

- [ ] **Step 4: Escrever o teste que falha**

`tools/boundaries/preflight.spec.mjs`:

```ts
import { describe, expect, it } from 'vitest'
import { assertTranspilerSupported, readTranspilerState } from './preflight.mjs'

describe('assertTranspilerSupported', () => {
  it('accepts a TypeScript inside the supported range', () => {
    expect(() => assertTranspilerSupported('6.0.3', '>=2.0.0 <7.0.0')).not.toThrow()
  })

  it('rejects TypeScript 7, which makes dependency-cruiser cruise nothing and exit 0', () => {
    expect(() => assertTranspilerSupported('7.0.2', '>=2.0.0 <7.0.0')).toThrow(/7\.0\.2/)
  })

  it('rejects a missing TypeScript', () => {
    expect(() => assertTranspilerSupported(null, '>=2.0.0 <7.0.0')).toThrow()
  })
})

describe('readTranspilerState', () => {
  it('reads both sides from the installed dependency-cruiser', () => {
    const state = readTranspilerState()
    expect(state.supportedRange).toMatch(/^>=/)
    expect(state.resolvedVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is consistent: the nested TypeScript satisfies the range', () => {
    const { resolvedVersion, supportedRange } = readTranspilerState()
    expect(() => assertTranspilerSupported(resolvedVersion, supportedRange)).not.toThrow()
  })
})
```

- [ ] **Step 5: Rodar e ver falhar**

Run: `pnpm vitest run --project unit tools/boundaries/preflight.spec.mjs`
Expected: FAIL — `Failed to load ./preflight.mjs`

- [ ] **Step 6: Implementar**

`tools/boundaries/preflight.mjs`:

```js
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { satisfies } from 'semver'

const DEPENDENCY_CRUISER_ENTRY = 'node_modules/dependency-cruiser'
const TRANSPILER = 'typescript'
const DEPENDENCY_CRUISER_META = './meta.cjs'

/**
 * dependency-cruiser resolves the transpiler from its own directory, so the
 * check has to ask from there too — the project root can hold a different one.
 */
export function readTranspilerState() {
  const ownDirectory = realpathSync(DEPENDENCY_CRUISER_ENTRY)
  const requireFromCruiser = createRequire(`${ownDirectory}/src/entry.mjs`)
  const meta = requireFromCruiser(DEPENDENCY_CRUISER_META)

  let resolvedVersion = null
  try {
    resolvedVersion = requireFromCruiser(`${TRANSPILER}/package.json`).version
  } catch {
    resolvedVersion = null
  }

  return { resolvedVersion, supportedRange: meta.supportedTranspilers[TRANSPILER] }
}

/**
 * Outside the range, dependency-cruiser skips every TypeScript file and exits
 * 0: a green run that checked nothing (ARCHITECTURE.md §4, third trap).
 */
export function assertTranspilerSupported(resolvedVersion, supportedRange) {
  if (resolvedVersion !== null && satisfies(resolvedVersion, supportedRange)) return

  throw new Error(
    `dependency-cruiser needs typescript@${supportedRange} and resolves ` +
      `${resolvedVersion ?? 'none'}. It would cruise zero modules and exit 0. ` +
      'Check the `packageExtensions` block in pnpm-workspace.yaml.',
  )
}
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm vitest run --project unit tools/boundaries/preflight.spec.mjs`
Expected: PASS, 5 testes.

`semver` já vem como dependência transitiva do depcruise; se o import falhar, instalar com `pnpm add -D semver@7.7.2` e conferir o pin exato.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tools/boundaries/preflight.mjs tools/boundaries/preflight.spec.mjs
git commit -m "$(cat <<'EOF'
feat(tools): nest TypeScript 6 under dependency-cruiser and guard the version

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: As sete regras e as fixtures que as provam

**Files:**
- Create: `.dependency-cruiser.mjs`
- Create: `tools/boundaries/fixtures/` (árvore `.ts.txt`, listada abaixo)
- Create: `tools/boundaries/boundaries.spec.mjs`

**Interfaces:**
- Consumes: `PURE`, `MODULE_INFRA`, `GLOBAL_INFRA`, `TEST` da Task 1.
- Produces: a config na raiz, consumida pela Task 4 e pelo `pnpm lint`.

- [ ] **Step 1: Criar a árvore de fixtures**

Arquivos gravados como `.ts.txt` para que nem o `tsc` nem o Biome parseiem código que viola de propósito. Todos sob `tools/boundaries/fixtures/`, preservando o caminho que terão depois de materializados.

Alvos (precisam existir para tudo resolver — import não resolvido acusa a regra errada):

```
src/infra/observability/logger.ts.txt
  export const logger = { info: (_message: string) => {} }

src/modules/auth/ports/clock.ts.txt
  export interface Clock { now(): Date }

src/modules/auth/use-cases/get-user-profile.ts.txt
  export class GetUserProfileUseCase {
    async execute(_userId: string) { return { email: 'owner@example.com' } }
  }

src/modules/auth/container.ts.txt
  import { GetUserProfileUseCase } from '#modules/auth/use-cases/get-user-profile'
  export interface AuthContainer { getUserProfile: GetUserProfileUseCase }
  export const makeAuthContainer = (): AuthContainer => ({
    getUserProfile: new GetUserProfileUseCase(),
  })

src/modules/auth/infra/in-memory/in-memory-users-repository.ts.txt
  export class InMemoryUsersRepository { items: string[] = [] }

src/modules/billing/infra/drizzle/invoices-repository.ts.txt
  export class InvoicesRepository {}

src/modules/billing/container.ts.txt
  export interface BillingContainer { invoices: unknown }
```

Os oito negativos:

```
src/modules/auth/use-cases/n1-pure-to-infra.ts.txt
  import { logger } from '#infra/observability/logger'
  export const bad = () => logger.info('x')

src/modules/auth/use-cases/n2-pure-external.ts.txt
  import type { Pool } from 'pg'
  export const bad = (pool: Pool) => pool

src/modules/auth/infra/http/n3-cross-module-infra.ts.txt
  import { InvoicesRepository } from '#modules/billing/infra/drizzle/invoices-repository'
  export const bad = (repository: InvoicesRepository) => repository

src/modules/billing/use-cases/n4-cross-module-pure.ts.txt
  import { GetUserProfileUseCase } from '#modules/auth/use-cases/get-user-profile'
  export const bad = (useCase: GetUserProfileUseCase) => useCase

src/shared/n5-shared-knows-module.ts.txt
  import { GetUserProfileUseCase } from '#modules/auth/use-cases/get-user-profile'
  export const bad = (useCase: GetUserProfileUseCase) => useCase

src/infra/http/n6-global-infra-to-double.ts.txt
  import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
  export const bad = new InMemoryUsersRepository()

src/modules/auth/infra/http/n7-container-as-value.ts.txt
  import { makeAuthContainer } from '#modules/auth/container'
  export const bad = makeAuthContainer()

src/main/n8-unresolvable.ts.txt
  import { ghost } from '#modules/ghost/use-cases/ghost'
  export const bad = ghost
```

Os dois positivos:

```
src/modules/auth/use-cases/p1-reaches-double.spec.ts.txt
  import { InMemoryUsersRepository } from '#modules/auth/infra/in-memory/in-memory-users-repository'
  export const ok = new InMemoryUsersRepository()

src/main/adapters/p2-cross-module-adapter.ts.txt
  import type { AuthContainer } from '#modules/auth/container'
  import type { BillingContainer } from '#modules/billing/container'
  export const ok = (auth: AuthContainer, billing: BillingContainer) => [auth, billing]
```

**O n8 mora em `src/main/` de propósito:** em qualquer outro elemento, um import não resolvido acusa também a regra do elemento de origem, e o caso deixa de isolar a regra 7. Medido.

- [ ] **Step 2: Escrever o teste que falha**

`tools/boundaries/boundaries.spec.mjs`. O depcruise roda **uma vez** no `beforeAll` — 0,52s para os dez casos, em vez de dez invocações.

```ts
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

const FIXTURE_SUFFIX = '.txt'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPCRUISE_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'depcruise')
const EXPECTED_MODULE_COUNT = 17

/** fixture path (as dependency-cruiser reports it) -> the ONE rule it must trip. */
const NEGATIVES = {
  'src/modules/auth/use-cases/n1-pure-to-infra.ts': 'pure-imports-only-pure',
  'src/modules/auth/use-cases/n2-pure-external.ts': 'pure-external-only-zod',
  'src/modules/auth/infra/http/n3-cross-module-infra.ts': 'module-does-not-reach-module',
  'src/modules/billing/use-cases/n4-cross-module-pure.ts': 'module-does-not-reach-module',
  'src/shared/n5-shared-knows-module.ts': 'shared-does-not-know-modules',
  'src/infra/http/n6-global-infra-to-double.ts': 'global-infra-imports-pure-or-global-infra',
  'src/modules/auth/infra/http/n7-container-as-value.ts': 'own-container-type-only',
  'src/main/n8-unresolvable.ts': 'no-unresolvable-imports',
}

const POSITIVES = [
  'src/modules/auth/use-cases/p1-reaches-double.spec.ts',
  'src/main/adapters/p2-cross-module-adapter.ts',
]

let violationsByFile = new Map()
let summary = null
let workspace = ''

/** Renames every `*.ts.txt` back to `*.ts`, depth first. */
function materialize(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) materialize(full)
    else if (entry.endsWith(FIXTURE_SUFFIX)) renameSync(full, full.slice(0, -FIXTURE_SUFFIX.length))
  }
}

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'boundaries-'))
  cpSync(path.join(REPO_ROOT, 'tools', 'boundaries', 'fixtures'), workspace, { recursive: true })
  materialize(workspace)

  cpSync(path.join(REPO_ROOT, 'tsconfig.json'), path.join(workspace, 'tsconfig.json'))
  // The subpath imports map is what `#modules/*` resolves through, and the
  // `development` condition is what points it at src/ instead of dist/.
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({
      name: 'boundaries-fixtures',
      type: 'module',
      imports: {
        '#modules/*': { development: './src/modules/*.ts', default: './dist/modules/*.js' },
        '#shared/*': { development: './src/shared/*.ts', default: './dist/shared/*.js' },
        '#infra/*': { development: './src/infra/*.ts', default: './dist/infra/*.js' },
        '#main/*': { development: './src/main/*.ts', default: './dist/main/*.js' },
      },
    }),
  )
  // Without the real node_modules, `pg` does not resolve and n2 trips
  // `no-unresolvable-imports` instead of the allowlist rule.
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(workspace, 'node_modules'))

  const raw = execFileSync(
    DEPCRUISE_BIN,
    ['src', '--config', path.join(REPO_ROOT, '.dependency-cruiser.mjs'), '--output-type', 'json'],
    { cwd: workspace, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )

  const report = JSON.parse(raw)
  summary = report.summary
  for (const module of report.modules) {
    for (const dependency of module.dependencies) {
      for (const rule of dependency.rules ?? []) {
        if (!violationsByFile.has(module.source)) violationsByFile.set(module.source, new Set())
        violationsByFile.get(module.source).add(rule.name)
      }
    }
  }
})

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

describe('boundary rules', () => {
  // A config that cruises nothing reports zero violations and exits 0. This is
  // the assertion that tells "clean" from "blind" (ARCHITECTURE.md §4).
  it('actually cruised the fixture tree', () => {
    expect(summary.totalCruised).toBe(EXPECTED_MODULE_COUNT)
  })

  for (const [file, rule] of Object.entries(NEGATIVES)) {
    it(`trips ${rule} on ${path.basename(file)}`, () => {
      expect([...(violationsByFile.get(file) ?? [])]).toEqual([rule])
    })
  }

  for (const file of POSITIVES) {
    it(`leaves ${path.basename(file)} alone`, () => {
      expect([...(violationsByFile.get(file) ?? [])]).toEqual([])
    })
  }
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run --project unit tools/boundaries/boundaries.spec.mjs`
Expected: FAIL — a config `.dependency-cruiser.mjs` não existe.

- [ ] **Step 4: Escrever a config**

`.dependency-cruiser.mjs` na raiz:

```js
import { GLOBAL_INFRA, PURE, TEST } from './tools/boundaries/layers.mjs'

const ANY_MODULE = '^src/modules/'
/** `$1` refers to the capture group in the rule's `from.path`. */
const SAME_MODULE = '^src/modules/$1/'
const OWN_MODULE_INFRA = '^src/modules/([^/]+)/infra/'
const OWN_CONTAINER = '^src/modules/$1/container\\.ts$'
const SHARED = '^src/shared/'
const TYPE_ONLY = 'type-only'

const EXTERNAL = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'core']
// pnpm resolves a package to node_modules/.pnpm/<name>@<version>/node_modules/
// <name>/..., so anchoring at `^node_modules/` never matches, and anchoring on
// the version would break at the first upgrade.
const ZOD = '(^|/)node_modules/zod/'

export default {
  forbidden: [
    {
      name: 'pure-imports-only-pure',
      comment: 'ARCHITECTURE.md §2: the pure layer imports only pure.',
      severity: 'error',
      from: { path: PURE, pathNot: TEST },
      to: { pathNot: PURE, dependencyTypesNot: EXTERNAL },
    },
    {
      name: 'pure-external-only-zod',
      comment: 'Zod is the module config schema (§5). Anything else is the outside world.',
      severity: 'error',
      from: { path: PURE, pathNot: TEST },
      to: { dependencyTypes: EXTERNAL, pathNot: ZOD },
    },
    {
      name: 'module-does-not-reach-module',
      comment: 'A crossing goes through a port of the consumer, wired in src/main/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/', pathNot: TEST },
      to: { path: ANY_MODULE, pathNot: [SAME_MODULE, TEST] },
    },
    {
      name: 'shared-does-not-know-modules',
      comment: 'src/shared/ is transversal: it knows no module (§2).',
      severity: 'error',
      from: { path: SHARED, pathNot: TEST },
      to: { path: ANY_MODULE },
    },
    {
      name: 'global-infra-imports-pure-or-global-infra',
      severity: 'error',
      from: { path: GLOBAL_INFRA, pathNot: TEST },
      to: { pathNot: [PURE, GLOBAL_INFRA], dependencyTypesNot: EXTERNAL },
    },
    {
      name: 'own-container-type-only',
      comment: 'Decision 23 types the plugin by the slice it receives; as a value it would be a runtime edge.',
      severity: 'error',
      from: { path: OWN_MODULE_INFRA, pathNot: TEST },
      to: { path: OWN_CONTAINER, dependencyTypesNot: [TYPE_ONLY] },
    },
    {
      name: 'no-unresolvable-imports',
      comment: 'An unresolved import is invisible to every rule above.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // Without this, `import type` is invisible — 33% of this graph, and the
    // half of the boundary the rules exist to protect (§4, first trap).
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // Without `development`, `#modules/*` resolves to ./dist/*.js and the
      // rules, written against ^src/, stop matching (§4, second trap).
      conditionNames: ['development', 'import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.js', '.mts', '.cts'],
    },
    doNotFollow: { path: 'node_modules' },
  },
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run --project unit tools/boundaries/boundaries.spec.mjs`
Expected: PASS, 11 testes (1 de cobertura + 8 negativos + 2 positivos).

Se um negativo acusar **duas** regras, quase sempre é import não resolvido: conferir se o alvo existe na árvore de fixtures e se o symlink de `node_modules` foi criado.

- [ ] **Step 6: Rodar contra a árvore real e ver verde**

```bash
node_modules/.bin/depcruise src --config .dependency-cruiser.mjs --output-type err-long
```

Expected: `no dependency violations found (257 modules, 1003 dependencies cruised)`, exit 0. Se vier `0 modules`, o pré-voo da Task 2 vai explicar por quê — rodar `node -e "import('./tools/boundaries/preflight.mjs').then(m => console.log(m.readTranspilerState()))"`.

- [ ] **Step 7: Commit**

```bash
git add .dependency-cruiser.mjs tools/boundaries/fixtures tools/boundaries/boundaries.spec.mjs
git commit -m "$(cat <<'EOF'
feat(tools): turn the §2 boundary table into dependency-cruiser rules

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: O portão — cobertura, classificação total e `pnpm lint`

**Files:**
- Create: `tools/boundaries/check.mjs`
- Create: `tools/boundaries/coverage.mjs`
- Create: `tools/boundaries/coverage.spec.mjs`
- Modify: `package.json` (script `lint`)

**Interfaces:**
- Consumes: `classify` (Task 1), `assertTranspilerSupported`/`readTranspilerState` (Task 2), `.dependency-cruiser.mjs` (Task 3).
- Produces: `assertEveryFileCruised(cruisedSources, filesOnDisk)` e `assertEveryFileClassified(cruisedSources)`, ambas lançando `Error` com os caminhos faltantes; `tools/boundaries/check.mjs` como executável do `pnpm lint`.

- [ ] **Step 1: Escrever o teste que falha**

`tools/boundaries/coverage.spec.mjs`:

```ts
import { describe, expect, it } from 'vitest'
import { assertEveryFileClassified, assertEveryFileCruised } from './coverage.mjs'

describe('assertEveryFileCruised', () => {
  it('passes when the graph covers every file on disk', () => {
    const files = ['src/a.ts', 'src/b.ts']
    expect(() => assertEveryFileCruised(files, files)).not.toThrow()
  })

  // A file TypeScript 6 cannot parse silently drops out of the graph without
  // zeroing the count, so `totalCruised > 0` would not catch it.
  it('names the files that fell out of the graph', () => {
    expect(() => assertEveryFileCruised(['src/a.ts'], ['src/a.ts', 'src/b.ts'])).toThrow(/src\/b\.ts/)
  })
})

describe('assertEveryFileClassified', () => {
  it('passes when every production file lands in an element', () => {
    expect(() => assertEveryFileClassified(['src/modules/auth/use-cases/login-user.ts'])).not.toThrow()
  })

  it('names a production file that no element of §2 covers', () => {
    expect(() => assertEveryFileClassified(['src/modules/auth/helpers/format.ts'])).toThrow(/helpers\/format\.ts/)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit tools/boundaries/coverage.spec.mjs`
Expected: FAIL — `Failed to load ./coverage.mjs`

- [ ] **Step 3: Implementar**

`tools/boundaries/coverage.mjs`:

```js
import { UNCLASSIFIED, classify } from './layers.mjs'

/**
 * The only check that catches every silent-failure mode of §4 at once — and,
 * unlike `totalCruised > 0`, it also catches a partial loss.
 */
export function assertEveryFileCruised(cruisedSources, filesOnDisk) {
  const cruised = new Set(cruisedSources)
  const missing = filesOnDisk.filter((file) => !cruised.has(file))
  if (missing.length === 0) return

  throw new Error(
    `${missing.length} file(s) on disk never reached the dependency graph, ` +
      `so no rule was applied to them:\n  ${missing.join('\n  ')}`,
  )
}

/**
 * The gate's version of the scanner's LAYER-UNKNOWN: a production file that no
 * element of §2 classifies is a file no rule constrains.
 *
 * It reads the module list, not the dependency list: a file with no imports at
 * all never shows up on the `from` side of a dependency and would escape a
 * dependency-cruiser rule.
 */
export function assertEveryFileClassified(cruisedSources) {
  const unclassified = cruisedSources.filter((source) => classify(source) === UNCLASSIFIED)
  if (unclassified.length === 0) return

  throw new Error(
    `${unclassified.length} production file(s) match no element of the §2 table, ` +
      `so no boundary rule applies to them:\n  ${unclassified.join('\n  ')}`,
  )
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit tools/boundaries/coverage.spec.mjs`
Expected: PASS, 4 testes.

- [ ] **Step 5: Escrever o executável do portão**

`tools/boundaries/check.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { assertEveryFileClassified, assertEveryFileCruised } from './coverage.mjs'
import { assertTranspilerSupported, readTranspilerState } from './preflight.mjs'

const DEPCRUISE_BIN = 'node_modules/.bin/depcruise'
const CRUISED_ROOT = 'src'
const SOURCE_GLOB = 'src/**/*.ts'
const CONFIG = '.dependency-cruiser.mjs'
const MAX_REPORT_BYTES = 32 * 1024 * 1024
const FAILURE_EXIT_CODE = 1

const { resolvedVersion, supportedRange } = readTranspilerState()
assertTranspilerSupported(resolvedVersion, supportedRange)

const raw = execFileSync(
  DEPCRUISE_BIN,
  [CRUISED_ROOT, '--config', CONFIG, '--output-type', 'json'],
  { encoding: 'utf8', maxBuffer: MAX_REPORT_BYTES },
)
const report = JSON.parse(raw)

const cruisedSources = report.modules
  .map((module) => module.source)
  .filter((source) => source.startsWith(`${CRUISED_ROOT}/`))

assertEveryFileCruised(cruisedSources, globSync(SOURCE_GLOB))
assertEveryFileClassified(cruisedSources)

if (report.summary.error > 0) {
  execFileSync(DEPCRUISE_BIN, [CRUISED_ROOT, '--config', CONFIG, '--output-type', 'err-long'], {
    stdio: 'inherit',
  })
  process.exit(FAILURE_EXIT_CODE)
}
```

Nota para quem implementa: `execFileSync` lança quando o processo sai diferente de zero. Para a chamada JSON isso não acontece — o depcruise só sai 1 quando há violação, e aí o `report.summary.error` já foi lido. Envolver a primeira chamada num `try/catch` que reaproveita `error.stdout` como `raw` quando ele existe.

- [ ] **Step 6: Ligar no `pnpm lint`**

Em `package.json`:

```json
"lint": "biome check . && node tools/boundaries/check.mjs",
```

- [ ] **Step 7: Provar os dois lados**

```bash
pnpm lint                                   # exit 0
echo "import { logger } from '#infra/observability/logger'
export const bad = () => logger.info('x')" > src/modules/auth/use-cases/tmp-violation.ts
pnpm lint; echo "exit=$?"                   # exit 1, acusando pure-imports-only-pure
rm src/modules/auth/use-cases/tmp-violation.ts
pnpm lint                                   # exit 0 de novo
```

- [ ] **Step 8: Commit**

```bash
git add tools/boundaries/check.mjs tools/boundaries/coverage.mjs tools/boundaries/coverage.spec.mjs package.json
git commit -m "$(cat <<'EOF'
feat(tools): gate pnpm lint on the boundary, with a guard against silent passes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Alinhar o `audit-scan.mjs` ao portão

**Files:**
- Modify: `.claude/skills/architecture-audit/scripts/audit-scan.mjs` (a função `classify`, por volta da linha 161; o ramo `else if (crossModule)` de `module-infra`, por volta da linha 432)
- Modify: `.claude/skills/architecture-audit/tests/run-tests.mjs` (o mapa `EXPECTED`)
- Create: fixtures novas na árvore da skill, conforme abaixo

**Por que:** os dois verificadores convivem com papéis declarados — portão e rede de revisão —, e isso só funciona se eles não se contradisserem. Hoje divergem em dois pontos (§9 da spec): a linha `test` do §2, que o `classify` não implementa, e a severidade do `XMOD-PURE`.

**O que NÃO muda:** o `XMOD-INFRA` já acusa `infra` → `infra` em CRÍTICA, e o
`CONTAINER-VALUE` já exige `import type` no container do próprio módulo. Os dois
concordam com o portão sem emenda.

- [ ] **Step 1: Escrever a fixture que falha**

Criar `.claude/skills/architecture-audit/tests/fixtures/src/modules/billing/infra/http/cross-module-pure.ts.txt`:

```ts
import { ChargeCustomerUseCase } from '#modules/orders/use-cases/charge-customer'
export const handler = (useCase: ChargeCustomerUseCase) => useCase
```

Registrar em `EXPECTED` de `run-tests.mjs`, junto das outras entradas:

```js
'src/modules/billing/infra/http/cross-module-pure.ts': ['XMOD-PURE:1'],
```

- [ ] **Step 2: Rodar e ver o estado atual**

Run: `node .claude/skills/architecture-audit/tests/run-tests.mjs`
Expected: PASS — o `XMOD-PURE` já existe e já acusa na linha 1. A fixture entra
como regressão: ela trava a detecção antes de a severidade mudar.

- [ ] **Step 3: Subir o `XMOD-PURE` para CRÍTICA**

Em `audit-scan.mjs`, no ramo `else if (crossModule)` dentro de
`if (layer === 'module-infra')`, substituir:

```js
      } else if (crossModule) {
        addFinding(
          MEDIUM,
          'XMOD-PURE',
          file,
          line,
          BOUNDARY_RULE,
          `infra de '${own}' alcançando a camada pura de '${otherModule}': '${spec}'. Acoplamento entre domínios — confirme se é intencional.`,
          statement,
        )
      }
```

por:

```js
      } else if (crossModule) {
        addFinding(
          CRITICAL,
          'XMOD-PURE',
          file,
          line,
          `${BOUNDARY_RULE} (módulo não alcança módulo)`,
          `infra de '${own}' alcançando a camada pura de '${otherModule}': '${spec}'. O cruzamento se faz por uma porta do consumidor, com o adaptador em src/main/.`,
          statement,
        )
      }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node .claude/skills/architecture-audit/tests/run-tests.mjs`
Expected: `Todos os casos passaram.` O `EXPECTED` afirma `CHECK:linha`, não
severidade, então a subida não quebra o mapa — a fixture do Step 1 é o que
garante que o check continua existindo.

- [ ] **Step 5: Alinhar o `classify` à linha `test` do §2**

O `classify` do scanner hoje reconhece só `.spec.ts` e `tests/`. `fixtures/` e `in-memory/` ficam de fora, e o §2 diz o oposto, por escrito. Trocar a primeira linha da função por uma que também reconheça as duas pastas pelo nome:

```js
const TEST_BY_FOLDER = /(\.spec\.ts$|^tests\/|\/fixtures\/|\/in-memory\/)/

function classify(lp) {
  if (TEST_BY_FOLDER.test(lp)) return 'test'
  // ... o resto permanece
```

Deixar o comentário apontando o documento, sem re-argumentar:

```js
// §2: `fixtures/` e `in-memory/` entram em `test` pelo nome da pasta.
```

- [ ] **Step 6: Rodar os dois verificadores**

```bash
node .claude/skills/architecture-audit/tests/run-tests.mjs   # Todos os casos passaram.
node .claude/skills/architecture-audit/scripts/audit-scan.mjs --all   # CRÍTICA 0 ALTA 0 MÉDIA 0 BAIXA 0
pnpm lint                                                     # exit 0
```

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/architecture-audit
git commit -m "$(cat <<'EOF'
fix(audit): align the scanner with the §2 table and the boundary gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: A documentação, escrita depois do código

**Files:**
- Modify: `ARCHITECTURE.md` §2 (a tabela de fronteira e a seção do cruzamento), §4 (a tabela de regras e a seção "Quando a fronteira ganhar dente"), §11 (versões)
- Modify: `docs/DECISIONS.md` (decisão 46)

- [ ] **Step 1: §2 — fechar a ambiguidade do cruzamento**

Depois do parágrafo que hoje diz *"A linha `module-infra` também resolve o cruzamento entre módulos"*, acrescentar que **nenhum** elemento de um módulo alcança outro módulo — nem `infra/`, nem a camada pura —, que o cruzamento se faz por uma porta declarada na camada pura do consumidor, e que o adaptador mora em `src/main/`, único lugar onde módulo conhece módulo.

- [ ] **Step 2: §4 — a fronteira ganha dente**

- Na primeira tabela, acrescentar a linha da Fronteira com mecanismo `dependency-cruiser` e ✅.
- Na tabela de dívida, remover a linha da Fronteira.
- A seção "Quando a fronteira ganhar dente" vira "Como a fronteira tem dente": as três armadilhas passam a descrever a configuração que as desarma, cada uma apontando a linha correspondente do `.dependency-cruiser.mjs`.
- Corrigir os `~42%` para **33%** (335 de 1003 arestas), com a nota de que o número anterior foi medido em árvore anterior.
- Acrescentar o parágrafo dos papéis: portão e rede de revisão, ambos consumindo `tools/boundaries/layers.mjs`.
- Acrescentar a guarda: cobertura exata (229 = 229) e classificação total, mais forte que o `modules cruised === 0` que a seção propunha.

- [ ] **Step 3: §11 — o TypeScript aninhado**

Acrescentar o TypeScript 6.0.3 sob o depcruise: o que é, por que existe, e a condição de saída (o dia em que o depcruise suportar TS 7, o bloco do `pnpm-workspace.yaml` sai).

- [ ] **Step 4: Decisão 46**

Em `docs/DECISIONS.md`, no fim da §2, com o formato das vizinhas: o que foi decidido, o que foi medido, o que foi cortado e por quê (a regra redundante do container), a emenda ao §2 (módulo não alcança módulo, com a analogia de microsserviços), e os custos aceitos (segundo TypeScript, cerimônia no cruzamento, dois verificadores).

- [ ] **Step 5: Verificar que a documentação não mente**

```bash
pnpm lint && pnpm typecheck && pnpm test:unit
node .claude/skills/architecture-audit/scripts/audit-scan.mjs --all
grep -n "42%" ARCHITECTURE.md   # não deve sobrar nenhuma ocorrência na §4
```

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md docs/DECISIONS.md
git commit -m "$(cat <<'EOF'
docs: record that the boundary rule now has teeth

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verificação final

```bash
pnpm lint            # Biome + fronteira, exit 0
pnpm typecheck
pnpm test:unit       # inclui tools/**/*.spec.mjs
pnpm test:integration
pnpm build
node .claude/skills/architecture-audit/tests/run-tests.mjs
node .claude/skills/architecture-audit/scripts/audit-scan.mjs --all
```
