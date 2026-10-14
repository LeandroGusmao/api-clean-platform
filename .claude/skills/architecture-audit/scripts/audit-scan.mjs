#!/usr/bin/env node
// Deterministic pass of the architecture audit: boundary violations, leak
// vectors and convention breaks that a regex can prove. Zero dependencies —
// it runs on the repo's Node without an install step.
//
// Everything a regex CANNOT prove (declared status codes, whether a response
// schema exposes a secret, whether a comment still tells the truth) is the
// reviewer's job. See ../references/checks.md.
//
// Usage:
//   node audit-scan.mjs                 # working-tree changes vs HEAD, else everything
//   node audit-scan.mjs --base main     # files changed against a ref
//   node audit-scan.mjs --all           # whole src/ + tests/ tree
//   node audit-scan.mjs <path>...       # explicit files or directories
//   --json      machine-readable output
//   --strict    exit 2 on CRITICAL, 1 on HIGH/MEDIUM (for CI gating)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const [CRITICAL, HIGH, MEDIUM] = SEVERITIES

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts']
const SCAN_ROOTS = ['src', 'tests']
const ENV_READER = 'src/infra/config/env.ts'
/**
 * Matched by pattern, not by literal path: the central handler has already moved
 * from `http/` to `http/errors/` once, and an exemption pinned to the old path
 * flags again the only file that is allowed to log the failure.
 */
const CENTRAL_ERROR_HANDLER = /^src\/infra\/http\/(?:[^/]+\/)?error-handler\.ts$/
/** Boot paths that run before the pino logger exists. */
const CONSOLE_ALLOWED = ['src/infra/config/env.ts', 'src/infra/database/client.ts']
/** The file that DEFINES the taxonomy: the seven siblings extend AppError there. */
const ERROR_TAXONOMY = /^src\/shared\/errors\/app-error\.ts$/
const MAX_IMPORT_STATEMENT_LINES = 12
const SNIPPET_MAX_LENGTH = 110

/** Packages and subpaths that touch the outside world — banned in `pure`. */
const IO_SPECIFIERS = [
  /^node:/,
  /^fastify$/,
  /^@fastify\//,
  /^fastify-/,
  /^drizzle-orm/,
  /^drizzle-kit/,
  /^pg$/,
  /^pg-/,
  /^@types\/pg/,
  /^pino/,
  /^jose$/,
  /^jsonwebtoken$/,
  /^argon2$/,
  /^@node-rs\//,
  /^bcrypt/,
  /^ioredis$/,
  /^redis$/,
  /^axios$/,
  /^undici$/,
  /^got$/,
  /^node-fetch$/,
  /^nodemailer$/,
  /^dotenv/,
  /^(fs|path|os|crypto|http|https|net|dns|child_process|worker_threads|timers|stream|zlib|cluster|dgram|tls|readline|perf_hooks)$/,
]

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const strict = args.includes('--strict')

const findings = []

function addFinding(severity, check, file, line, rule, message, snippet) {
  findings.push({
    severity,
    check,
    file,
    line,
    rule,
    message,
    snippet: (snippet ?? '').trim().slice(0, SNIPPET_MAX_LENGTH),
  })
}

// ---------------------------------------------------------------- file scope

function git(subcommand) {
  try {
    return execFileSync('git', subcommand, { encoding: 'utf8' }).split('\n')
  } catch {
    return []
  }
}

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))
}

function expand(target) {
  if (!existsSync(target)) return []
  return statSync(target).isDirectory() ? walk(target) : [target]
}

function resolveScope() {
  const explicit = args.filter((arg) => !arg.startsWith('--'))
  const baseIndex = args.indexOf('--base')

  if (baseIndex !== -1) {
    const base = args[baseIndex + 1]
    return git(['diff', '--name-only', '--diff-filter=ACMR', base])
  }
  if (explicit.length > 0) return explicit.flatMap(expand)
  if (args.includes('--all')) {
    return [...SCAN_ROOTS.flatMap(expand), ...git(['ls-files', '*.md']).filter(Boolean)]
  }

  const changed = [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]
  const unique = [...new Set(changed.filter(Boolean))]

  return unique.length > 0 ? unique : SCAN_ROOTS.flatMap(expand)
}

// ------------------------------------------------------------ classification

