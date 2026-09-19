# Fatia 22 — Store de rate limit compartilhado no Redis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** As rotas que declaram o próprio teto de requisições contam num Redis compartilhado entre as réplicas e recusam com 503 quando ele cai; o teto global continua em memória, por réplica.

**Architecture:** Um store nosso para o `@fastify/rate-limit` decide por rota: o plugin chama `store.child()` só para rotas com `config.rateLimit` próprio, e é por aí que o Redis entra; as demais usam o próprio store, que delega ao contador em memória do plugin. O cliente `ioredis` roda com fila offline desligada e `commandTimeout`, então uma queda vira erro imediato, traduzido em `TransientError` (503 + `Retry-After`) e registrado como `securityEvent`.

**Tech Stack:** Node 24, Fastify 5.12.1, `@fastify/rate-limit` 11.2.0, `ioredis` 6.0.0 (novo), Redis 8.10.1, Zod 4, Vitest 4, Biome 2.5.9, pnpm 11.

**Spec:** [`docs/superpowers/specs/2026-09-19-shared-rate-limit-store-design.md`](../specs/2026-09-19-shared-rate-limit-store-design.md) — leia junto: o plano argumenta a partir dela.

## Global Constraints

- Todo código, identificador, string, log e comentário em **inglês**; arquivos `*.md` podem ficar em português (`CLAUDE.md`).
- **Sem strings ou números mágicos** inline: constante nomeada, `UPPER_SNAKE_CASE`, perto do uso (`CLAUDE.md`). Vale também para os testes.
- **Comentários explicam o código, não a tarefa**: nada de "a revisão achou", "fatia 22 mudou isto". Cite (`decision 39`, `§5`), não reargumente (`CLAUDE.md`).
- Dependências em **versão exata**, sem `^` (`pnpm-workspace.yaml` já tem `savePrefix: ''`): `ioredis` `6.0.0`, imagem `redis:8.10.1-alpine3.23`.
- Só `src/infra/config/env.ts` lê `process.env` (R6, `noProcessEnv` no Biome). O que os testes precisam vai por `vitest.config.ts`.
- Biome: 2 espaços, aspas simples, sem ponto e vírgula, vírgula final, largura 90. `pnpm lint:fix` resolve formatação; `pnpm lint` tem de sair limpo.
- TypeScript estrito com `exactOptionalPropertyTypes` e `verbatimModuleSyntax`: use `import type` para tipos e espalhe propriedades opcionais condicionalmente em vez de passar `undefined`.
- Imports: alias `#infra/*`, `#modules/*`, `#shared/*`, `#main/*` entre pastas; caminho relativo com `.js` dentro da mesma pasta.
- Valores de contrato de fio (`RATE_LIMIT_STORE_UNAVAILABLE`, `503`) ficam **escritos por extenso nos testes**, nunca importados, para um renomeio não manter a suíte verde.
- Commits: Conventional Commits em inglês, sem narrativa de processo, terminando com o trailer `Co-Authored-By` da sessão que executa.
- Suíte de integração exige `pnpm db:up` (Postgres de teste, Mailpit e, agora, `redis-test`).

## File Structure

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `src/infra/config/env.ts` | `REDIS_URL`, `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_COMMAND_TIMEOUT_MS` e seus defaults | 1 |
| `src/infra/redis/client.ts` | `createRedis`, `connectRedis`, `closeRedis`: o cliente que falha rápido e loga transições | 2 |
| `src/infra/http/rate-limit-store-unavailable-error.ts` | O erro (`TransientError`, `securityEvent`) | 3 |
| `src/infra/http/redis-rate-limit-store.ts` | Contador de uma rota no Redis, script Lua atômico | 3 |
| `src/infra/http/scoped-rate-limit-store.ts` | O store entregue ao plugin: memória no global, Redis por rota | 4 |
| `src/infra/http/local-store.d.ts` | Tipos do `LocalStore` interno do plugin | 4 |
| `src/infra/http/rate-limit.ts` | `registerRateLimit` ganha o parâmetro `redis` | 4 |
| `src/infra/health/checks/redis-check.ts` | O check irmão de `database-check.ts` | 5 |
| `src/infra/http/endpoints/health.ts` | Mostra `redis` sem deixá-lo decidir o 503 | 5 |
| `src/main/app.ts` | Compõe o cliente, o `onClose`, o arranque tolerante | 5 |
| `tests/integration/setup/redis.ts` | `flushRedis()` para isolar contadores entre casos | 5 |
| `tests/integration/shared-rate-limit.spec.ts` | As provas: teto único entre réplicas, resiliência | 6 |

---

### Task 1: Variáveis `REDIS_*`, serviços locais e de CI

**Files:**
- Modify: `src/infra/config/env.ts`
- Modify: `src/infra/config/env.spec.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Create: `tests/integration/setup/test-redis-url.ts`
- Modify: `vitest.config.ts`
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example` (e o `.env` local, sem commitar)

**Interfaces:**
- Produces: `Env` ganha `REDIS_URL: string`, `REDIS_CONNECT_TIMEOUT_MS: number`, `REDIS_COMMAND_TIMEOUT_MS: number`. `#infra/config/env` exporta `DEFAULT_REDIS_CONNECT_TIMEOUT_MS` (`1_000`) e `DEFAULT_REDIS_COMMAND_TIMEOUT_MS` (`250`). `tests/integration/setup/test-redis-url.ts` exporta `TEST_REDIS_URL`.

- [ ] **Step 1: Ajustar o `env.spec.ts` (red)**

Todo `parseEnv` do arquivo passa o conjunto mínimo válido; com `REDIS_URL` obrigatório, cada um precisa dele. Primeiro o `sed` nas 19 ocorrências (18 chamadas e o objeto esperado do teste de defaults):

```bash
sed -i 's/^\( *\)DATABASE_URL: VALID_DATABASE_URL,$/&\n\1REDIS_URL: VALID_REDIS_URL,/' src/infra/config/env.spec.ts
grep -c "REDIS_URL: VALID_REDIS_URL," src/infra/config/env.spec.ts
```

Expected: `19`.

Depois as edições à mão. A constante, logo após `VALID_DATABASE_URL`:

```ts
const VALID_DATABASE_URL = 'postgres://user:pass@localhost:5432/app'
const VALID_REDIS_URL = 'redis://localhost:6379'
```

A chamada de uma linha só (o `sed` não a alcança), em `rejects a missing JWT_SECRET`:

```ts
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      REDIS_URL: VALID_REDIS_URL,
    })
```

O import dos defaults (`old` → `new`):

```ts
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  NODE_ENV_DEVELOPMENT,
```
```ts
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  NODE_ENV_DEVELOPMENT,
```

O objeto esperado em `applies defaults when only the required variables are provided` (`old` → `new`):

```ts
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS:
        DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      MAIL_HOST: DEFAULT_MAIL_HOST,
```
```ts
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS:
        DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      REDIS_CONNECT_TIMEOUT_MS: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
      REDIS_COMMAND_TIMEOUT_MS: DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
      MAIL_HOST: DEFAULT_MAIL_HOST,
```

E os testes novos, inseridos logo antes do comentário `// The three Postgres timeouts read \`0\` as DISABLED`:

```ts
  it('rejects a missing REDIS_URL', () => {
    // No default on purpose, like DATABASE_URL: a shared one would point two
    // deployments at the same Redis, and they would count each other's requests.
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      JWT_ISSUER: VALID_JWT_ISSUER,
      JWT_AUDIENCE: VALID_JWT_AUDIENCE,
      GOOGLE_CLIENT_ID: VALID_GOOGLE_CLIENT_ID,
    })

    expect(result.success).toBe(false)
  })

  // `.positive()`, as for `PORT`: there is no legitimate zero, because a timeout
  // that bounds nothing defeats the fail-fast — and an empty value coerces to
  // zero, so rejecting zero is also what rejects a blanked `.env` line.
  it.each(['REDIS_CONNECT_TIMEOUT_MS', 'REDIS_COMMAND_TIMEOUT_MS'])(
    'rejects an empty or zero %s',
    (name) => {
      for (const value of ['', '0']) {
        const result = parseEnv({
          DATABASE_URL: VALID_DATABASE_URL,
          REDIS_URL: VALID_REDIS_URL,
          JWT_SECRET: VALID_JWT_SECRET,
          JWT_ISSUER: VALID_JWT_ISSUER,
          JWT_AUDIENCE: VALID_JWT_AUDIENCE,
          GOOGLE_CLIENT_ID: VALID_GOOGLE_CLIENT_ID,
          [name]: value,
        })

        expect(result.success).toBe(false)
      }
    },
  )
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:unit src/infra/config/env.spec.ts`

Expected: FAIL em `rejects a missing REDIS_URL` (o schema ainda aceita) e em `applies defaults…` (as chaves `REDIS_*` esperadas não existem no resultado). O import de `DEFAULT_REDIS_*` resolve como `undefined` até o Step 3.

- [ ] **Step 3: Implementar em `env.ts`**

Os defaults, logo depois de `DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (`old` → `new`):

```ts
/** The net against a hung callback holding a connection AND its locks forever. */
export const DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000
```
```ts
/** The net against a hung callback holding a connection AND its locks forever. */
export const DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000

/**
 * Redis backs the routes that declare their own rate limit ceiling, and those
 * routes refuse while it is down (decision 39). These bound how long a request
 * waits on it: a command that is not answered quickly must fail, not queue.
 * The command timeout is far above a healthy round trip and far below any
 * request timeout.
 */
