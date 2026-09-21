import { GLOBAL_INFRA, PURE, TEST } from './tools/boundaries/layers.mjs'

const ANY_MODULE = '^src/modules/'
/** `$1` refers to the capture group in the rule's own `from.path`. */
const SAME_MODULE = '^src/modules/$1/'
const OWN_MODULE = '^src/modules/([^/]+)/'
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
      comment:
        'Zod declares the module config schema (§5). Anything else is the outside world.',
      severity: 'error',
      from: { path: PURE, pathNot: TEST },
      to: { dependencyTypes: EXTERNAL, pathNot: ZOD },
    },
    {
      name: 'module-does-not-reach-module',
      comment: 'A crossing goes through a port of the consumer, wired in src/main/.',
      severity: 'error',
      from: { path: OWN_MODULE, pathNot: TEST },
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
      comment: 'src/infra/ is infrastructure with no owner (§2).',
      severity: 'error',
      from: { path: GLOBAL_INFRA, pathNot: TEST },
      to: { pathNot: [PURE, GLOBAL_INFRA], dependencyTypesNot: EXTERNAL },
    },
    {
      name: 'own-container-type-only',
      comment:
        'Decision 23 types the plugin by the slice it receives; as a value it would be a runtime edge.',
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
    // half of the boundary the rules exist to protect (§4).
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // Without `development`, `#modules/*` resolves to ./dist/*.js and the
      // rules, written against ^src/, stop matching (§4).
      conditionNames: ['development', 'import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.js', '.mts', '.cts'],
    },
    doNotFollow: { path: 'node_modules' },
  },
}
