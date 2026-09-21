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
//   --strict    exit 2 on CRÍTICA, 1 on ALTA/MÉDIA (for CI gating)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SEVERITIES = ['CRÍTICA', 'ALTA', 'MÉDIA', 'BAIXA']
const [CRITICAL, HIGH, MEDIUM] = SEVERITIES

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts']
const SCAN_ROOTS = ['src', 'tests']
const ENV_READER = 'src/infra/config/env.ts'
/**
 * Casado por padrão, não por caminho literal: o handler central já mudou de
 * `http/` para `http/errors/` uma vez, e uma isenção presa ao caminho antigo
 * volta a acusar o único arquivo que tem permissão de logar a falha.
 */
const CENTRAL_ERROR_HANDLER = /^src\/infra\/http\/(?:[^/]+\/)?error-handler\.ts$/
/** Boot paths that run before the pino logger exists. */
const CONSOLE_ALLOWED = ['src/infra/config/env.ts', 'src/infra/database/client.ts']
/** O arquivo que DEFINE a taxonomia: as seis irmãs estendem AppError ali. */
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
 * `ports/`, não `providers/`: contrato e implementação chamavam-se a mesma coisa
 * — `modules/<m>/providers/` contra `modules/<m>/infra/providers/` — e a árvore
 * não os distinguia sem expandir os dois. As pastas de IMPLEMENTAÇÃO seguem
 * `infra/providers/`; só o lado do contrato foi renomeado.
 */
const PURE_DIRECTORIES =
  /^(entities|value-objects|repositories|ports|use-cases|services|dtos|errors|notifications)\//

// §2: `fixtures/` e `in-memory/` entram em `test` pelo nome da pasta.
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