export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1_000
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 250
```

Os campos do schema, logo depois do bloco `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` do `coreEnvSchema` (`old` → `new`):

```ts
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: timeoutMs(
    DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  ),
```
```ts
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: timeoutMs(
    DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  ),
  // No default, like `DATABASE_URL`: two deployments must not share a Redis by
  // accident and count each other's requests.
  REDIS_URL: z.url(),
  // `.positive()`, as for `PORT`: no legitimate zero, and rejecting zero is what
  // rejects an empty value.
  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REDIS_COMMAND_TIMEOUT_MS),
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test:unit src/infra/config/env.spec.ts`

Expected: PASS.

- [ ] **Step 5: Completar a fixture `TEST_ENV`**

`Env` agora exige as três chaves, então `pnpm typecheck` falha em `test-env.ts` até isto. No import de `#infra/config/env` (`old` → `new`):

```ts
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  NODE_ENV_TEST,
```
```ts
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  NODE_ENV_TEST,
```

E no objeto (`old` → `new`):

```ts
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS:
    DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  MAIL_HOST: DEFAULT_MAIL_HOST,
```
```ts
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS:
    DEFAULT_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  REDIS_URL: 'redis://localhost:6379',
  REDIS_CONNECT_TIMEOUT_MS: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS: DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  MAIL_HOST: DEFAULT_MAIL_HOST,
```

- [ ] **Step 6: A URL do Redis de teste e o `vitest.config.ts`**

Crie `tests/integration/setup/test-redis-url.ts`:

```ts
/**
 * The other half of the `redis-test` service in `docker-compose.yml`, pinned to
 * its port. `vitest.config.ts` injects it as `REDIS_URL` for the integration
 * suite, for the reasons `test-database-url.ts` gives for `DATABASE_URL`: a
 * fixture and not configuration, so a `.env` pointing at the development Redis
 * can never be flushed by a spec.
 *
 * `.github/workflows/ci.yml` keeps its own copy: the service container is
 * configured before any of this code could be read.
 */
export const TEST_REDIS_URL = 'redis://127.0.0.1:6380'
```

Em `vitest.config.ts`, o import (`old` → `new`):

```ts
import { TEST_DATABASE_URL } from './tests/integration/setup/test-database-url.js'
```
```ts
import { TEST_DATABASE_URL } from './tests/integration/setup/test-database-url.js'
import { TEST_REDIS_URL } from './tests/integration/setup/test-redis-url.js'
```

E o bloco `env` (`old` → `new`):

```ts
      DATABASE_URL: TEST_DATABASE_URL,
```
```ts
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
```

- [ ] **Step 7: Serviços no `docker-compose.yml`**

Insira antes do comentário `  # Local SMTP catcher. Captures every outgoing message — verification codes`:

```yaml
  # Backs the rate limit of every route that declares its own ceiling. A counter
  # lives for one window, so nothing here is worth keeping: no snapshots, no
  # volume, and a restart is a clean slate.
  redis:
    # Pinned exact — bump deliberately, same convention as our npm deps.
    image: redis:8.10.1-alpine3.23
    container_name: api-clean-platform-redis
    restart: unless-stopped
    # Bind to localhost only — never expose the dev Redis to the LAN.
    ports:
      - '127.0.0.1:6379:6379'
    command: ['redis-server', '--save', '', '--appendonly', 'no']
    tmpfs:
      - /data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 5s

  # Ephemeral Redis for the integration suite, on its own port so it never shares
  # counters with the dev instance: the suite flushes it freely.
  redis-test:
    # Pinned exact — bump deliberately, same convention as our npm deps.
    image: redis:8.10.1-alpine3.23
    container_name: api-clean-platform-redis-test
    restart: unless-stopped
    ports:
      - '127.0.0.1:6380:6379'
    command: ['redis-server', '--save', '', '--appendonly', 'no']
    tmpfs:
      - /data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 5s

```

- [ ] **Step 8: Serviço e variável no `ci.yml`**

O serviço, entre o `mailpit` e `steps:` (`old` → `new`):

```yaml
          --health-cmd "wget -q -O- http://localhost:8025/readyz"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    steps:
```
```yaml
          --health-cmd "wget -q -O- http://localhost:8025/readyz"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

      # Same image as docker-compose.yml's `redis-test`, on port 6380: the test
      # Redis URL is a literal constant in tests/integration/setup/test-redis-url.ts,
      # so CI has to reproduce it exactly.
      redis:
        image: redis:8.10.1-alpine3.23
        ports:
          - 6380:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    steps:
```

E a variável do passo `Smoke the built output` (`old` → `new`):

```yaml
          DATABASE_URL: postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test
          JWT_SECRET: a-ci-secret-with-at-least-32-characters
```
```yaml
          DATABASE_URL: postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test
          REDIS_URL: redis://127.0.0.1:6380
          JWT_SECRET: a-ci-secret-with-at-least-32-characters
```

- [ ] **Step 9: `.env.example` e o `.env` local**

Em `.env.example`, o comentário do teto global (`old` → `new`):

```
# Per-address request ceiling. A flood guard, not a UX limit — the limit that
# matters lives at the edge, which sees every replica. This store is per
# process, so N replicas mean N times the ceiling.
```
```
# Per-address request ceiling for every route that does not declare its own. A
# flood guard, not a UX limit — the limit that matters lives at the edge, which
# sees every replica. This counter is per process, so N replicas mean N times
# the ceiling.
```

E as variáveis novas, entre `DATABASE_URL` e `JWT_SECRET` (`old` → `new`):

```
DATABASE_URL=postgres://api_clean_platform:api_clean_platform_local_dev@localhost:5432/api_clean_platform
JWT_SECRET=a-development-secret-with-32-chars-min
```
```
DATABASE_URL=postgres://api_clean_platform:api_clean_platform_local_dev@localhost:5432/api_clean_platform

# Redis behind the rate limit of every route that declares its own ceiling
# (login, register, the password and e-mail routes). REQUIRED, with no default.
# With Redis down those routes answer 503; every other route is unaffected.
REDIS_URL=redis://localhost:6379
REDIS_CONNECT_TIMEOUT_MS=1000
REDIS_COMMAND_TIMEOUT_MS=250

JWT_SECRET=a-development-secret-with-32-chars-min
```

No `.env` local (ignorado pelo git; sem a variável `pnpm dev` recusa subir), se existir:

```bash
[ -f .env ] && ! grep -q '^REDIS_URL=' .env && printf '\nREDIS_URL=redis://localhost:6379\n' >> .env; true
```

- [ ] **Step 10: Verificar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
docker compose up -d --wait redis redis-test
docker exec api-clean-platform-redis-test redis-cli ping
```

Expected: lint e typecheck limpos; `test:unit` verde; `redis-cli ping` responde `PONG`. Se a porta 6379 já estiver ocupada por outro Redis na sua máquina, pare o outro ou ajuste a porta do serviço `redis` (o de teste usa 6380).

- [ ] **Step 11: Commit**

```bash
git add src/infra/config docker-compose.yml .github/workflows/ci.yml .env.example tests/integration/setup/test-redis-url.ts vitest.config.ts
git commit -m "feat(infra): add the Redis environment variables and services"
```

---

### Task 2: O cliente Redis que falha rápido

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)
- Create: `src/infra/redis/client.ts`
- Test: `tests/integration/redis-client.spec.ts`

**Interfaces:**
- Consumes: `Env` com `REDIS_*` (Task 1).
- Produces:
  - `RedisEnv = Pick<Env, 'REDIS_URL' | 'REDIS_CONNECT_TIMEOUT_MS' | 'REDIS_COMMAND_TIMEOUT_MS'>`
  - `interface RedisLogger { warn(message: string): void; info(message: string): void }`
  - `createRedis(env: RedisEnv, log: RedisLogger): Redis` (do `ioredis`, sem conectar)
  - `connectRedis(redis: Redis): Promise<boolean>` (`false` sem lançar quando não alcança)
  - `closeRedis(redis: Redis): Promise<void>` (nunca lança)

- [ ] **Step 1: Instalar a dependência**

```bash
pnpm add ioredis@6.0.0
grep '"ioredis"' package.json
```

Expected: `"ioredis": "6.0.0",` (exato, sem `^`).

- [ ] **Step 2: Escrever o spec de integração (red)**

Crie `tests/integration/redis-client.spec.ts`:

```ts
import { once } from 'node:events'
import type { Redis } from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '#infra/config/env'
import { closeRedis, connectRedis, createRedis } from '#infra/redis/client'

// Port 1 is never a Redis: the connection is refused, which is a real failure
// and not a stubbed one.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'
const PONG = 'PONG'

// Log lines are read by whoever is paged: spelled out, not imported.
const CONNECTION_READY_LOG = 'redis connection ready'
const CONNECTION_LOST_LOG = 'redis connection lost'

const openClients: Redis[] = []

const recordingLog = () => ({ warn: vi.fn(), info: vi.fn() })

function startClient(
  overrides: Partial<Pick<typeof env, 'REDIS_URL'>> = {},
  log = recordingLog(),
): Redis {
  const redis = createRedis({ ...env, ...overrides }, log)
  openClients.push(redis)

  return redis
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(closeRedis))
})