/** Path relative to the repo root, so fixtures outside it classify the same. */
function layerPath(file) {
  const normalized = file.split(path.sep).join('/')
  for (const root of SCAN_ROOTS) {
    if (normalized.startsWith(`${root}/`)) return normalized
    const marker = normalized.lastIndexOf(`/${root}/`)
    if (marker !== -1) return normalized.slice(marker + 1)
  }
  return normalized
}

/**
 * `ports/`, not `providers/`: contract and implementation used to share a name
 * — `modules/<m>/providers/` versus `modules/<m>/infra/providers/` — and the tree
 * could not tell them apart without expanding both. The IMPLEMENTATION folders
 * stay under `infra/providers/`; only the contract side was renamed.
 */
const PURE_DIRECTORIES =
  /^(entities|value-objects|repositories|ports|use-cases|services|dtos|errors|emails)\//

// ARCHITECTURE §2: `fixtures/` and `in-memory/` are classified as `test` by folder name.
const TEST_ELEMENT = /(\.spec\.ts$|^tests\/|\/fixtures\/|\/in-memory\/)/

function classify(lp) {
  if (TEST_ELEMENT.test(lp)) return 'test'
  if (lp.startsWith('src/main/')) return 'composition'

  const inModule = /^src\/modules\/[^/]+\/(.*)$/.exec(lp)
  if (inModule) {
    const rest = inModule[1]
    if (rest === 'container.ts') return 'composition'
    if (rest.startsWith('infra/')) return 'module-infra'
    if (rest === 'config.ts' || PURE_DIRECTORIES.test(rest)) return 'pure'
    return 'unknown'
  }

  if (lp.startsWith('src/shared/')) return 'pure'
  if (lp.startsWith('src/infra/')) return 'global-infra'
  if (lp.startsWith('src/')) return 'unknown'

  return 'other'
}

function moduleOf(lp) {
  return /^src\/modules\/([^/]+)\//.exec(lp)?.[1] ?? null
}

// ------------------------------------------------------- comments and imports

/**
 * Blanks out comments while preserving offsets, line breaks and string
 * literals. Every regex below runs on this view, so prose that *mentions*
 * `process.env` or `new Date()` — which this repo's files do constantly — can
 * never be reported as code.
 */
function stripComments(source) {
  const out = source.split('')
  let state = 'code'
  let quote = ''
  let index = 0

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (state === 'code') {
      if (char === '/' && next === '/') {
        out[index] = ' '
        out[index + 1] = ' '
        state = 'line'
        index += 2
      } else if (char === '/' && next === '*') {
        out[index] = ' '
        out[index + 1] = ' '
        state = 'block'
        index += 2
      } else {
        if (char === '"' || char === "'" || char === '`') {
          state = 'string'
          quote = char
        }
        index += 1
      }
      continue
    }

    if (state === 'line') {
      if (char === '\n') state = 'code'
      else out[index] = ' '
      index += 1
      continue
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        out[index] = ' '
        out[index + 1] = ' '
        state = 'code'
        index += 2
      } else {
        if (char !== '\n') out[index] = ' '
        index += 1
      }
      continue
    }

    // string
    if (char === '\\') index += 2
    else {
      if (char === quote || (char === '\n' && quote !== '`')) state = 'code'
      index += 1
    }
  }

  return out.join('')
}