const BOUNDARY_RULE = 'ARCHITECTURE §2 — regra de fronteira'

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
          `Relativo subindo de pasta: '${spec}'. Entre galhos use subpath import (#modules/…, #shared/…, #infra/…).`,
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
          `Import relativo sem extensão .js: '${spec}'. O tsc falha com TS2835.`,
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
        `Caminho apontando para a árvore de saída/origem: '${spec}'.`,
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
          `${BOUNDARY_RULE} (pure só importa pure)`,
          `Camada pura importando código que toca o mundo externo: '${spec}'. O contrato entra por interface; o adapter mora em infra/.`,
          statement,
        )
      }
      if (spec.startsWith('#infra/') || spec.startsWith('#main/')) {
        addFinding(
          CRITICAL,
          'PURE-IO',
          file,
          line,
          `${BOUNDARY_RULE} (pure só importa pure)`,
          `Camada pura importando ${spec.startsWith('#main/') ? 'composition' : 'infra'}: '${spec}'.`,
          statement,
        )
      }
      if (isContainer) {
        addFinding(
          HIGH,
          'PURE-CONTAINER',
          file,
          line,
          `${BOUNDARY_RULE} (quem pode importar composition)`,
          `Camada pura alcançando um container: '${spec}'. Só main/** (valor) e o infra/ do próprio módulo (import type).`,
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
          `src/shared/ é transversal e não pode conhecer módulo nenhum: '${spec}'.`,
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
          `Camada pura de '${own}' importando o módulo '${otherModule}': '${spec}'.`,
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
          `${BOUNDARY_RULE} (module-infra só alcança o próprio infra)`,
          `infra de '${own}' importando o infra de '${otherModule}': '${spec}'.`,
          statement,
        )
      } else if (crossModule && isContainer) {
        addFinding(
          HIGH,
          'XMOD-CONTAINER',
          file,
          line,
          `${BOUNDARY_RULE} (quem pode importar composition)`,
          `infra de '${own}' importando o container de '${otherModule}': '${spec}'.`,
          statement,
        )
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
      if (isContainer && !crossModule && !typeOnly) {
        addFinding(
          HIGH,
          'CONTAINER-VALUE',
          file,
          line,
          `${BOUNDARY_RULE} (quem pode importar composition)`,
          `O infra do módulo só pode importar o próprio container como TIPO: use 'import type'.`,
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
          `infra importando o composition root: '${spec}'.`,
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
          `${BOUNDARY_RULE} (global-infra importa pure e global-infra)`,
          `src/infra/ é infra SEM dono e alcançou o ${isContainer ? 'container' : 'infra'} de '${otherModule}': '${spec}'. Injete o contrato (ver auth-guard.ts).`,
          statement,
        )
      } else if (!isModuleConfig) {
        addFinding(
          MEDIUM,
          'GLOBAL-INFRA-XMOD',
          file,
          line,
          BOUNDARY_RULE,
          `src/infra/ conhecendo o domínio de '${otherModule}': '${spec}'. A tabela permite pure, mas infra sem dono acoplada a um módulo pede justificativa — o auth-guard existe exatamente para evitar isso.`,
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
          `infra importando o composition root: '${spec}'.`,
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
    rule: 'R6 — só env.ts lê process.env',
    pattern: /\bprocess\.env\b/,
    layers: ['pure', 'module-infra', 'global-infra', 'composition'],
    skipFiles: [ENV_READER],
    message:
      'Leitura direta de process.env. A env entra validada por env.ts e chega injetada; o módulo declara seu schema Zod em config.ts.',
  },
  {
    check: 'TEST-ENV',
    severity: HIGH,
    rule: 'ARCHITECTURE §9 — nenhum teste lê process.env',
    pattern: /\bprocess\.env\b/,
    layers: ['test'],
    message:
      'Teste lendo process.env. A env da suíte é injetada em test.env no vitest.config.ts.',
  },
  {
    check: 'R7-CLOCK',
    severity: HIGH,
    rule: 'R7 — camada pura não produz valor não determinístico',
    pattern: /new Date\(\s*\)|\bDate\.now\s*\(/,
    layers: ['pure'],
    message:
      'Relógio lido direto na camada pura. O tempo entra por IClock (#shared/providers/clock).',
  },
  {
    check: 'R7-RANDOM',
    severity: HIGH,
    rule: 'R7 — camada pura não produz valor não determinístico',
    pattern:
      /\bMath\.random\s*\(|\brandomUUID\s*\(|\brandomBytes\s*\(|\bperformance\.now\s*\(|\bprocess\.hrtime\b/,
    layers: ['pure'],
    message:
      'Aleatoriedade gerada na camada pura. A identidade entra por IIdGenerator (#shared/providers/id-generator); segredo criptográfico é provider de infra.',
  },
  {
    check: 'DRIVER-LOG',
    severity: CRITICAL,
    rule: 'ARCHITECTURE §6 — erro de driver não sai do infra/',
    pattern: /\.log\.\w+\s*\(|\bconsole\.\w+\s*\(/,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Log dentro da camada Drizzle. O erro do driver carrega os parâmetros vinculados (o hash de senha entre eles) na message, na stack e em params. Traduza com toPersistenceError e deixe o log para o error-handler.',
  },
  {
    check: 'DRIVER-RAW',
    severity: CRITICAL,
    rule: 'ARCHITECTURE §6 — erro de driver não sai do infra/',
    pattern:
      /\b(?:error|err)\.(?:message|stack|params|detail)\b|JSON\.stringify\s*\(\s*(?:error|err)\b/,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Propriedade do erro do driver sendo lida/propagada. message, stack e params são três carregadores do mesmo segredo.',
  },
  {
    check: 'DRIZZLE-QUERY-API',
    severity: MEDIUM,
    rule: 'R1 — repositório usa só a API core do Drizzle',
    pattern: /\bdb\.query\./,
    pathIncludes: '/infra/drizzle/',
    layers: ['module-infra'],
    message:
      'Uso da relational query API (db.query.*). O repositório usa só a API core (select/insert/update/delete).',
  },
  {
    check: 'LOG-OBJECT',
    severity: HIGH,
    rule: 'ARCHITECTURE §4/§5 — logar campo escolhido, nunca objeto inteiro',
    pattern:
      /\.log\.\w+\s*\(\s*\{[^}]*\b(?:request|req|reply|res|body|payload|headers|user|entity|command|input|row|rows|credentials)\b/,
    // `test` incluído: a tabela de fronteira isenta teste de IMPORT, não de
    // segredo. Spec que loga objeto inteiro vaza igual.
    layers: ['pure', 'module-infra', 'global-infra', 'composition', 'test'],
    message:
      'Objeto inteiro de request/entidade no log. O redact do pino não é recursivo e o serializer padrão não cobre isto — logue o campo escolhido.',
  },
  {
    check: 'LOG-ERR-MODULE',
    severity: HIGH,
    rule: 'ARCHITECTURE §8 — o error-handler central é quem loga a falha',
    pattern: /\.log\.\w+\s*\(\s*\{?\s*(?:err|error)\b/,
    layers: ['module-infra'],
    skipFiles: [CENTRAL_ERROR_HANDLER],
    message:
      'Erro logado fora do error-handler central. Ele já loga com traceId; um log local duplica a linha e escapa da sanitização quando o objeto é o do driver.',
  },
  {
    check: 'CONSOLE',
    severity: MEDIUM,
    rule: 'ARCHITECTURE §5 — o logger é o pino do Fastify',
    pattern: /\bconsole\.\w+\s*\(/,
    layers: ['pure', 'module-infra', 'test'],
    skipFiles: CONSOLE_ALLOWED,
    message:
      'console.* no lugar do logger da request. Sem traceId, sem redact, sem nível.',
  },
  {
    check: 'SECRET-HTTP',
    severity: CRITICAL,
    rule: 'Segurança — segredo não atravessa a fronteira HTTP',
    pattern:
      /\bJWT_SECRET\b|\bSECRET_KEY\b|\bPRIVATE_KEY\b|\bpasswordHash\b|\bpassword_hash\b/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message:
      'Hash/segredo referenciado na camada HTTP. O read model do use case já entrega a forma publicável — confirme que isto não entra em schema de resposta nem em send().',
  },
  {
    check: 'ZOD-DATE',
    severity: MEDIUM,
    rule: 'ARCHITECTURE §7 — data em resposta é z.date()',
    pattern: /z\.iso\.datetime\s*\(/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message:
      'z.iso.datetime() em endpoint. Em schema de RESPOSTA use z.date(): o serializer emite ISO sozinho e o handler para de chamar .toISOString(). (Em schema de request, z.iso.datetime() é legítimo.)',
  },
  {
    check: 'HANDLER-CATCH',
    severity: MEDIUM,
    rule: 'ARCHITECTURE §8 — o endpoint não tem try/catch',
    pattern: /\btry\s*\{/,
    pathIncludes: '/infra/http/endpoints/',
    layers: ['module-infra', 'global-infra'],
    message:
      'try/catch no endpoint. O use case só faz throw e o error-handler traduz para status; capturar aqui é onde o envelope de erro começa a divergir.',
  },
  {
    check: 'HTTP-MAGIC',
    severity: MEDIUM,
    rule: 'CLAUDE.md — sem magic number',
    pattern: /\.(?:status|code)\s*\(\s*\d{3}\s*\)|[{,(]\s*[1-5]\d\d\s*:/,
    pathIncludes: '/infra/http/',
    layers: ['module-infra', 'global-infra'],
    message: 'Status HTTP inline. Use a constante do módulo (infra/http/constants.ts).',
  },
  {
    check: 'ERROR-BASE',
    severity: HIGH,
    rule: 'ARCHITECTURE §8 — as seis categorias são irmãs',
    pattern: /class\s+\w+\s+extends\s+AppError\b/,
    layers: ['pure', 'module-infra', 'global-infra'],
    skipFiles: [ERROR_TAXONOMY],
    message:
      'Erro estendendo AppError direto, fora das seis categorias. O error-handler casa por instanceof nas seis; o que fica fora cai no ramo genérico e responde 500 — não o status pretendido. Estenda NotFoundError, ConflictError, UnauthorizedError, ForbiddenError, ValidationError ou BusinessRuleError.',
  },
  {
    check: 'TEST-ONLY',
    severity: MEDIUM,
    rule: 'Disciplina de suíte',
    pattern: /\b(?:describe|it|test)\.only\s*\(/,
    layers: ['test'],
    message: '.only commitado silencia o resto da suíte.',
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
        'ARCHITECTURE §6 — erro de driver não sai do infra/',
        `Repositório relança o erro cru do driver ('throw ${binding}'). Ele gruda todo parâmetro vinculado — incluindo o hash de senha — na própria message. Traduza: 'throw toPersistenceError(${binding})'.`,
        body.split('\n').find((l) => l.includes(`throw ${binding}`)) ?? '',
      )
    } else if (!body.includes('toPersistenceError')) {
      addFinding(
        HIGH,
        'CATCH-UNSANITIZED',
        file,
        line,
        'ARCHITECTURE §6 — erro de driver não sai do infra/',
        'catch na camada Drizzle sem toPersistenceError: ou o erro do driver escapa por outro caminho, ou a falha está sendo engolida.',
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

/** Nomes de parâmetro que carregam "de quem é este recurso". */
const OWNERSHIP_PARAMS = /^(?:userId|ownerId|tenantId|accountId|principalId|actorId)$/

/**
 * Um use case que RECEBE o dono e nunca o usa não filtra por dono: a busca é
 * por id global, e quem descobrir o id de outro usuário lê o recurso dele.
 * O parâmetro aparecendo uma única vez no arquivo — a própria declaração — é
 * exatamente essa assinatura.
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
        'Segurança — autorização por posse (IDOR)',
        `'${name}' é recebido por execute() e nunca usado: a consulta não filtra por dono. Quem obtiver o id de outro usuário alcança o recurso dele.`,
        match[0],
      )
    }
  }
}

const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const FENCE_DELIMITER = /^\s*(?:```|~~~)/
const ABSOLUTE_SPECIFIER = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i

/**
 * Link relativo quebrado em `.md` versionado. Nasceu de dois casos reais: um
 * move de pasta deixou quatro links apontando para o nada, e a documentação
 * seguiu descrevendo um caminho que já não existia. É a única forma de
 * "documento que mente" que uma máquina consegue provar.
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
        // Âncora pura (`#secao`) e destino absoluto ficam fora: o primeiro não é
        // caminho, e o segundo depende de uma raiz que este script não conhece.
        const [target] = match[1].split('#')
        if (target === '' || ABSOLUTE_SPECIFIER.test(target)) continue
        if (existsSync(path.resolve(directory, target))) continue

        addFinding(
          MEDIUM,
          'MD-LINK',
          file,
          index + 1,
          'Documentação versionada aponta para arquivo que existe',
          `Link relativo quebrado: '${target}'. Depois de mover um arquivo, o link fica verde no diff e morto na leitura.`,
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
        'ARCHITECTURE §11 — toda dependência em versão exata',
        'Faixa de versão (^ ou ~). Dois apps gerados do mesmo commit resolveriam árvores diferentes.',
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
      'ARCHITECTURE §2 — regra de fronteira',
      'Arquivo em src/ que não cai em nenhuma linha da tabela de fronteira. Ou ele pertence a uma das pastas nomeadas, ou a tabela precisa ganhar uma linha (decisão consciente, documentada).',
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
  console.log(`${scanned.length} arquivo(s) varrido(s) — ${summary}`)
}

if (strict) {
  if (counts[CRITICAL] > 0) process.exit(2)
  if (counts[HIGH] > 0 || counts[MEDIUM] > 0) process.exit(1)
}