describe('the Redis client', () => {
  it('answers a command once connected', async () => {
    const redis = startClient()

    expect(await connectRedis(redis)).toBe(true)
    expect(await redis.ping()).toBe(PONG)
  })

  // The offline queue is what would hold this command until the reconnect
  // succeeded — and a login request with it. Failing inside the command
  // timeout, and in practice at once, is the whole point of the options.
  it('fails a command at once, instead of queuing it, when the server is unreachable', async () => {
    const redis = startClient({ REDIS_URL: UNREACHABLE_REDIS_URL })

    expect(await connectRedis(redis)).toBe(false)

    const startedAt = performance.now()
    await expect(redis.ping()).rejects.toThrow()

    expect(performance.now() - startedAt).toBeLessThan(env.REDIS_COMMAND_TIMEOUT_MS)
  })

  it('closes without throwing while the connection is down', async () => {
    const redis = startClient({ REDIS_URL: UNREACHABLE_REDIS_URL })
    await connectRedis(redis)

    await expect(closeRedis(redis)).resolves.toBeUndefined()
  })

  // One line per transition: `close` also fires on every failed reconnection
  // attempt, and a log line each would bury the one that matters.
  it('reports a lost connection once and its return', async () => {
    const log = recordingLog()
    const redis = startClient({}, log)
    await connectRedis(redis)

    const reconnected = once(redis, 'ready')
    redis.disconnect(true)
    await reconnected

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(CONNECTION_LOST_LOG)
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenNthCalledWith(1, CONNECTION_READY_LOG)
    expect(log.info).toHaveBeenNthCalledWith(2, CONNECTION_READY_LOG)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
pnpm db:up
pnpm test:integration tests/integration/redis-client.spec.ts
```

Expected: FAIL — `Failed to resolve import "#infra/redis/client"`.

- [ ] **Step 4: Implementar o cliente**

Crie `src/infra/redis/client.ts`:

```ts
import { Redis } from 'ioredis'
import type { Env } from '#infra/config/env'

/**
 * Only what the client reads, so reaching for another variable is a compile
 * error rather than a review comment (decision 23).
 */
export type RedisEnv = Pick<
  Env,
  'REDIS_URL' | 'REDIS_CONNECT_TIMEOUT_MS' | 'REDIS_COMMAND_TIMEOUT_MS'
>

/**
 * Its own shape rather than `Pick<AppLogger, ...>`: pino's `warn` is an
 * overloaded `LogFn`, which no hand-written double can satisfy.
 */
export interface RedisLogger {
  warn(message: string): void
  info(message: string): void
}

/** Reconnection backs off in steps and stops growing here, so recovery is quick. */
const RECONNECT_STEP_MS = 50
const RECONNECT_MAX_DELAY_MS = 500

const CONNECTION_READY_MESSAGE = 'redis connection ready'
const CONNECTION_LOST_MESSAGE = 'redis connection lost'
const CLIENT_ENDED_STATUS = 'end'

/**
 * Builds the client without connecting: `connectRedis` does, so a Redis that is
 * down at boot is reported by the caller instead of surfacing as an event.
 *
 * A command with no live connection fails at once. ioredis's default is to hold
 * it in an offline queue until the reconnect succeeds, which would leave a
 * request on a route that counts here hanging instead of answering 503
 * (decision 39). `commandTimeout` covers the other case: a connection that is
 * up and no longer answering.
 */
export function createRedis(env: RedisEnv, log: RedisLogger): Redis {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt) =>
      Math.min(attempt * RECONNECT_STEP_MS, RECONNECT_MAX_DELAY_MS),
  })

  redis.on('error', () => {
    // Every failed reconnection attempt emits one; the outage is reported once,
    // through `close` below.
  })

  // One line per transition. `close` also fires on every failed reconnection
  // attempt, so it counts only while the connection was up; and a deliberate
  // shutdown ends the client, which is not a loss.
  let up = false
  redis.on('ready', () => {
    up = true
    log.info(CONNECTION_READY_MESSAGE)
  })
  redis.on('close', () => {
    if (!up) return
    up = false
    if (redis.status !== CLIENT_ENDED_STATUS) log.warn(CONNECTION_LOST_MESSAGE)
  })

  return redis
}

/**
 * False, without throwing, when the server cannot be reached: the process may
 * start before Redis, and the client keeps reconnecting in the background.
 */
export async function connectRedis(redis: Redis): Promise<boolean> {
  try {
    await redis.connect()
    return true
  } catch {
    return false
  }
}

/**
 * `QUIT` is a command, so it fails when the connection is down; `disconnect`
 * needs none, and also stops the reconnection timer that would keep the process
 * alive.
 */
export async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

```bash
pnpm test:integration tests/integration/redis-client.spec.ts
pnpm lint:fix && pnpm lint && pnpm typecheck
```

Expected: 4 testes PASS; lint e typecheck limpos.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/infra/redis tests/integration/redis-client.spec.ts
git commit -m "feat(infra): add a Redis client that fails fast when the server is down"
```

---

### Task 3: O erro e o store de Redis

**Files:**
- Create: `src/infra/http/rate-limit-store-unavailable-error.ts`
- Create: `src/infra/http/redis-rate-limit-store.ts`
- Test: `src/infra/http/redis-rate-limit-store.spec.ts`

**Interfaces:**
- Produces:
  - `class RateLimitStoreUnavailableError extends TransientError` (`code = 'RATE_LIMIT_STORE_UNAVAILABLE'`, `securityEvent = true`, sem `cause`)
  - `type RateLimitRedis = Pick<Redis, 'eval'>`
  - `class RedisRateLimitStore implements FastifyRateLimitStore`, com `constructor(redis: RateLimitRedis, keyPrefix: string)`; `incr` devolve `{ current, ttl }` ao callback ou `RateLimitStoreUnavailableError`.

- [ ] **Step 1: Escrever o spec (red)**

Crie `src/infra/http/redis-rate-limit-store.spec.ts`:

```ts
import type { FastifyRateLimitStore } from '@fastify/rate-limit'
import { describe, expect, it, vi } from 'vitest'
import { RateLimitStoreUnavailableError } from './rate-limit-store-unavailable-error.js'
import { type RateLimitRedis, RedisRateLimitStore } from './redis-rate-limit-store.js'

const KEY_PREFIX = 'test:route:'
const ADDRESS = '203.0.113.7'
const WINDOW_MS = 60_000
const MAX_REQUESTS = 10
const SCRIPT_KEY_COUNT = 1
const DRIVER_ADDRESS = '10.0.0.5'
const DRIVER_ERROR_MESSAGE = `connect ECONNREFUSED ${DRIVER_ADDRESS}:6379`

interface Outcome {
  error: Error | null
  result: { current: number; ttl: number } | undefined
}

function redisAnswering(reply: unknown) {
  const evalScript = vi.fn().mockResolvedValue(reply)

  return { redis: { eval: evalScript } as unknown as RateLimitRedis, evalScript }
}

function redisFailing(error: Error): RateLimitRedis {
  return { eval: vi.fn().mockRejectedValue(error) } as unknown as RateLimitRedis
}

/** Typed as the plugin's interface, whose `incr` takes the `max` this store ignores. */
function increment(store: FastifyRateLimitStore): Promise<Outcome> {
  return new Promise((resolve) => {
    store.incr(
      ADDRESS,
      (error, result) => resolve({ error, result }),
      WINDOW_MS,
      MAX_REQUESTS,
    )
  })
}

describe('RedisRateLimitStore', () => {
  it('returns the count and the time left, as the script reports them', async () => {
    const { redis } = redisAnswering([3, 42_000])

    const { error, result } = await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(error).toBeNull()
    expect(result).toEqual({ current: 3, ttl: 42_000 })
  })

  it('counts under the route prefix and sends the window as the expiry', async () => {
    const { redis, evalScript } = redisAnswering([1, WINDOW_MS])

    await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      SCRIPT_KEY_COUNT,
      `${KEY_PREFIX}${ADDRESS}`,
      WINDOW_MS,
    )
  })

  // The driver error carries the server address, and pino prints a cause chain:
  // dropping it here is what keeps that address out of the log and the response.
  it('reports any failure of the client as unavailable, dropping the driver error', async () => {
    const store = new RedisRateLimitStore(
      redisFailing(new Error(DRIVER_ERROR_MESSAGE)),
      KEY_PREFIX,
    )

    const { error, result } = await increment(store)

    expect(error).toBeInstanceOf(RateLimitStoreUnavailableError)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(error?.message).not.toContain(DRIVER_ADDRESS)
    expect(result).toBeUndefined()
  })

  it('reports a reply it cannot read as unavailable', async () => {
    const { redis } = redisAnswering('OK')

    const { error } = await increment(new RedisRateLimitStore(redis, KEY_PREFIX))

    expect(error).toBeInstanceOf(RateLimitStoreUnavailableError)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:unit src/infra/http/redis-rate-limit-store.spec.ts`

Expected: FAIL — os módulos `./rate-limit-store-unavailable-error.js` e `./redis-rate-limit-store.js` não existem.

- [ ] **Step 3: Implementar o erro**

Crie `src/infra/http/rate-limit-store-unavailable-error.ts`:

```ts
import { TransientError } from '#shared/errors/app-error'

const RATE_LIMIT_STORE_UNAVAILABLE_ERROR_NAME = 'RateLimitStoreUnavailableError'
const RATE_LIMIT_STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE =
  'The rate limit store is unreachable; retry shortly'

/**
 * The counter behind a route's own ceiling could not be reached, and the route
 * refuses instead of answering uncounted (decision 39).
 *
 * `securityEvent: true` is what makes the error handler log it: a transient
 * error is otherwise a 503 with no line at all, and a control that stopped
 * controlling would look like ordinary traffic.
 *
 * Carries **no `cause`**, for the same reason `TransactionConflictError` carries
 * none: pino's serializer concatenates the cause chain into the parent's
 * message, and the driver error underneath holds the server address.
 */
export class RateLimitStoreUnavailableError extends TransientError {
  readonly code = RATE_LIMIT_STORE_UNAVAILABLE_CODE
  override readonly securityEvent = true

  constructor() {
    super(RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE)
    this.name = RATE_LIMIT_STORE_UNAVAILABLE_ERROR_NAME
  }
}
```

- [ ] **Step 4: Implementar o store**

Crie `src/infra/http/redis-rate-limit-store.ts`:

```ts
import type { FastifyRateLimitStore } from '@fastify/rate-limit'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { RateLimitStoreUnavailableError } from './rate-limit-store-unavailable-error.js'

/** The one command this store issues, so a test double needs only this. */
export type RateLimitRedis = Pick<Redis, 'eval'>

const SINGLE_KEY = 1

/**
 * Count and expiry in ONE script, so they are atomic: as two commands, a
 * connection dropped between `INCR` and `PEXPIRE` would leave a key with no
 * expiry, and that address would stay blocked for good. The `ttl < 0` branch
 * also gives a key that already lost its expiry a fresh one.
 */
const COUNT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`

const scriptReplySchema = z.tuple([z.number(), z.number()])

type IncrCallback = Parameters<FastifyRateLimitStore['incr']>[1]

/**
 * The counter of one route, kept in Redis so every replica sees the same number.
 *
 * Any failure — the client's, or a reply this store cannot read — is reported as
 * `RateLimitStoreUnavailableError`. The driver's own error is dropped on purpose:
 * see that class for why it carries no cause.
 */
export class RedisRateLimitStore implements FastifyRateLimitStore {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly keyPrefix: string,
  ) {}

  incr(key: string, callback: IncrCallback, timeWindow: number): void {
    this.count(key, timeWindow).then(
      (result) => callback(null, result),
      () => callback(new RateLimitStoreUnavailableError()),
    )
  }

  /** The plugin derives per-route stores from the store it was given, never from one of these. */
  child(): FastifyRateLimitStore {
    return this
  }

  private async count(key: string, timeWindow: number) {
    const reply = await this.redis.eval(
      COUNT_SCRIPT,
      SINGLE_KEY,
      `${this.keyPrefix}${key}`,
      timeWindow,
    )
    const [current, ttl] = scriptReplySchema.parse(reply)

    return { current, ttl }
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

```bash
pnpm test:unit src/infra/http/redis-rate-limit-store.spec.ts
pnpm lint:fix && pnpm lint && pnpm typecheck
```

Expected: 4 testes PASS; lint e typecheck limpos.

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/rate-limit-store-unavailable-error.ts src/infra/http/redis-rate-limit-store.ts src/infra/http/redis-rate-limit-store.spec.ts
git commit -m "feat(infra): add the Redis-backed rate limit store"
```

---

### Task 4: O store escopado e o `registerRateLimit`

**Files:**
- Create: `src/infra/http/local-store.d.ts`
- Create: `src/infra/http/scoped-rate-limit-store.ts`
- Modify: `src/infra/http/rate-limit.ts`
- Test: `src/infra/http/rate-limit.spec.ts`

**Interfaces:**
- Consumes: `RateLimitRedis`, `RedisRateLimitStore` (Task 3).
- Produces: `createScopedRateLimitStore(redis: RateLimitRedis): FastifyRateLimitStoreCtor`; `registerRateLimit(app, env, redis?)`. Sem `redis`, o comportamento é o de hoje.

- [ ] **Step 1: Estender o `rate-limit.spec.ts` (red)**

No import do vitest e nos imports do arquivo (`old` → `new`):

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { registerRateLimit } from '#infra/http/rate-limit'
```
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { registerRateLimit } from '#infra/http/rate-limit'
import type { RateLimitRedis } from '#infra/http/redis-rate-limit-store'
```

Acrescente ao **fim** do arquivo, depois do último `describe`:

```ts
const GLOBAL_CEILING = 100
const OWN_CEILING = 2
const MILLISECONDS_PER_SECOND = 1000
const SERVICE_UNAVAILABLE_STATUS = 503
const STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const DRIVER_ADDRESS = '10.0.0.5'

const PLAIN_PATH = '/probe/plain'
const OWN_PATH = '/probe/own'
const OTHER_OWN_PATH = '/probe/other-own'

/** A Redis that counts like the real one, keyed the way the script receives it. */
function countingRedis() {
  const counts = new Map<string, number>()
  const evalScript = vi.fn(
    async (_script: string, _keyCount: number, key: string, windowMs: number) => {
      const current = (counts.get(key) ?? 0) + 1
      counts.set(key, current)

      return [current, windowMs]
    },
  )

  return { redis: { eval: evalScript } as unknown as RateLimitRedis, evalScript }
}

function brokenRedis(): RateLimitRedis {
  return {
    eval: vi
      .fn()
      .mockRejectedValue(new Error(`connect ECONNREFUSED ${DRIVER_ADDRESS}:6379`)),
  } as unknown as RateLimitRedis
}

/**
 * Two routes declaring their own ceiling and one that does not — the split the
 * store makes. The global ceiling is far above what any case spends, so a 429
 * here can only come from a route's own.
 */
async function buildRedisBackedServer(
  redis: RateLimitRedis,
  logStream: Writable = discardedLog(),
): Promise<FastifyInstance> {
  const app = buildServer(
    { ...TEST_ENV, RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING },
    { logStream },
  )
  openApps.push(app)

  await registerRateLimit(
    app,
    {
      RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING,
      RATE_LIMIT_WINDOW_SECONDS: WINDOW_SECONDS,
    },
    redis,
  )

  const ownCeiling = {
    config: {
      rateLimit: {
        max: OWN_CEILING,
        timeWindow: WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
      },
    },
  }
  app.get(PLAIN_PATH, async () => ({ ok: true }))
  app.get(OWN_PATH, ownCeiling, async () => ({ ok: true }))
  app.get(OTHER_OWN_PATH, ownCeiling, async () => ({ ok: true }))
  await app.ready()

  return app
}

describe('registerRateLimit with a Redis store', () => {
  it('counts a route with its own ceiling in Redis and every other route in process', async () => {
    const { redis, evalScript } = countingRedis()
    const app = await buildRedisBackedServer(redis)

    await get(app, PLAIN_PATH)
    expect(evalScript).not.toHaveBeenCalled()

    await get(app, OWN_PATH)
    expect(evalScript).toHaveBeenCalledTimes(1)
  })

  // The whole point of the store: two replicas, one number.
  it('shares the count of a route with its own ceiling across servers', async () => {
    const { redis } = countingRedis()
    const first = await buildRedisBackedServer(redis)
    const second = await buildRedisBackedServer(redis)

    expect((await get(first, OWN_PATH)).statusCode).toBe(OK_STATUS)
    expect((await get(second, OWN_PATH)).statusCode).toBe(OK_STATUS)

    expect((await get(first, OWN_PATH)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
  })

  it('keeps one count per route', async () => {
    const { redis } = countingRedis()
    const app = await buildRedisBackedServer(redis)

    for (let attempt = 0; attempt < OWN_CEILING; attempt++) {
      expect((await get(app, OWN_PATH)).statusCode).toBe(OK_STATUS)
    }

    expect((await get(app, OTHER_OWN_PATH)).statusCode).toBe(OK_STATUS)
  })

  it('refuses a route with its own ceiling while Redis fails, and keeps answering the others', async () => {
    const app = await buildRedisBackedServer(brokenRedis())

    const refused = await get(app, OWN_PATH)

    expect(refused.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS)
    expect(refused.json().error.code).toBe(STORE_UNAVAILABLE_CODE)
    expect(refused.headers[RETRY_AFTER_HEADER]).toBeDefined()
    expect((await get(app, PLAIN_PATH)).statusCode).toBe(OK_STATUS)
  })

  // A 503 with no log line would make a control that stopped controlling look
  // like ordinary traffic; and the driver error must not ride along with it.
  it('leaves a security event in the log, without the driver error', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
    const app = await buildRedisBackedServer(brokenRedis(), stream)

    const refused = await get(app, OWN_PATH)

    const logged = lines.join('')
    expect(logged).toContain(`"code":"${STORE_UNAVAILABLE_CODE}"`)
    expect(logged).toContain('security event')
    expect(logged).not.toContain(DRIVER_ADDRESS)
    expect(refused.body).not.toContain(DRIVER_ADDRESS)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:unit src/infra/http/rate-limit.spec.ts`

Expected: os 4 casos antigos passam; os 5 novos FALHAM (`registerRateLimit` ignora o terceiro argumento, então nada chega ao Redis falso e o 503 nunca acontece).

- [ ] **Step 3: A declaração de tipos do `LocalStore`**

Crie `src/infra/http/local-store.d.ts`:

```ts
/**
 * `@fastify/rate-limit` ships no types for its in-process counter and does not
 * export it, so the deep path is declared here. The package version is pinned
 * exactly; a bump that moves the file fails `scoped-rate-limit-store.ts` at
 * import time, in the unit suite.
 */
declare module '@fastify/rate-limit/store/LocalStore.js' {
  import type { FastifyRateLimitStore } from '@fastify/rate-limit'

  const LocalStore: new (
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    cache?: number,
  ) => FastifyRateLimitStore

  export = LocalStore
}
```

- [ ] **Step 4: O store escopado**

Crie `src/infra/http/scoped-rate-limit-store.ts`:

```ts
import type {
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
} from '@fastify/rate-limit'
import LocalStore from '@fastify/rate-limit/store/LocalStore.js'
import { type RateLimitRedis, RedisRateLimitStore } from './redis-rate-limit-store.js'

/** A constant, so every replica reads and writes the same keys. */
const RATE_LIMIT_KEY_PREFIX = 'api-clean-platform:rate-limit:'
const KEY_SEPARATOR = ':'

/**
 * What the plugin really passes to `child`: the route's merged options, with
 * the route itself under `routeInfo`. Its typings say `RouteOptions`, which the
 * runtime object is not — checked against 11.2.0, and pinned by the specs that
 * count one route apart from another.
 */
interface ChildParams {
  routeInfo: { method?: string | string[]; url?: string }
}

/**
 * The store handed to `@fastify/rate-limit`, splitting routes by who declares
 * the ceiling (decision 39).
 *
 * The plugin calls `child` for a route that declares its own `config.rateLimit`
 * and uses the store itself for every other route. So the routes whose ceiling
 * defends against guessing count in Redis, shared by every replica, while the
 * global ceiling stays in process: no round trip on ordinary routes, and a
 * Redis outage does not reach them.
 */
export function createScopedRateLimitStore(
  redis: RateLimitRedis,
): FastifyRateLimitStoreCtor {
  return class ScopedRateLimitStore implements FastifyRateLimitStore {
    /** Neither `continueExceeding` nor `exponentialBackoff` is enabled anywhere. */
    private readonly perProcess = new LocalStore(false, false)

    incr(...args: Parameters<FastifyRateLimitStore['incr']>): void {
      this.perProcess.incr(...args)
    }

    child(
      routeOptions: Parameters<FastifyRateLimitStore['child']>[0],
    ): FastifyRateLimitStore {
      const { routeInfo } = routeOptions as unknown as ChildParams
      const route = `${String(routeInfo.method ?? '')}${KEY_SEPARATOR}${routeInfo.url ?? ''}`

      return new RedisRateLimitStore(
        redis,
        `${RATE_LIMIT_KEY_PREFIX}${route}${KEY_SEPARATOR}`,
      )
    }
  }
}
```

- [ ] **Step 5: Ligar em `registerRateLimit`**

Em `src/infra/http/rate-limit.ts`, os imports (`old` → `new`):

```ts
import { clientIpKey } from './client-ip.js'
```
```ts
import { clientIpKey } from './client-ip.js'
import type { RateLimitRedis } from './redis-rate-limit-store.js'
import { createScopedRateLimitStore } from './scoped-rate-limit-store.js'
```

O parágrafo do docstring sobre o store em processo (`old` → `new`):

```ts
 * The store is in-process. With N replicas the effective ceiling is N times the
 * configured one — one more reason the limit that matters belongs at the edge.
```
```ts
 * A route that declares its own ceiling counts in `redis`, shared by every
 * replica, and refuses while it is unreachable. Every other route counts in
 * process, so N replicas give N times the global ceiling (decision 39). Without
 * `redis`, every route counts in process.
```

A assinatura (`old` → `new`):

```ts
  env: RateLimitEnv,
): Promise<void> {
```
```ts
  env: RateLimitEnv,
  redis?: RateLimitRedis,
): Promise<void> {
```

E o fim do objeto de opções (`old` → `new`):

```ts
    keyGenerator: (request) => normalizeIP(clientIpKey(request)),
  })
```
```ts
    keyGenerator: (request) => normalizeIP(clientIpKey(request)),
    ...(redis === undefined ? {} : { store: createScopedRateLimitStore(redis) }),
  })
```

- [ ] **Step 6: Rodar e ver passar**

```bash
pnpm test:unit src/infra/http
pnpm lint:fix && pnpm lint && pnpm typecheck
```

Expected: `rate-limit.spec.ts` com 9 testes PASS, `redis-rate-limit-store.spec.ts` com 4 PASS; lint e typecheck limpos.

- [ ] **Step 7: Commit**

```bash
git add src/infra/http/local-store.d.ts src/infra/http/scoped-rate-limit-store.ts src/infra/http/rate-limit.ts src/infra/http/rate-limit.spec.ts
git commit -m "feat(infra): scope the rate limit store by who declares the ceiling"
```

---

### Task 5: Compor no `buildApp`, o `/health` e o isolamento dos testes

**Files:**
- Create: `src/infra/health/checks/redis-check.ts`
- Test: `src/infra/health/checks/redis-check.spec.ts`
- Modify: `src/infra/http/endpoints/health.ts`
- Modify: `src/main/app.ts`
- Create: `tests/integration/setup/redis.ts`
- Create: `tests/integration/setup/flush-redis-before-file.ts`
- Modify: `vitest.config.ts`
- Modify: `tests/integration/health.spec.ts`, `tests/integration/login.spec.ts`, `tests/integration/change-password.spec.ts`

**Interfaces:**
- Consumes: `createRedis`, `connectRedis`, `closeRedis` (Task 2); `registerRateLimit(app, env, redis)` (Task 4).
- Produces: `checkRedis(redis: HealthRedis): Promise<HealthCheckResult>`; `HealthRedis = Pick<Redis, 'ping'>`; `flushRedis(): Promise<void>` em `tests/integration/setup/redis.ts`; o corpo do `/health` ganha `redis: 'up' | 'down'`.

- [ ] **Step 1: O spec do check de saúde (red)**

Crie `src/infra/health/checks/redis-check.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { checkRedis, type HealthRedis } from './redis-check.js'

function redisWithPing(ping: () => Promise<unknown>): HealthRedis {
  return { ping: vi.fn(ping) } as unknown as HealthRedis
}

describe('checkRedis', () => {
  it('reports up when the server answers the PING', async () => {
    const result = await checkRedis(redisWithPing(async () => 'PONG'))

    expect(result).toEqual({ name: 'redis', up: true })
  })

  it('reports down, carrying the error, when the PING fails', async () => {
    const failure = new Error('Command timed out')

    const result = await checkRedis(
      redisWithPing(async () => {
        throw failure
      }),
    )

    expect(result).toEqual({ name: 'redis', up: false, error: failure })
  })
})
```

Run: `pnpm test:unit src/infra/health/checks/redis-check.spec.ts` — Expected: FAIL (módulo inexistente).

- [ ] **Step 2: O check**

Crie `src/infra/health/checks/redis-check.ts`:

```ts
import type { Redis } from 'ioredis'
import type { HealthCheckResult } from '#infra/health/checks/database-check'

const REDIS_CHECK_NAME = 'redis'

/** The one command the probe issues, so a test double needs only this. */
export type HealthRedis = Pick<Redis, 'ping'>

export async function checkRedis(redis: HealthRedis): Promise<HealthCheckResult> {
  try {
    await redis.ping()
    return { name: REDIS_CHECK_NAME, up: true }
  } catch (error) {
    return { name: REDIS_CHECK_NAME, up: false, error }
  }
}
```

Run: `pnpm test:unit src/infra/health/checks/redis-check.spec.ts` — Expected: 2 PASS.

- [ ] **Step 3: Atualizar o `health.spec.ts` de integração (red)**

Os corpos esperados passam a ter `redis` (`old` → `new`):

```ts
const OK_BODY = { status: 'ok', database: 'up' }
```
```ts
const OK_BODY = { status: 'ok', database: 'up', redis: 'up' }
```
```ts
const DOWN_BODY = { status: 'error', database: 'down' }
```
```ts
const DOWN_BODY = { status: 'error', database: 'down', redis: 'up' }
```

Acrescente, depois de `UNREACHABLE_DATABASE_URL`:

```ts
// Same idea for Redis: the connection is refused, a real failure.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'
const REDIS_DOWN_BODY = { status: 'ok', database: 'up', redis: 'down' }
```

E um caso novo, logo depois de `reports 503 when the database is unreachable`:

```ts
  // A red probe would take every replica out of rotation, routes that never
  // touch Redis included. Redis is reported, and never decides the status.
  it('stays 200 and reports redis down when only Redis is unreachable', async () => {
    const response = await injectHealth({
      ...env,
      REDIS_URL: UNREACHABLE_REDIS_URL,
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json()).toEqual(REDIS_DOWN_BODY)
  })
```

Run: `pnpm test:integration tests/integration/health.spec.ts` — Expected: FAIL (o endpoint ainda não devolve `redis`).

- [ ] **Step 4: O endpoint `/health`**

Em `src/infra/http/endpoints/health.ts`, os imports (`old` → `new`):

```ts
import { checkDatabase } from '#infra/health/checks/database-check'
```
```ts
import { checkDatabase } from '#infra/health/checks/database-check'
import { checkRedis, type HealthRedis } from '#infra/health/checks/redis-check'
```

A descrição (`old` → `new`):

```ts
const HEALTH_DESCRIPTION =
  'Reports whether the service is up and its dependencies are reachable. ' +
  'Returns 503 when any dependency is down, so an orchestrator can pull the ' +
  'instance out of rotation.'
```
```ts
const HEALTH_DESCRIPTION =
  'Reports whether the service is up and its dependencies are reachable. ' +
  'Returns 503 when the database is down, so an orchestrator can pull the ' +
  'instance out of rotation. Redis is reported but never fails the probe.'
```

Os literais e os schemas (`old` → `new`):

```ts
const DATABASE_UP = 'up' as const
const DATABASE_DOWN = 'down' as const
```
```ts
const DATABASE_UP = 'up' as const
const DATABASE_DOWN = 'down' as const
const REDIS_UP = 'up' as const
const REDIS_DOWN = 'down' as const
```
```ts
const okSchema = z.object({
  status: z.literal(OK_STATUS),
  database: z.literal(DATABASE_UP),
})
const downSchema = z.object({
  status: z.literal(ERROR_STATUS),
  database: z.literal(DATABASE_DOWN),
})
```
```ts
const redisSchema = z.enum([REDIS_UP, REDIS_DOWN])
const okSchema = z.object({
  status: z.literal(OK_STATUS),
  database: z.literal(DATABASE_UP),
  redis: redisSchema,
})
const downSchema = z.object({
  status: z.literal(ERROR_STATUS),
  database: z.literal(DATABASE_DOWN),
  redis: redisSchema,
})
```

A assinatura do plugin (`old` → `new`):

```ts
export const healthRoute: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
```
```ts
export const healthRoute: FastifyPluginAsync<{
  db: Database
  redis: HealthRedis
}> = async (app, { db, redis }) => {
```

E o handler (`old` → `new`):

```ts
      const database = await checkDatabase(db)

      if (!database.up) {
        request.log.error(database.error, 'database health check failed')
        return reply
          .status(SERVICE_UNAVAILABLE_STATUS)
          .send({ status: ERROR_STATUS, database: DATABASE_DOWN })
      }

      return { status: OK_STATUS, database: DATABASE_UP }
```
```ts
      const [database, redisCheck] = await Promise.all([
        checkDatabase(db),
        checkRedis(redis),
      ])
      // Not logged here: an outage is already reported once, when the client
      // loses the connection, and a probe polling every few seconds would repeat
      // it for as long as it lasts.
      const redisStatus = redisCheck.up ? REDIS_UP : REDIS_DOWN

      if (!database.up) {
        request.log.error(database.error, 'database health check failed')
        return reply
          .status(SERVICE_UNAVAILABLE_STATUS)
          .send({ status: ERROR_STATUS, database: DATABASE_DOWN, redis: redisStatus })
      }

      return { status: OK_STATUS, database: DATABASE_UP, redis: redisStatus }
```

- [ ] **Step 5: Compor no `buildApp`**

Em `src/main/app.ts`, os imports (`old` → `new`):

```ts
import { createLogger } from '#infra/observability/logger'
```
```ts
import { createLogger } from '#infra/observability/logger'
import { closeRedis, connectRedis, createRedis } from '#infra/redis/client'
```

Uma constante, depois de `const AUTH_PREFIX = '/auth'`:

```ts
const REDIS_UNREACHABLE_AT_STARTUP_MESSAGE =
  'redis unreachable at startup; routes with their own rate limit answer 503 until it connects'
```

O cliente, logo depois do `onClose` do pool (`old` → `new`):

```ts
  app.addHook('onClose', () => pool.end())
```
```ts
  app.addHook('onClose', () => pool.end())

  const redis = createRedis(env, logger)
  app.addHook('onClose', () => closeRedis(redis))
  // The process starts even when Redis is down: the routes that count in it
  // refuse (decision 39) and the rest serve, and the client keeps reconnecting.
  // Refusing to boot would turn a Redis maintenance window into an outage of the
  // whole API.
  if (!(await connectRedis(redis))) {
    logger.warn(REDIS_UNREACHABLE_AT_STARTUP_MESSAGE)
  }
```

O limitador e o `/health` (`old` → `new`):

```ts
  await registerRateLimit(app, env)
```
```ts
  await registerRateLimit(app, env, redis)
```
```ts
  await app.register(healthRoute, { db })
```
```ts
  await app.register(healthRoute, { db, redis })
```

- [ ] **Step 6: O isolamento dos contadores nos testes**

Ao contrário do store em memória, os contadores do Redis **sobrevivem** a uma instância do app: sem limpeza, um arquivo herda o que o anterior gastou contra a mesma rota e endereço.

Crie `tests/integration/setup/redis.ts`:

```ts
import { Redis } from 'ioredis'
import { env } from '#infra/config/env'

/**
 * Empties the test Redis. Counters outlive an app instance — unlike the
 * in-process store they replace — so a case that asserts on a ceiling has to
 * start from zero. `env.REDIS_URL` is the fixture `vitest.config.ts` injects,
 * never a `.env` value.
 */
export async function flushRedis(): Promise<void> {
  const redis = new Redis(env.REDIS_URL)

  try {
    await redis.flushdb()
  } finally {
    redis.disconnect()
  }
}
```

Crie `tests/integration/setup/flush-redis-before-file.ts`:

```ts
import { beforeAll } from 'vitest'
import { flushRedis } from './redis.js'

// Runs once per spec file, before any of its cases: a file starts from zero
// whatever the previous one spent against the same route and address.
beforeAll(flushRedis)
```

Em `vitest.config.ts`, a constante e o `setupFiles` (`old` → `new`):

```ts
const INTEGRATION_GLOBAL_SETUP = './tests/integration/setup/migrate-test-database.ts'
```
```ts
const INTEGRATION_GLOBAL_SETUP = './tests/integration/setup/migrate-test-database.ts'
const INTEGRATION_SETUP_FILE = './tests/integration/setup/flush-redis-before-file.ts'
```
```ts
          globalSetup: [INTEGRATION_GLOBAL_SETUP],
```
```ts
          globalSetup: [INTEGRATION_GLOBAL_SETUP],
          setupFiles: [INTEGRATION_SETUP_FILE],
```

Os dois casos que afirmam o teto (`login.spec.ts` e `change-password.spec.ts`) gastaram tentativas na mesma chave antes; sem zerar, passariam pelo motivo errado (o primeiro pedido já sairia 429). Em cada um, importe e zere no início do caso.

`tests/integration/login.spec.ts` (`old` → `new`):

```ts
import { arrangeAccount } from './setup/arrange-account.js'
```
```ts
import { arrangeAccount } from './setup/arrange-account.js'
import { flushRedis } from './setup/redis.js'
```
```ts
  it('answers 429 in the envelope once the login ceiling is passed', async () => {
    const throttled = await buildApp({
```
```ts
  it('answers 429 in the envelope once the login ceiling is passed', async () => {
    // The cases above spent attempts against this same Redis key.
    await flushRedis()

    const throttled = await buildApp({
```

`tests/integration/change-password.spec.ts` (`old` → `new`):

```ts
import { arrangeAccount } from './setup/arrange-account.js'
```
```ts
import { arrangeAccount } from './setup/arrange-account.js'
import { flushRedis } from './setup/redis.js'
```
```ts
  it('answers 429 in the envelope once this route ceiling is passed', async () => {
```
```ts
  it('answers 429 in the envelope once this route ceiling is passed', async () => {
    // The cases above spent attempts against this same Redis key.
    await flushRedis()

```

- [ ] **Step 7: Rodar tudo que existia**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
pnpm test:integration
```

Expected: tudo verde. Se algum spec de integração falhar por 429 inesperado, ele gasta tentativas de uma rota com teto próprio sem elevar esse teto: eleve-o no `buildApp` do spec, como os vizinhos já fazem (`CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS`).

- [ ] **Step 8: Commit**

```bash
git add src/infra/health src/infra/http/endpoints/health.ts src/main/app.ts tests/integration vitest.config.ts
git commit -m "feat(infra): wire Redis into the app and report it on /health"
```

---

### Task 6: As provas de integração

**Files:**
- Test: `tests/integration/shared-rate-limit.spec.ts`

**Interfaces:**
- Consumes: `buildApp(env, { logStream? })` (Task 5), `flushRedis()` (Task 5), o Redis de teste (Task 1).
- Produces: nada além dos testes. Este é o teste que **prova o problema do TODO**: antes da fatia ele falha.

- [ ] **Step 1: Escrever o spec**

Crie `tests/integration/shared-rate-limit.spec.ts`:

```ts
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Env, env } from '#infra/config/env'
import { buildApp } from '#main/app'
import { flushRedis } from './setup/redis.js'

// Spelled out rather than imported from the endpoints: these values ARE the
// wire contract. Importing them would make the assertions tautological.
const LOGIN_PATH = '/auth/login'
const ME_PATH = '/auth/me'
const POST_METHOD = 'POST'
const GET_METHOD = 'GET'

const UNAUTHORIZED_STATUS_CODE = 401
const TOO_MANY_REQUESTS_STATUS_CODE = 429
const SERVICE_UNAVAILABLE_STATUS_CODE = 503

const STORE_UNAVAILABLE_CODE = 'RATE_LIMIT_STORE_UNAVAILABLE'
const RETRY_AFTER_HEADER = 'retry-after'

// Port 1 is never a Redis: the connection is refused, a real failure.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'

/** Small on purpose: the cases assert the behaviour, not the shipped numbers. */
const LOGIN_CEILING = 3
const GLOBAL_CEILING = 2

// An account that does not exist: the request is answered as a wrong credential,
// so it counts against the ceiling without needing any arranged state.
const UNKNOWN_ACCOUNT = { email: 'ninguem@example.com', password: 'wr0ng-p4ssword!' }

const openApps: FastifyInstance[] = []

beforeEach(flushRedis)

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

/**
 * Each call is one more replica: its own process-local state, the same Redis.
 * `logStream` is optional because `BuildServerOptions` does not admit an
 * explicit `undefined` for it.
 */
async function startReplica(
  overrides: Partial<Env> = {},
  logStream?: Writable,
): Promise<FastifyInstance> {
  const app = await buildApp(
    { ...env, ...overrides },
    logStream === undefined ? {} : { logStream },
  )
  openApps.push(app)
  await app.ready()

  return app
}

const login = (app: FastifyInstance) =>
  app.inject({ method: POST_METHOD, url: LOGIN_PATH, payload: UNKNOWN_ACCOUNT })

/** Answered by the auth guard with 401, so it costs nothing and counts globally. */
const me = (app: FastifyInstance) => app.inject({ method: GET_METHOD, url: ME_PATH })

describe('the shared rate limit', () => {
  // The problem the slice exists to close: with a counter per process, three
  // attempts split between two replicas were never more than two on either.
  it('holds one ceiling across two replicas', async () => {
    const overrides = { LOGIN_RATE_LIMIT_MAX_REQUESTS: LOGIN_CEILING }
    const first = await startReplica(overrides)
    const second = await startReplica(overrides)

    expect((await login(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(second)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect((await login(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)

    // The fourth is over the ceiling on EITHER replica.
    expect((await login(second)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
    expect((await login(first)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
  })

  // The other half of decision 39: the global ceiling is deliberately per
  // replica, so it neither costs a round trip nor depends on Redis.
  it('keeps the global ceiling per replica', async () => {
    const overrides = { RATE_LIMIT_MAX_REQUESTS: GLOBAL_CEILING }
    const first = await startReplica(overrides)
    const second = await startReplica(overrides)

    for (let sent = 0; sent < GLOBAL_CEILING; sent++) {
      expect((await me(first)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    }
    expect((await me(first)).statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)

    // The other replica has not seen any of those requests.
    expect((await me(second)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('refuses the routes with their own ceiling, and only those, while Redis is down', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
    const app = await startReplica({ REDIS_URL: UNREACHABLE_REDIS_URL }, stream)

    const refused = await login(app)

    expect(refused.statusCode).toBe(SERVICE_UNAVAILABLE_STATUS_CODE)
    expect(refused.json().error.code).toBe(STORE_UNAVAILABLE_CODE)
    expect(refused.headers[RETRY_AFTER_HEADER]).toBeDefined()

    // A route with no ceiling of its own never touches Redis: the auth guard
    // answers it as it would with Redis up.
    expect((await me(app)).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)

    // The refusal is a security event, so it is in the log.
    expect(lines.join('')).toContain(`"code":"${STORE_UNAVAILABLE_CODE}"`)
  })
})
```

- [ ] **Step 2: Rodar**

```bash
pnpm db:up
pnpm test:integration tests/integration/shared-rate-limit.spec.ts
```

Expected: 3 testes PASS.

- [ ] **Step 3: Provar que a suíte detecta o problema**

Sem isto o teste pode passar por acidente. Desligue a divisão por um instante e veja o caso falhar:

```bash
sed -i 's/await registerRateLimit(app, env, redis)/await registerRateLimit(app, env)/' src/main/app.ts
pnpm test:integration tests/integration/shared-rate-limit.spec.ts
git checkout src/main/app.ts
```

Expected: FAIL em `holds one ceiling across two replicas` (a quarta tentativa na segunda réplica devolve 401, não 429) e em `refuses the routes with their own ceiling…` (o login devolve 401, não 503). O `git checkout` desfaz a alteração; confirme com `git diff --stat src/main/app.ts` (sem saída).

- [ ] **Step 4: Rodar de novo, limpo, e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
pnpm test:integration tests/integration/shared-rate-limit.spec.ts
git add tests/integration/shared-rate-limit.spec.ts
git commit -m "test(infra): prove the ceiling is shared across replicas and fails closed"
```

Expected: 3 PASS.

---

### Task 7: Docs, emendas da spec e verificação final

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/TODO.md`, `ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-09-19-shared-rate-limit-store-design.md`
- Modify: `docs/superpowers/specs/2026-09-02-rate-limiting-design.md`

**Interfaces:**
- Consumes: tudo das tarefas 1–6.
- Produces: a decisão 39, que os comentários do código já citam.

- [ ] **Step 1: A decisão 39**

O arquivo **não termina** na decisão 38: depois dela vêm um `---` e a seção
"7. Pendências de manutenção". A 39 entra logo depois da 38, antes desse `---`.
O `assert` garante que o ponto de inserção existe uma única vez.

```bash
python3 - <<'PYEOF'
path = 'docs/DECISIONS.md'
decision = """### 39 — Rate limit compartilhado no Redis, por rota, com fail-closed

Fecha o item #1 de "Pendências do boilerplate". O contador do limitador vivia
na memória de cada processo, então com N réplicas o teto efetivo de qualquer
rota era N× o configurado. O balanceador já reparte as requisições entre as
réplicas, então um único endereço recebia N baldes sem tentar nada. E como a §6
recusou o bloqueio por conta, o teto por endereço e o custo do argon2 são as
duas únicas defesas contra chute de senha: multiplicar uma delas por N cortava
metade do que sobrava.

**A divisão.** Rota que **declara o próprio teto** (`config.rateLimit`) conta no
Redis, compartilhado entre as réplicas. Rota sem teto próprio segue no teto
global de 300/min, **em memória, por réplica**. O plugin já faz essa separação:
chama `store.child()` só para as rotas com configuração própria, e é por esse
método que o Redis entra. Nenhum módulo recebe o cliente Redis. Hoje são nove
rotas, todas do `auth`; uma rota de produto que um dia declarar um teto
apertado entra no Redis sem tocar no store.

**Fail-closed.** Com o Redis fora, essas rotas respondem **503 com
`Retry-After`** (`RateLimitStoreUnavailableError`, uma `TransientError`) e as
demais seguem no ar. A escolha é de segurança: numa rota que carrega palpite de
senha, degradar para "sem teto" é o pior lugar, e sem teto cada tentativa custa
um argon2 (7,3 ms, 19 MB), o que expõe a CPU além das senhas. O erro nasce com
`securityEvent = true`: sem isso o handler devolve o 503 sem uma linha de log, e
um controle que parou de controlar passaria por tráfego comum.

**A premissa que sustenta o fail-closed, dita claramente:** o Redis é operado
por quem opera o app, e cai só em manutenção programada. Ela reabre a decisão
quando um app derivado (a) roda num ambiente em que o Redis não é confiável, ou
(b) exige disponibilidade de login acima da proteção contra chute. A saída é
fail-open por rota, com alerta — nunca desligar o teto em silêncio.

**Store nosso, não o `RedisStore` do plugin.** O erro do Redis precisa virar
`TransientError`, o `RedisStore` não é exportado (o pacote não tem `exports`) e
traz recursos que o projeto não usa. O incremento e a expiração rodam num único
script Lua, atômico: em dois comandos, uma queda entre `INCR` e `PEXPIRE`
deixaria a chave sem validade e aquele endereço bloqueado para sempre.

**O cliente falha rápido.** `ioredis` com fila offline desligada e
`commandTimeout`. Medido na versão 6.0.0: com as opções padrão, um comando
contra um Redis fora do ar ficou pendurado por mais de 12 s; com a fila
desligada, falha em 0 ms. Sem isso o "recusar" viraria requisição pendurada.

**`/health` mostra o Redis e não decide o 503.** Se decidisse, o orquestrador
tiraria todas as réplicas de circulação e a API inteira cairia, inclusive as
rotas que nunca tocam o Redis.

**Custos aceitos.**

1. O teto global é N×: 300/min com três réplicas são 900/min. Ele é uma rede de
   segurança grossa, não a defesa contra chute.
2. As nove rotas caem juntas quando o Redis cai: login, cadastro, confirmação e
   reenvio de e-mail, esquecer e redefinir senha, trocar senha, deletar conta e
   Google.
3. Um `warn` por requisição recusada durante a queda: ruído aceito em troca de a
   queda ser visível.
4. Importação de um arquivo interno do plugin (`LocalStore`), com o pacote em
   versão exata; um spec quebra se ele sumir.
5. Uma ida de rede a mais nessas nove rotas: 0,20 ms em loopback.
6. O endereço do cliente fica no Redis pelo tempo da janela — dado pessoal, com
   validade de segundos.
7. Todo entrypoint valida o mesmo env: o `cron` e o seed passam a exigir
   `REDIS_URL` mesmo sem usar o Redis.

Spec: [`specs/2026-09-19-shared-rate-limit-store-design.md`](superpowers/specs/2026-09-19-shared-rate-limit-store-design.md).
"""
anchor = '\n---\n\n## 7. Pendências de manutenção'
text = open(path).read()
assert text.count(anchor) == 1
open(path, 'w').write(text.replace(anchor, '\n' + decision + anchor))
PYEOF
grep -n '^### 3[89]' docs/DECISIONS.md
```

Expected: as linhas das decisões 38 e 39, nessa ordem, ambas antes de `## 7.`.

- [ ] **Step 2: O `TODO.md`**

O parágrafo do cabeçalho, antes do da fatia 21 (`old` → `new`):

```
> **Fatia 21 (2026-09-19) entregou o contexto de dispositivo na sessão, os
```
```
> **Fatia 22 (2026-09-19) entregou o store de rate limit compartilhado no
> Redis** (decisão 39). Fecha o item #1 de "Pendências do boilerplate". As rotas
> que **declaram o próprio teto** (as nove do `auth`) passam a contar num Redis
> comum às réplicas e a recusar com 503 quando ele cai; o teto global de 300/min
> continua em memória, por réplica, e não depende do Redis. A premissa que
> sustenta o fail-closed — Redis operado por quem opera o app — está na decisão,
> junto do que a reabre.
>
> **Fatia 21 (2026-09-19) entregou o contexto de dispositivo na sessão, os
```

A linha #1 da tabela, riscada (o `python` evita brigar com o `|` e o `*` no `sed`):

```bash
python3 - <<'EOF'
path = 'docs/TODO.md'
row = (
    '| 1 | ~~Store do rate limit é in-process~~ | — | **fechado pela fatia 22.** '
    'Rota com teto próprio conta num Redis compartilhado e recusa com 503 quando '
    'ele cai; o teto global segue em memória, por réplica. Decisão 39 |'
)
lines = open(path).read().split('\n')
marker = '| 1 | **Store do rate limit é in-process**'
assert sum(l.startswith(marker) for l in lines) == 1
open(path, 'w').write('\n'.join(row if l.startswith(marker) else l for l in lines))
EOF
```

E o parágrafo de "O que eu faria a seguir" (`old` → `new`):

```
Os dois primeiros têm natureza diferente dos outros cinco. **Store do rate
limit** e **dispatch do outbox sem trava** não são features ausentes: são
promessas que o boilerplate faz e deixa de cumprir na segunda instância. Um app
de alimentação rodando dois contêineres sofre os dois, e dado sensível não entra
na conta.
```
```
~~Store do rate limit~~ — **fechado pela fatia 22** (decisão 39). O #2,
**dispatch do outbox sem trava**, tem natureza diferente dos outros cinco: não é
feature ausente, é uma promessa que o boilerplate faz e deixa de cumprir na
segunda instância. Um app de alimentação rodando dois contêineres sofre o
problema, e dado sensível não entra na conta.
```

- [ ] **Step 3: A spec do rate limiting original (§10.2) e o `ARCHITECTURE.md`**

Em `docs/superpowers/specs/2026-09-02-rate-limiting-design.md` (`old` → `new`):

```
derivado que suba três pods herda isso, e é mais uma razão para o limite que
importa viver na borda.
```
```
derivado que suba três pods herda isso, e é mais uma razão para o limite que
importa viver na borda.

> **Emendado pela fatia 22 (decisão 39).** O store por processo vale agora só
> para o teto global. As rotas que declaram o próprio teto contam num Redis
> compartilhado, e o "N× o configurado" deixou de valer para elas.
```

Em `ARCHITECTURE.md` (`old` → `new`):

```
Os endpoints checados por `/health` vivem em `infra/health/checks/`, um arquivo
por dependência. O endpoint só agrega e traduz para HTTP — quando entrar Redis
ou uma API externa, cria-se o arquivo irmão em vez de crescer o handler.
```
```
Os endpoints checados por `/health` vivem em `infra/health/checks/`, um arquivo
por dependência. O endpoint só agrega e traduz para HTTP: `redis-check.ts` é o
irmão de `database-check.ts`, e uma API externa ganharia o seu em vez de
crescer o handler. Só o banco decide o status — o Redis é reportado, mas uma
sonda vermelha por causa dele tiraria de circulação até as rotas que nunca o
tocam.
```

- [ ] **Step 4: Levar as medições e as correções para a spec da fatia**

Em `docs/superpowers/specs/2026-09-19-shared-rate-limit-store-design.md`, o §3.4 (`old` → `new`):

```
### 3.4 — A medir na implementação, não assumido

O comportamento padrão do `ioredis` sem cliente conectado (fila de espera e
retentativas) **não foi medido**. A spec parte do que se sabe da biblioteca e o
plano tem uma tarefa que mede antes de fixar os números da §6.
```
```
### 3.4 — O cliente só falha rápido se for configurado para isso

Medido com `ioredis` 6.0.0 contra Redis 8.10.1:

| Situação | Opções padrão | Fila offline desligada + `commandTimeout` |
|---|---|---|
| Porta sem ninguém ouvindo | comando pendurado por mais de 12 s | falha em 0 ms |
| Conexão viva, servidor travado (`CLIENT PAUSE`) | — | falha em 251 ms, com `commandTimeout` de 250 |
| Servidor derrubado por 4 s e religado | — | responde 101 ms depois de o servidor responder ao `PING`, com a reconexão limitada a 500 ms |

O script Lua da §5 devolveu `[1, 1000]` e `[2, 1000]`, reiniciou a janela depois
de ela expirar, e deu validade a uma chave que a tinha perdido. A ida ao Redis
custa 0,20 ms em loopback.
```

A tabela do §6 (`old` → `new`):

```
| `REDIS_CONNECT_TIMEOUT_MS` | 1000 (inicial) | Valor a confirmar na medição da §3.4 |
| `REDIS_COMMAND_TIMEOUT_MS` | 250 (inicial) | Idem. Precisa ser bem menor que o timeout de requisição, senão o fail-closed vira requisição pendurada |
```
```
| `REDIS_CONNECT_TIMEOUT_MS` | 1000 | Limita só a conexão; um comando não espera por ela (§3.4) |
| `REDIS_COMMAND_TIMEOUT_MS` | 250 | Dispara em 251 ms (§3.4). Precisa ser bem menor que o timeout de requisição, senão o fail-closed vira requisição pendurada |
```

O formato da chave no §5 (`old` → `new`):

```
`<prefixo>:<método>:<url>-`
```
```
`<prefixo><método>:<url>:`
```

O §11, um oitavo custo, depois do item 7 (`old` → `new`):

```
   disponibilidade de login acima da proteção contra chute: aí a opção é
   fail-open por rota, com alerta.
```
```
   disponibilidade de login acima da proteção contra chute: aí a opção é
   fail-open por rota, com alerta.
8. **Todo entrypoint valida o mesmo env**: o `cron` e o seed passam a exigir
   `REDIS_URL` mesmo sem usar o Redis.
```

E o §12, que listava um arquivo que não existe para este caso (`old` → `new`):

```
- `STRUCTURE.md`: os arquivos novos da §5.
```
```
- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) §7: o check de Redis, que a frase
  sobre `infra/health/checks/` já previa.
```

- [ ] **Step 5: Verificação final**

```bash
pnpm lint && pnpm typecheck && pnpm test:unit
pnpm db:up
pnpm test:integration
pnpm build
```

Expected: tudo verde; `test:integration` inclui os 3 casos novos de `shared-rate-limit.spec.ts` e os 4 de `redis-client.spec.ts`.

- [ ] **Step 6: A prova de ponta a ponta, com o binário compilado**

```bash
export NODE_ENV=production PORT=3999 \
  DATABASE_URL=postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5433/api_clean_platform_test \
  REDIS_URL=redis://127.0.0.1:6380 \
  JWT_SECRET=a-local-smoke-secret-with-at-least-32-chars \
  GOOGLE_CLIENT_ID=smoke.apps.googleusercontent.com \
  JWT_ISSUER=smoke JWT_AUDIENCE=smoke \
  MAIL_HOST=smtp.invalid MAIL_PORT=587 MAIL_FROM='Smoke <no-reply@invalid>' MAIL_REQUIRE_TLS=true
node dist/main/http.js > /tmp/smoke.log 2>&1 &
SERVER=$!
sleep 3
curl -sS localhost:3999/health; echo
docker stop api-clean-platform-redis-test >/dev/null
sleep 1
echo "--- Redis down ---"
curl -sS localhost:3999/health; echo
curl -sS -o /dev/null -w 'login: %{http_code}\n' -X POST localhost:3999/auth/login \
  -H 'content-type: application/json' -d '{"email":"a@example.com","password":"wr0ng-p4ssword!"}'
curl -sS -o /dev/null -w 'me:    %{http_code}\n' localhost:3999/auth/me
docker start api-clean-platform-redis-test >/dev/null
sleep 3
echo "--- Redis back ---"
curl -sS -o /dev/null -w 'login: %{http_code}\n' -X POST localhost:3999/auth/login \
  -H 'content-type: application/json' -d '{"email":"a@example.com","password":"wr0ng-p4ssword!"}'
kill $SERVER; unset NODE_ENV PORT DATABASE_URL REDIS_URL JWT_SECRET GOOGLE_CLIENT_ID JWT_ISSUER JWT_AUDIENCE MAIL_HOST MAIL_PORT MAIL_FROM MAIL_REQUIRE_TLS
grep -c '"code":"RATE_LIMIT_STORE_UNAVAILABLE"' /tmp/smoke.log; grep -o 'redis connection [a-z]*' /tmp/smoke.log
```

Expected, nesta ordem:
- `/health` → `{"status":"ok","database":"up","redis":"up"}`
- com o Redis parado: `/health` → `200` com `"redis":"down"`; `login: 503`; `me: 401`
- com o Redis de volta: `login: 401`
- o log tem ao menos uma linha `RATE_LIMIT_STORE_UNAVAILABLE`, e as transições `redis connection ready`, `redis connection lost`, `redis connection ready`, nessa ordem.

- [ ] **Step 7: Commit**

```bash
git add docs ARCHITECTURE.md
git commit -m "docs(infra): record decision 39 and close the shared rate limit item"
```

---

## Depois do plano

Com os testes verdes, a regra do `CLAUDE.md` global manda invocar `superpowers:finishing-a-development-branch`, e dele `finish-with-review-pr` logo depois do Step 1 (testes passando), antes do menu de integração. A branch é `feat/shared-rate-limit-store`. O PR sai como rascunho, com o resumo e o mapa de componentes em Mermaid.