const IMPORT_START = /^import\b|^export\s+(?:\*|\{|type\s*\{)/
const FROM_SPECIFIER = /from\s*['"]([^'"]+)['"]/
const BARE_IMPORT = /^import\s*['"]([^'"]+)['"]/
const TYPE_ONLY = /^(?:import|export)\s+type\b/

function extractImports(lines) {
  const imports = []
  let buffer = null

  lines.forEach((raw, index) => {
    const text = raw.trim()
    if (buffer === null) {
      if (!IMPORT_START.test(text)) return
      buffer = { line: index + 1, text, lines: 1 }
    } else {
      buffer.text += ` ${text}`
      buffer.lines += 1
    }

    const match = FROM_SPECIFIER.exec(buffer.text) ?? BARE_IMPORT.exec(buffer.text)
    if (match) {
      imports.push({
        line: buffer.line,
        spec: match[1],
        typeOnly: TYPE_ONLY.test(buffer.text),
        statement: buffer.text,
      })
      buffer = null
    } else if (buffer.lines > MAX_IMPORT_STATEMENT_LINES) {
      buffer = null
    }
  })

  // Runtime loads bypass the static import list entirely.
  lines.forEach((raw, index) => {
    const dynamic = /(?:\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/.exec(raw)
    if (dynamic) {
      imports.push({
        line: index + 1,
        spec: dynamic[1],
        typeOnly: false,
        statement: raw.trim(),
      })
    }
  })

  return imports
}

// -------------------------------------------------------------------- checks

const BOUNDARY_RULE = 'ARCHITECTURE §2 — boundary rule'

function checkImports(file, lp, layer, imports) {
  const own = moduleOf(lp)

  for (const { line, spec, typeOnly, statement } of imports) {
    const otherModule = /^#modules\/([^/]+)\//.exec(spec)?.[1] ?? null
    const crossModule = otherModule !== null && otherModule !== own
    const isContainer = /^#modules\/[^/]+\/container$/.test(spec)

    if (spec.startsWith('.')) {
      if (spec.startsWith('../') && layer !== 'test') {
        addFinding(
          HIGH,
          'IMPORT-PARENT',
          file,
          line,
          'ARCHITECTURE §3 — imports',
          `Relative import climbing out of the folder: '${spec}'. Across branches use a subpath import (#modules/…, #shared/…, #infra/…).`,
          statement,
        )
      }
      if (!/\.(js|json)$/.test(spec)) {
        addFinding(
          HIGH,
          'IMPORT-EXT',
          file,
          line,
          'ARCHITECTURE §3 — ESM nodenext',
          `Relative import without the .js extension: '${spec}'. tsc fails with TS2835.`,
          statement,
        )
      }
    }

    if (/(^|\/)src\//.test(spec) || /(^|\/)dist\//.test(spec)) {
      addFinding(
        HIGH,
        'IMPORT-DEEP',
        file,
        line,
        'ARCHITECTURE §3 — imports',
        `Path pointing into the source/output tree: '${spec}'.`,
        statement,
      )
    }

    if (layer === 'pure') {
      if (IO_SPECIFIERS.some((pattern) => pattern.test(spec))) {
        addFinding(
          CRITICAL,
          'PURE-IO',
          file,
          line,
          `${BOUNDARY_RULE} (pure only imports pure)`,
          `Pure layer importing code that touches the outside world: '${spec}'. The contract comes in through an interface; the adapter lives in infra/.`,
          statement,
        )
      }
      if (spec.startsWith('#infra/') || spec.startsWith('#main/')) {
        addFinding(
          CRITICAL,
          'PURE-IO',
          file,
          line,
          `${BOUNDARY_RULE} (pure only imports pure)`,
          `Pure layer importing ${spec.startsWith('#main/') ? 'composition' : 'infra'}: '${spec}'.`,
          statement,
        )
      }
      if (isContainer) {
        addFinding(
          HIGH,
          'PURE-CONTAINER',
          file,
          line,
          `${BOUNDARY_RULE} (who may import composition)`,
          `Pure layer reaching a container: '${spec}'. Only main/** (value) and the module's own infra/ (import type) may.`,
          statement,
        )
      }
      if (lp.startsWith('src/shared/') && spec.startsWith('#modules/')) {
        addFinding(
          CRITICAL,
          'SHARED-XMOD',
          file,
          line,
          BOUNDARY_RULE,
          `src/shared/ is cross-cutting and must not know any module: '${spec}'.`,
          statement,
        )
      }
      if (crossModule && !lp.startsWith('src/shared/')) {
        addFinding(
          spec.includes('/infra/') ? CRITICAL : MEDIUM,
          'PURE-XMOD',
          file,
          line,
          BOUNDARY_RULE,
          `Pure layer of '${own}' importing module '${otherModule}': '${spec}'.`,
          statement,
        )
      }
    }

    if (layer === 'module-infra') {
      if (crossModule && spec.includes('/infra/')) {
        addFinding(
          CRITICAL,
          'XMOD-INFRA',
          file,
          line,
          `${BOUNDARY_RULE} (module-infra only reaches its own infra)`,
          `infra of '${own}' importing the infra of '${otherModule}': '${spec}'.`,
          statement,
        )
      } else if (crossModule && isContainer) {
        addFinding(
          HIGH,
          'XMOD-CONTAINER',
          file,
          line,
          `${BOUNDARY_RULE} (who may import composition)`,
          `infra of '${own}' importing the container of '${otherModule}': '${spec}'.`,
          statement,
        )
      } else if (crossModule) {
        addFinding(
          CRITICAL,
          'XMOD-PURE',
          file,
          line,
          `${BOUNDARY_RULE} (a module does not reach another module)`,
          `infra of '${own}' reaching the pure layer of '${otherModule}': '${spec}'. The crossing goes through a port owned by the consumer, with the adapter in src/main/.`,
          statement,
        )
      }
      if (isContainer && !crossModule && !typeOnly) {
        addFinding(
          HIGH,
          'CONTAINER-VALUE',
          file,
          line,
          `${BOUNDARY_RULE} (who may import composition)`,
          `A module's infra may import its own container only as a TYPE: use 'import type'.`,
          statement,
        )
      }
      if (spec.startsWith('#main/')) {
        addFinding(
          CRITICAL,
          'INFRA-MAIN',
          file,
          line,
          BOUNDARY_RULE,
          `infra importing the composition root: '${spec}'.`,
          statement,
        )
      }
    }

    if (layer === 'global-infra' && spec.startsWith('#modules/')) {
      // `#modules/<m>/config` is deliberate: the boundary table classifies a
      // module's config.ts as `pure`, and env.ts merges those schemas at boot.
      // Everything else is graded by what it reaches.
      const isModuleConfig = /^#modules\/[^/]+\/config$/.test(spec)

      if (spec.includes('/infra/') || isContainer) {
        addFinding(
          CRITICAL,
          'GLOBAL-INFRA-XMOD',
          file,
          line,
          `${BOUNDARY_RULE} (global-infra imports pure and global-infra)`,
          `src/infra/ is infra with NO owner and reached the ${isContainer ? 'container' : 'infra'} of '${otherModule}': '${spec}'. Inject the contract instead (see auth-guard.ts).`,
          statement,
        )
      } else if (!isModuleConfig) {
        addFinding(
          MEDIUM,
          'GLOBAL-INFRA-XMOD',
          file,
          line,
          BOUNDARY_RULE,
          `src/infra/ knowing the domain of '${otherModule}': '${spec}'. The table allows pure, but ownerless infra coupled to a module needs a justification — auth-guard exists precisely to avoid this.`,
          statement,
        )
      }
    }

    if (layer === 'global-infra') {
      if (spec.startsWith('#main/')) {
        addFinding(
          CRITICAL,
          'INFRA-MAIN',
          file,
          line,
          BOUNDARY_RULE,
          `infra importing the composition root: '${spec}'.`,
          statement,
        )
      }
    }
  }
}

const LINE_RULES = [
  {
    check: 'ENV',
    severity: CRITICAL,
    rule: 'R6 — only env.ts reads process.env',
    pattern: /\bprocess\.env\b/,
    layers: ['pure', 'module-infra', 'global-infra', 'composition'],
    skipFiles: [ENV_READER],
    message:
      'Direct read of process.env. The env comes in validated by env.ts and arrives injected; the module declares its Zod schema in config.ts.',
  },
  {
    check: 'TEST-ENV',
    severity: HIGH,
    rule: 'ARCHITECTURE §9 — no test reads process.env',
    pattern: /\bprocess\.env\b/,
    layers: ['test'],
    message:
      'Test reading process.env. The suite env is injected through test.env in vitest.config.ts.',
  },
  {
    check: 'R7-CLOCK',
    severity: HIGH,
    rule: 'R7 — the pure layer produces no non-deterministic value',
    pattern: /new Date\(\s*\)|\bDate\.now\s*\(/,
    layers: ['pure'],
    message:
      'Clock read directly in the pure layer. Time comes in through IClock (#shared/ports/clock).',
  },
  {
    check: 'R7-RANDOM',
    severity: HIGH,
    rule: 'R7 — the pure layer produces no non-deterministic value',
    pattern:
      /\bMath\.random\s*\(|\brandomUUID\s*\(|\brandomBytes\s*\(|\bperformance\.now\s*\(|\bprocess\.hrtime\b/,
    layers: ['pure'],
    message:
      'Randomness generated in the pure layer. Identity comes in through IIdGenerator (#shared/ports/id-generator); a cryptographic secret is an infra provider.',
  },
  {
    check: 'DRIVER-LOG',
    severity: CRITICAL,
    rule: 'ARCHITECTURE §6 — driver errors do not leave infra/',
    pattern: /\.log\.\w+\s*\(|\bconsole\.\w+\s*\(/,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Log inside the Drizzle layer. The driver error carries the bound parameters (the password hash among them) in its message, its stack and its params. Translate with toPersistenceError and leave the logging to the error-handler.',
  },
  {
    check: 'DRIVER-RAW',
    severity: CRITICAL,
    rule: 'ARCHITECTURE §6 — driver errors do not leave infra/',
    pattern:
      /\b(?:error|err)\.(?:message|stack|params|detail)\b|JSON\.stringify\s*\(\s*(?:error|err)\b/,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Driver error property being read/propagated. message, stack and params are three carriers of the same secret.',
  },
  {
    check: 'DRIZZLE-QUERY-API',
    severity: MEDIUM,
    rule: 'R1 — the repository uses only the Drizzle core API',
    pattern: /\bdb\.query\./,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Use of the relational query API (db.query.*). The repository uses only the core API (select/insert/update/delete).',
  },
  {
    check: 'LOG-OBJECT',
    severity: HIGH,
    rule: 'ARCHITECTURE §4/§5 — log a chosen field, never a whole object',
    pattern:
      /\.log\.\w+\s*\(\s*\{[^}]*\b(?:request|req|reply|res|body|payload|headers|user|entity|command|input|row|rows|credentials)\b/,
    // `test` is included: the boundary table exempts tests from IMPORT rules, not
    // from secrets. A spec that logs a whole object leaks just the same.
    layers: ['pure', 'module-infra', 'global-infra', 'composition', 'test'],
    message:
      'Whole request/entity object in the log. pino redact is not recursive and the default serializer does not cover this — log the chosen field.',
  },
  {
    check: 'LOG-ERR-MODULE',
    severity: HIGH,
    rule: 'ARCHITECTURE §8 — the central error-handler is what logs the failure',
    pattern: /\.log\.\w+\s*\(\s*\{?\s*(?:err|error)\b/,
    layers: ['module-infra'],
    skipFiles: [CENTRAL_ERROR_HANDLER],
    message:
      'Error logged outside the central error-handler. It already logs with the traceId; a local log duplicates the line and escapes sanitization when the object is the driver one.',
  },
  {
    check: 'CONSOLE',
    severity: MEDIUM,
    rule: "ARCHITECTURE §5 — the logger is Fastify's pino",
    pattern: /\bconsole\.\w+\s*\(/,
    layers: ['pure', 'module-infra', 'test'],
    skipFiles: CONSOLE_ALLOWED,
    message: 'console.* in place of the request logger. No traceId, no redact, no level.',
  },
  {
    check: 'SECRET-HTTP',
    severity: CRITICAL,
    rule: 'Security — a secret does not cross the HTTP boundary',
    pattern:
      /\bJWT_SECRET\b|\bSECRET_KEY\b|\bPRIVATE_KEY\b|\bpasswordHash\b|\bpassword_hash\b/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message:
      'Hash/secret referenced in the HTTP layer. The use case read model already delivers the publishable shape — confirm this does not end up in a response schema or in send().',
  },
  {
    check: 'ZOD-DATE',
    severity: MEDIUM,
    rule: 'ARCHITECTURE §7 — a date in a response is z.date()',
    pattern: /z\.iso\.datetime\s*\(/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message:
      'z.iso.datetime() in an endpoint. In a RESPONSE schema use z.date(): the serializer emits ISO on its own and the handler stops calling .toISOString(). (In a request schema, z.iso.datetime() is legitimate.)',
  },
  {
    check: 'HANDLER-CATCH',
    severity: MEDIUM,
    rule: 'ARCHITECTURE §8 — the endpoint has no try/catch',
    pattern: /\btry\s*\{/,
    pathIncludes: '/infra/http/endpoints/',
    layers: ['module-infra', 'global-infra'],
    message:
      'try/catch in the endpoint. The use case only throws and the error-handler translates it into a status; catching here is where the error envelope starts to diverge.',
  },
  {
    check: 'HTTP-MAGIC',
    severity: MEDIUM,
    rule: 'CLAUDE.md — no magic number',
    pattern: /\.(?:status|code)\s*\(\s*\d{3}\s*\)|[{,(]\s*[1-5]\d\d\s*:/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message: 'Inline HTTP status. Use the module constant (infra/http/constants.ts).',
  },
  {
    check: 'ERROR-BASE',
    severity: HIGH,
    rule: 'ARCHITECTURE §8 — the seven categories are siblings',
    pattern: /class\s+\w+\s+extends\s+AppError\b/,
    layers: ['pure', 'module-infra', 'global-infra'],
    skipFiles: [ERROR_TAXONOMY],
    message:
      'Error extending AppError directly, outside the seven categories. The error-handler matches by instanceof on the seven; anything outside falls into the generic branch and answers 500 — not the intended status. Extend NotFoundError, ConflictError, UnauthorizedError, ForbiddenError, ValidationError, BusinessRuleError or TransientError.',
  },
  {
    check: 'TEST-ONLY',
    severity: MEDIUM,
    rule: 'Suite discipline',
    pattern: /\b(?:describe|it|test)\.only\s*\(/,
    layers: ['test'],
    message: 'A committed .only silences the rest of the suite.',
  },
]

function checkLines(file, lp, layer, lines) {
  for (const rule of LINE_RULES) {
    if (!rule.layers.includes(layer)) continue
    if (rule.pathIncludes && !lp.includes(rule.pathIncludes)) continue
    const exempt = rule.skipFiles?.some((entry) =>
      entry instanceof RegExp ? entry.test(lp) : entry === lp,
    )
    if (exempt) continue

    lines.forEach((text, index) => {
      if (rule.pattern.test(text)) {
        addFinding(
          rule.severity,
          rule.check,
          file,
          index + 1,
          rule.rule,
          rule.message,
          text,
        )
      }
    })
  }
}

/**
 * A `catch` in the Drizzle layer that never reaches `toPersistenceError` either
 * re-throws the driver's object or swallows the failure. Both are reportable;
 * which one it is, the reviewer reads off the snippet.
 */
function checkRepositoryCatch(file, lp, layer, stripped) {
  if (layer !== 'module-infra' || !lp.includes('/infra/drizzle/')) return

  const catchPattern = /catch\s*(?:\(\s*(\w+)\s*\))?\s*\{/g

  for (const match of stripped.matchAll(catchPattern)) {
    const binding = match[1]
    const body = braceBody(stripped, match.index + match[0].length - 1)
    const line = stripped.slice(0, match.index).split('\n').length

    if (binding && new RegExp(`throw\\s+${binding}\\b`).test(body)) {
      addFinding(
        CRITICAL,
        'DRIVER-RETHROW',
        file,
        line,
        'ARCHITECTURE §6 — driver errors do not leave infra/',
        `Repository rethrows the raw driver error ('throw ${binding}'). It attaches every bound parameter — including the password hash — to its own message. Translate it: 'throw toPersistenceError(${binding})'.`,
        body.split('\n').find((l) => l.includes(`throw ${binding}`)) ?? '',
      )
    } else if (!body.includes('toPersistenceError')) {
      addFinding(
        HIGH,
        'CATCH-UNSANITIZED',
        file,
        line,
        'ARCHITECTURE §6 — driver errors do not leave infra/',
        'catch in the Drizzle layer without toPersistenceError: either the driver error escapes some other way, or the failure is being swallowed.',
        body.split('\n')[0] ?? '',
      )
    }
  }
}

/** Body of the block whose opening brace sits at `openIndex`. */
function braceBody(source, openIndex) {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
  return source.slice(openIndex + 1)
}

/** Parameter names that carry "whose resource this is". */
const OWNERSHIP_PARAMS = /^(?:userId|ownerId|tenantId|accountId|principalId|actorId)$/

/**
 * A use case that RECEIVES the owner and never uses it does not filter by owner:
 * the lookup is by global id, and whoever discovers another user's id reads that
 * user's resource. The parameter appearing only once in the file — its own
 * declaration — is exactly that signature.
 */
function checkOwnershipParams(file, lp, layer, stripped) {
  if (layer !== 'pure' || !lp.includes('/use-cases/')) return

  for (const match of stripped.matchAll(/execute\s*\(([^)]*)\)/g)) {
    const line = stripped.slice(0, match.index).split('\n').length

    for (const parameter of match[1].split(',')) {
      const name = parameter.trim().split(/[:?]/)[0].trim()
      if (!OWNERSHIP_PARAMS.test(name)) continue

      const uses = stripped.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
      if (uses > 1) continue

      addFinding(
        HIGH,
        'OWNERSHIP-UNUSED',
        file,
        line,
        'Security — ownership authorization (IDOR)',
        `'${name}' is received by execute() and never used: the query does not filter by owner. Whoever obtains another user's id reaches that user's resource.`,
        match[0],
      )
    }
  }
}

const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const FENCE_DELIMITER = /^\s*(?:```|~~~)/
const ABSOLUTE_SPECIFIER = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i

/**
 * Broken relative link in a tracked `.md`. It exists because of two real cases:
 * a folder move left four links pointing at nothing, and the documentation kept
 * describing a path that no longer existed. It is the only form of "document
 * that lies" a machine can prove.
 */
function checkMarkdownLinks(file) {
  const directory = path.dirname(file)
  let insideFence = false

  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (FENCE_DELIMITER.test(text)) {
        insideFence = !insideFence
        return
      }
      if (insideFence) return

      for (const match of text.matchAll(MARKDOWN_LINK)) {
        // A bare anchor (`#section`) and an absolute target are skipped: the first
        // is not a path, and the second depends on a root this script does not know.
        const [target] = match[1].split('#')
        if (target === '' || ABSOLUTE_SPECIFIER.test(target)) continue
        if (existsSync(path.resolve(directory, target))) continue

        addFinding(
          MEDIUM,
          'MD-LINK',
          file,
          index + 1,
          'Tracked documentation points at a file that exists',
          `Broken relative link: '${target}'. After a file is moved, the link stays green in the diff and dead on reading.`,
          text,
        )
      }
    })
}

function checkPackageJson(file) {
  const content = readFileSync(file, 'utf8')
  content.split('\n').forEach((text, index) => {
    if (/"\s*:\s*"[\^~]\d/.test(text)) {
      addFinding(
        HIGH,
        'DEP-RANGE',
        file,
        index + 1,
        'ARCHITECTURE §11 — every dependency at an exact version',
        'Version range (^ or ~). Two apps generated from the same commit would resolve different trees.',
        text,
      )
    }
  })
}

// ----------------------------------------------------------------------- run

const scope = resolveScope()
const scanned = []

for (const file of scope) {
  if (path.basename(file) === 'package.json' && existsSync(file)) {
    checkPackageJson(file)
    scanned.push(file)
    continue
  }
  if (file.endsWith('.md') && existsSync(file)) {
    checkMarkdownLinks(file)
    scanned.push(file)
    continue
  }
  if (!isSourceFile(file) || !existsSync(file)) continue

  const lp = layerPath(file)
  const layer = classify(lp)
  if (layer === 'other') continue

  scanned.push(file)

  const stripped = stripComments(readFileSync(file, 'utf8'))
  const lines = stripped.split('\n')

  if (layer === 'unknown') {
    addFinding(
      MEDIUM,
      'LAYER-UNKNOWN',
      file,
      1,
      'ARCHITECTURE §2 — boundary rule',
      'File in src/ that falls into no row of the boundary table. Either it belongs in one of the named folders, or the table needs a new row (a conscious, documented decision).',
      lp,
    )
  }

  checkImports(file, lp, layer, extractImports(lines))
  checkLines(file, lp, layer, lines)
  checkRepositoryCatch(file, lp, layer, stripped)
  checkOwnershipParams(file, lp, layer, stripped)
}

findings.sort(
  (a, b) =>
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line,
)

const counts = Object.fromEntries(
  SEVERITIES.map((severity) => [
    severity,
    findings.filter((f) => f.severity === severity).length,
  ]),
)

if (asJson) {
  console.log(JSON.stringify({ scanned: scanned.length, counts, findings }, null, 2))
} else {
  for (const finding of findings) {
    console.log(
      `${finding.severity.padEnd(8)} ${finding.check.padEnd(18)} ${finding.file}:${finding.line}`,
    )
    console.log(`         ${finding.rule}`)
    console.log(`         ${finding.message}`)
    if (finding.snippet) console.log(`         > ${finding.snippet}`)
    console.log('')
  }
  const summary = SEVERITIES.map((severity) => `${severity} ${counts[severity]}`).join(
    '  ',
  )
  console.log(`${scanned.length} file(s) scanned — ${summary}`)
}

if (strict) {
  if (counts[CRITICAL] > 0) process.exit(2)
  if (counts[HIGH] > 0 || counts[MEDIUM] > 0) process.exit(1)
}
