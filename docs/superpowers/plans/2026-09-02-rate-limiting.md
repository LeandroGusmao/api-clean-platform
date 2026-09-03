# Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar teto de requisição por IP à API — global e mais apertado no login —, e antes disso consertar as duas premissas de IP que a medição derrubou, sem as quais qualquer limitador conta errado.

**Architecture:** O limitador é `@fastify/rate-limit`, registrado por `registerRateLimit(app, env)` em `infra/http/`. Ele não conta falha de autenticação — isso foi deliberadamente delegado à borda (spec §10.1). Duas peças o precedem: `TRUST_PROXY`, que decide se `request.ip` significa alguma coisa atrás de proxy, e `clientIpKey`, que garante que o valor é um endereço antes de virar chave. O `429` sai no envelope do projeto por um ramo novo no error handler, sem categoria nova na taxonomia.

**Tech Stack:** Node 24 · TypeScript 7 · Fastify 5.12.1 · `@fastify/rate-limit` 11.2.0 · Zod 4.4.3 · Vitest 4 · Biome

**Spec:** [`docs/superpowers/specs/2026-09-02-rate-limiting-design.md`](../specs/2026-09-02-rate-limiting-design.md)

## Global Constraints

- **Código e comentário em inglês.** Markdown pode ser português (`CLAUDE.md`).
- **Zero magic string/number.** Todo literal vira constante `UPPER_SNAKE_CASE` nomeada, perto de onde é usada.
- **Dependência pinada em versão exata.** Nenhum `^`, nenhum `~` (`ARCHITECTURE.md` §11).
- **R6 — só `infra/config/env.ts` lê `process.env`.**
- **R7 — camada pura não produz valor não determinístico.** Nada desta fatia entra na camada pura.
- **Decisão 13 — o error handler é o único lugar que conhece status HTTP.**
- **Decisão 15 — use case não loga e não recebe logger.**
- **Portão de qualidade:** `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` verdes. **Rodar cada um sozinho e ler o exit code** — `pnpm lint | tail -1` devolve o status do `tail`, não do lint.
- **Postgres:** `docker compose up -d` antes dos testes de integração.

### Fatos já medidos — não re-verificar, não presumir o contrário

| Fato | Onde veio |
|---|---|
| `trustProxy: <número ≥ 1>` constrói e **nunca confia em ninguém** (`fastify/lib/request.js:50-54`) | spec §3.1 |
| CIDR inválido lança **na construção**, `TypeError: invalid IP address: <token>`, `code: undefined` | spec §3.1 |
| `0`, `false` e `''` em `trustProxy` são observacionalmente idênticos | spec §3.1 |
| `request.ip` devolve o último token do `X-Forwarded-For` **cru** quando o peer é confiado | spec §3.2 |
| O `429` do plugin **passa** pelo `setErrorHandler` como `Error` com `statusCode: 429`, `code: undefined` | spec §6 |
| O plugin define `retry-after` na reply **antes** de lançar, e o header sobrevive | spec §6 |
| `allowList: ['/health']` **não** isenta — compara com a chave, não com o path | spec §6 |
| `config: { rateLimit: false }` na rota isenta de verdade | spec §6 |
| Rota inexistente (404): o plugin **não roda** | spec §10.4 |
| `normalizeIP` agrupa IPv6 por /64 e é importável como named export | spec §5 |

---

### Task 1: `TRUST_PROXY` no env e no servidor

**Files:**
- Modify: `src/infra/config/env.ts`
- Modify: `src/infra/http/server.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Test: `src/infra/config/env.spec.ts`
- Docs: `ARCHITECTURE.md` §11

**Interfaces:**
- Consumes: nada.
- Produces: `Env['TRUST_PROXY']: string | false`, exportado no tipo `Env`. A Task 4 lê `env.TRUST_PROXY` indiretamente (já aplicado no servidor); nenhuma task o lê de novo.

- [ ] **Step 1: Write the failing tests**

Em `src/infra/config/env.spec.ts`, dentro do `describe('parseEnv', ...)` existente:

```ts
  it('refuses TRUST_PROXY=true, which trusts a client-written header', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: 'true',
    })

    expect(result.success).toBe(false)
  })

  // Measured on Fastify 5.12.1: a numeric trustProxy is fail-closed and never
  // trusts anyone, so accepting it would publish a knob that does nothing.
  it('refuses a hop count, which Fastify silently ignores', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: '1',
    })

    expect(result.success).toBe(false)
  })

  it('treats an absent, empty or zero TRUST_PROXY as trusting nothing', () => {
    for (const value of [undefined, '', '0', '00']) {
      const result = parseEnv({
        DATABASE_URL: VALID_DATABASE_URL,
        JWT_SECRET: VALID_JWT_SECRET,
        ...(value === undefined ? {} : { TRUST_PROXY: value }),
      })

      expect(result.success).toBe(true)
      expect(result.success && result.data.TRUST_PROXY).toBe(false)
    }
  })

  it('keeps a trusted network list as the string Fastify parses', () => {
    const result = parseEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
      TRUST_PROXY: ' 10.0.0.0/8,loopback ',
    })

    expect(result.success).toBe(true)
    expect(result.success && result.data.TRUST_PROXY).toBe('10.0.0.0/8,loopback')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit -- src/infra/config/env.spec.ts`
Expected: FAIL — `TRUST_PROXY` não existe no schema, então `result.data.TRUST_PROXY` é `undefined` e os `refuses` passam por acidente. **Confirme que os quatro casos falham pelo motivo certo** antes de seguir.

- [ ] **Step 3: Add the schema**

Em `src/infra/config/env.ts`, acima de `coreEnvSchema`:

```ts
const TRUST_PROXY_NUMERIC_PATTERN = /^\d+$/
const TRUST_PROXY_BOOLEAN_LITERALS = ['true', 'false']
const TRUST_PROXY_TRUST_NOTHING = false

const TRUST_PROXY_REFUSAL =
  'must be empty (trust nothing) or a comma-separated list of trusted ' +
  'networks, such as `10.0.0.0/8,loopback`. `true` is refused because it ' +
  'trusts the LEFTMOST X-Forwarded-For entry, which the client writes — ' +
  'anyone could forge a fresh address per request. A hop count is refused ' +
  'because Fastify 5 ignores it: a numeric trustProxy is fail-closed and ' +
  'never trusts anyone, so the knob would look configured and do nothing.'

/**
 * Which proxies may speak for the client. Output is `string | false` — no
 * number ever reaches Fastify, by the refusal above.
 *
 * `.default('')` sits BEFORE the transform on purpose: Zod 4's default is the
 * OUTPUT type and short-circuits parsing (ARCHITECTURE.md §11), so placed after
 * it would have to be `string | false` and would skip both refinements.
 *
 * The CIDR syntax itself is NOT validated here. Fastify compiles the list
 * eagerly and dies at boot on an invalid entry — even inside an otherwise valid
 * list — so a second implementation would only add a way for the two to drift.
 */
const trustProxySchema = z
  .string()
  .trim()
  .default('')
  .refine((raw) => !TRUST_PROXY_BOOLEAN_LITERALS.includes(raw), TRUST_PROXY_REFUSAL)
  .refine(
    (raw) => !(TRUST_PROXY_NUMERIC_PATTERN.test(raw) && Number(raw) > 0),
    TRUST_PROXY_REFUSAL,
  )
  .transform((raw) =>
    raw === '' || TRUST_PROXY_NUMERIC_PATTERN.test(raw)
      ? TRUST_PROXY_TRUST_NOTHING
      : raw,
  )
```

E dentro de `coreEnvSchema`, junto às outras chaves:

```ts
  TRUST_PROXY: trustProxySchema,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit -- src/infra/config/env.spec.ts`
Expected: PASS

- [ ] **Step 5: Apply it in `buildServer` and fix the fixture**

Em `src/infra/http/server.ts`, dentro do objeto passado a `Fastify({ ... })`:

```ts
    // Decides whether `request.ip` means anything at all. Behind a load
    // balancer with this unset, every request carries the balancer's address:
    // an IP-keyed limiter would put the whole world in one bucket and ban
    // everyone at once — and it works perfectly on a laptop, where there is no
    // proxy. The value is `string | false`; the env schema refuses the two
    // forms that fail silently.
    trustProxy: env.TRUST_PROXY,
```

Em `src/infra/config/fixtures/test-env.ts`, adicione ao objeto `TEST_ENV`:

```ts
  TRUST_PROXY: false,
```

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm test:unit`
Expected: PASS. `pnpm typecheck` também — o `Env` ganhou um campo e o fixture tem de cobri-lo.

- [ ] **Step 7: Document the trap in `ARCHITECTURE.md` §11**

Na seção *"Bibliotecas que falham em silêncio"*, acrescente (em português, como o resto do arquivo):

```markdown
> **`trustProxy` com número é inoperante — e parece configurado.** Medido no
> Fastify 5.12.1: `trustProxy: 1` constrói sem erro e **nunca confia em
> ninguém**, porque `lib/request.js` devolve `() => false` para qualquer número
> ("hop-count-only trust cannot validate the immediate peer"). `request.ip` fica
> preso no `remoteAddress`, e atrás de um load balancer isso significa que todo
> cliente compartilha um endereço. É o valor que todo tutorial mostra. Por isso
> `TRUST_PROXY` **recusa número no boot** e só aceita lista de redes.
>
> No mesmo assunto: uma lista com CIDR inválido morre na **construção** da
> instância — inclusive quando só um item da lista é inválido —, mas como um
> `TypeError` cru do `@fastify/proxy-addr`, com `message: "invalid IP address:
> <token>"` e **`code: undefined`**. Não é `FST_*` e não sai no formato de erro
> de env do projeto: se o boot morrer com um `TypeError` sem contexto, é isto.
```

- [ ] **Step 8: Commit**

```bash
git add src/infra/config/env.ts src/infra/config/env.spec.ts src/infra/config/fixtures/test-env.ts src/infra/http/server.ts ARCHITECTURE.md
git commit -m "feat: make TRUST_PROXY explicit, and refuse the two forms that fail silently"
```

---

### Task 2: `clientIpKey`

**Files:**
- Create: `src/infra/http/client-ip.ts`
- Test: `src/infra/http/client-ip.spec.ts`
- Docs: `ARCHITECTURE.md` §11

**Interfaces:**
- Consumes: nada da Task 1 em código; depende dela conceitualmente.
- Produces: `clientIpKey(request: FastifyRequest): string` e `UNPARSEABLE_CLIENT_IP_KEY: string`. A Task 4 usa `clientIpKey` dentro do `keyGenerator`.

- [ ] **Step 1: Write the failing test**

Crie `src/infra/http/client-ip.spec.ts`:

```ts
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { clientIpKey, UNPARSEABLE_CLIENT_IP_KEY } from '#infra/http/client-ip'

/** Only `ip` is read, so a literal is enough — no server, no I/O. */
const requestWithIp = (ip: string) => ({ ip }) as FastifyRequest

const LONG_FORGED_IP = 'A'.repeat(200)

describe('clientIpKey', () => {
  it('keeps a valid IPv4 address', () => {
    expect(clientIpKey(requestWithIp('203.0.113.7'))).toBe('203.0.113.7')
  })

  // Measured: @fastify/rate-limit's own key generator groups IPv6 by /64, and
  // overriding it would throw that away. A single subscriber owns 2^64
  // addresses, so per-address keying limits nothing at all for them.
  it('groups IPv6 addresses by their /64, case-insensitively', () => {
    const first = clientIpKey(requestWithIp('2001:DB8:0:1::5'))
    const second = clientIpKey(requestWithIp('2001:db8:0:1::99'))

    expect(first).toBe(second)
  })

  // Measured on Fastify 5.12.1: with a trusted peer, `request.ip` is the last
  // X-Forwarded-For token verbatim — attacker-chosen text of arbitrary width.
  it.each(['naoehip', '1.2.3.4a', '999.999.999.999', '1.2.3.4:5678', LONG_FORGED_IP])(
    'collapses the malformed value %#into a single bucket',
    (forged) => {
      expect(clientIpKey(requestWithIp(forged))).toBe(UNPARSEABLE_CLIENT_IP_KEY)
    },
  )

  it('never returns a key wider than a textual IPv6 address', () => {
    expect(clientIpKey(requestWithIp(LONG_FORGED_IP)).length).toBeLessThanOrEqual(45)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- src/infra/http/client-ip.spec.ts`
Expected: FAIL — `Cannot find module '#infra/http/client-ip'`

- [ ] **Step 3: Write the implementation**

Crie `src/infra/http/client-ip.ts`:

```ts
import { normalizeIP } from '@fastify/rate-limit'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'

/**
 * The one bucket every unusable value shares. A single constant and not the
 * socket address: falling back to the peer would put every client behind the
 * proxy into one bucket, which is the opposite of what this protects.
 */
export const UNPARSEABLE_CLIENT_IP_KEY = 'unparseable-client-ip'

const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

/**
 * The rate limit key for a request, and the only place `request.ip` is turned
 * into one.
 *
 * `request.ip` is NOT guaranteed to be an address. Measured on Fastify 5.12.1:
 * with a trusted peer it returns the last X-Forwarded-For token verbatim —
 * `naoehip`, `999.999.999.999`, 200 characters of `A`. It is attacker-chosen
 * text of arbitrary width, and a store keyed on it lets the attacker pick both
 * how many entries exist and how many bytes each one costs.
 *
 * Two steps, and both are load-bearing:
 *
 * 1. **Validate.** Anything malformed collapses to ONE bucket, so a client
 *    forging addresses throttles itself and the keyspace it can open stays at
 *    one. Validation also caps the width, since a textual IPv6 address is at
 *    most 45 characters.
 * 2. **Normalize.** Replacing the plugin's `keyGenerator` discards the
 *    `normalizeIP` it would have applied, and that default groups IPv6 by /64.
 *    Without it a subscriber's 2^64 addresses are 2^64 free buckets — the
 *    limiter would not limit IPv6 clients at all.
 */
export function clientIpKey(request: FastifyRequest): string {
  const parsed = clientIpSchema.safeParse(request.ip)

  return parsed.success ? normalizeIP(parsed.data) : UNPARSEABLE_CLIENT_IP_KEY
}
```

> ⚠️ Este arquivo importa `@fastify/rate-limit`, que a **Task 4** instala. Se a
> ordem de execução colocar a Task 2 antes, rode o `pnpm add` do Step 1 da Task 4
> agora e siga.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- src/infra/http/client-ip.spec.ts`
Expected: PASS

- [ ] **Step 5: Document the trap in `ARCHITECTURE.md` §11**

```markdown
> **`request.ip` não é um endereço IP.** Medido no Fastify 5.12.1: quando o peer
> é confiado, ele devolve **o último token do `X-Forwarded-For` sem validação
> nenhuma** — `naoehip`, `999.999.999.999`, `<script>alert(1)</script>` e uma
> string de 200 caracteres saíram todas intactas. `typeof` é sempre `string` e
> nada lança, então o código parece certo. Quem usar esse valor como chave,
> índice ou campo persistido está deixando o atacante escolher o conteúdo **e o
> tamanho**. Passe por `infra/http/client-ip.ts`, que valida e normaliza.
```

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/client-ip.ts src/infra/http/client-ip.spec.ts ARCHITECTURE.md
git commit -m "feat: turn request.ip into a bounded, normalized rate limit key"
```

---

### Task 3: `TOO_MANY_REQUESTS` no error handler

**Files:**
- Modify: `src/infra/http/errors/error-response.ts`
- Modify: `src/infra/http/errors/error-handler.ts`
- Test: `src/infra/http/errors/error-handler.spec.ts`
- Docs: `ARCHITECTURE.md` §8

**Interfaces:**
- Consumes: nada.
- Produces: `TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'`, exportado de `error-response.ts`. A Task 5 o reescreve à mão no spec de integração (nunca o importa).

- [ ] **Step 1: Write the failing test**

Em `src/infra/http/errors/error-handler.spec.ts`. O arquivo já tem o helper
`injectThrow(error)`, que monta o servidor, registra uma rota que lança e
devolve `{ statusCode, json, headers, log }` — use-o.

Junto às outras constantes de contrato do topo:

```ts
const TOO_MANY_REQUESTS_STATUS = 429
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'
```

E um `describe` novo:

```ts
describe('error handler — rate limiting', () => {
  /**
   * Shaped like what @fastify/rate-limit throws: a plain Error carrying
   * `statusCode`, with no `code` of its own (measured). Built here rather than
   * imported, so this suite does not need the plugin to run.
   */
  const rateLimitError = () => {
    const error = new Error('Rate limit exceeded, retry in 1 minute')
    Object.assign(error, { statusCode: TOO_MANY_REQUESTS_STATUS })
    return error
  }

  // Without a branch of its own it lands in the generic 4xx path and publishes
  // BAD_REQUEST — "you sent something wrong" instead of "you sent too much".
  it('publishes TOO_MANY_REQUESTS rather than BAD_REQUEST', async () => {
    const result = await injectThrow(rateLimitError())

    expect(result.statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
    expect(result.json()).toEqual({
      error: {
        code: TOO_MANY_REQUESTS_CODE,
        message: 'Rate limit exceeded, retry in 1 minute',
        traceId: expect.stringMatching(UUID_PATTERN),
      },
    })
  })

  it('produces a body that satisfies the published error schema', async () => {
    const result = await injectThrow(rateLimitError())

    expect(errorResponseSchema.safeParse(result.json()).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- src/infra/http/errors/error-handler.spec.ts`
Expected: FAIL — recebido `"BAD_REQUEST"`, esperado `"TOO_MANY_REQUESTS"`. Esse vermelho **é a prova** de que o ramo genérico engoliria o 429.

- [ ] **Step 3: Add the code constant**

Em `src/infra/http/errors/error-response.ts`, junto aos outros códigos:

```ts
export const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'
```

- [ ] **Step 4: Add the branch**

Em `src/infra/http/errors/error-handler.ts`, adicione a constante de status junto às outras:

```ts
const TOO_MANY_REQUESTS_STATUS = 429
```

Importe `TOO_MANY_REQUESTS_CODE` de `./error-response.js` e insira o ramo **imediatamente antes** de `if (isClientError(error))`:

```ts
  // Must precede the generic 4xx branch, which would flatten this into
  // BAD_REQUEST — and "you sent something wrong" is the opposite of "you sent
  // too much, come back later". Keyed on the status rather than on the rate
  // limit plugin's error, so the library's name never becomes public contract:
  // the same reasoning that keeps FST_ERR_* out of the envelope.
  //
  // No `Retry-After` is set here. The plugin already put it on the reply before
  // throwing, and it survives (measured) — setting a second one would overwrite
  // a real remaining-seconds value with a guess.
  if (isClientError(error) && error.statusCode === TOO_MANY_REQUESTS_STATUS) {
    return reply
      .status(TOO_MANY_REQUESTS_STATUS)
      .send(buildErrorResponse(TOO_MANY_REQUESTS_CODE, error.message, traceId))
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit -- src/infra/http/errors/error-handler.spec.ts`
Expected: PASS, e nenhum outro caso do arquivo vermelho.

- [ ] **Step 6: Update the `ARCHITECTURE.md` §8 table**

A tabela *"As quatro coisas que não são da taxonomia"* ganha uma linha — **e o título vira "As cinco coisas"**, porque ele conta as linhas e a auditoria pega comentário que mente:

```markdown
| `429` do rate limiting | 429 `TOO_MANY_REQUESTS` + `Retry-After` | o plugin lança um `Error` com `statusCode`; sem ramo próprio cairia no 4xx genérico e publicaria `BAD_REQUEST`. **Não é categoria nova**: nasce no transporte, e a taxonomia continua com sete |
```

E, logo abaixo da frase que diz que `TransientError` é a única categoria com header, acrescente:

```markdown
O `429` também sai com `Retry-After`, mas ele **não vem da taxonomia** — quem o
define é o próprio plugin, com os segundos que faltam de verdade para a janela
virar.
```

- [ ] **Step 7: Commit**

```bash
git add src/infra/http/errors/error-response.ts src/infra/http/errors/error-handler.ts src/infra/http/errors/error-handler.spec.ts ARCHITECTURE.md
git commit -m "feat: give 429 its own code instead of flattening it into BAD_REQUEST"
```

---

### Task 4: O teto global e a isenção do `/health`

**Files:**
- Modify: `package.json` (via `pnpm add`)
- Modify: `src/infra/config/env.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Create: `src/infra/http/rate-limit.ts`
- Modify: `src/infra/http/endpoints/health.ts`
- Modify: `src/main/app.ts`
- Test: `src/infra/http/rate-limit.spec.ts`
- Docs: `ARCHITECTURE.md` §2

**Interfaces:**
- Consumes: `clientIpKey` (Task 2); `TOO_MANY_REQUESTS_CODE` já publicado (Task 3).
- Produces: `registerRateLimit(app: FastifyInstance, env: RateLimitEnv): Promise<void>`, onde `RateLimitEnv = Pick<Env, 'RATE_LIMIT_MAX_REQUESTS' | 'RATE_LIMIT_WINDOW_SECONDS'>`. A Task 5 não a chama; ela só declara `config` na rota.

- [ ] **Step 1: Install the plugin, pinned exactly**

```bash
pnpm add @fastify/rate-limit@11.2.0
```

**Aconteceu de verdade em 2026-09-02:** o `pnpm add` recusou com
`ERR_PNPM_UNEXPECTED_STORE`, porque o snap do VS Code pulou da revisão 255 para
a 259 e o `node_modules` continua linkado da 255. O contorno é usar a store que
**a própria mensagem de erro nomeia** como a atual do `node_modules`:

```bash
pnpm add --store-dir /home/legusmao/snap/code/255/.local/share/pnpm/store/v11 \
  @fastify/rate-limit@11.2.0
```

O número da revisão muda a cada atualização do snap — leia-o da mensagem de erro
em vez de copiar este comando.

Confirme que `package.json` gravou `"@fastify/rate-limit": "11.2.0"` — **sem `^`**.

- [ ] **Step 2: Write the failing test**

Crie `src/infra/http/rate-limit.spec.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ENV } from '#infra/config/fixtures/test-env'
import { registerErrorHandling } from '#infra/http/errors/error-handler'
import { registerRateLimit } from '#infra/http/rate-limit'
import { buildServer } from '#infra/http/server'

const MAX_REQUESTS = 2
const OK_STATUS = 200
const TOO_MANY_REQUESTS_STATUS = 429
const GET_METHOD = 'GET'

const ENV = {
  ...TEST_ENV,
  RATE_LIMIT_MAX_REQUESTS: MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS: 60,
}

let app: FastifyInstance

afterEach(() => app?.close())

async function buildLimitedServer() {
  const built = buildServer(ENV)
  registerErrorHandling(built)
  await registerRateLimit(built, ENV)
  built.get('/x', async () => ({ ok: true }))
  built.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }))
  await built.ready()
  return built
}

describe('registerRateLimit', () => {
  it('answers 429 in the project envelope once the ceiling is passed', async () => {
    app = await buildLimitedServer()

    for (let attempt = 0; attempt < MAX_REQUESTS; attempt++) {
      expect((await app.inject({ method: GET_METHOD, url: '/x' })).statusCode).toBe(
        OK_STATUS,
      )
    }

    const blocked = await app.inject({ method: GET_METHOD, url: '/x' })

    expect(blocked.statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
    expect(blocked.json().error.code).toBe('TOO_MANY_REQUESTS')
    expect(blocked.json().error.traceId).toEqual(expect.any(String))
    // Set by the plugin before it throws, and it survives the error handler.
    expect(blocked.headers['retry-after']).toBeDefined()
  })

  // If this ever goes red, a Kubernetes liveness probe starts taking 429s and
  // the orchestrator kills the pod: the limiter would take down the very
  // application it exists to protect.
  it('never throttles the health route', async () => {
    app = await buildLimitedServer()

    for (let attempt = 0; attempt < MAX_REQUESTS * 3; attempt++) {
      expect((await app.inject({ method: GET_METHOD, url: '/health' })).statusCode).toBe(
        OK_STATUS,
      )
    }
  })

  // Measured: `request.ip` can be attacker-written text, so two forged values
  // must not buy two budgets.
  it('gives every malformed client address the same budget', async () => {
    app = await buildLimitedServer()
    const forged = (value: string) =>
      app.inject({ method: GET_METHOD, url: '/x', headers: { 'x-forwarded-for': value } })

    await forged('naoehip')
    await forged('outro-lixo')

    expect((await forged('um-terceiro')).statusCode).toBe(TOO_MANY_REQUESTS_STATUS)
  })
})
```

> A terceira asserção só é significativa com `trustProxy` ativo. Use
> `{ ...ENV, TRUST_PROXY: 'loopback' }` no `buildServer` dessa suíte — o
> `app.inject` chega de `127.0.0.1`, que `loopback` confia.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:unit -- src/infra/http/rate-limit.spec.ts`
Expected: FAIL — `Cannot find module '#infra/http/rate-limit'`

- [ ] **Step 4: Add the env variables**

Em `src/infra/config/env.ts`:

```ts
/**
 * A flood ceiling, not a UX limit: a chatty single-page app does not come near
 * 300 requests a minute from one address, and an attacker producing more is not
 * browsing. The limit that matters lives at the edge, which sees every replica.
 */
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 300
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60
```

Dentro de `coreEnvSchema`:

```ts
  // `.positive()` and not `.nonnegative()`, exactly as for PORT: a ceiling of
  // zero would refuse every request, and rejecting zero is also what rejects an
  // empty value.
  RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_MAX_REQUESTS),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
```

E em `src/infra/config/fixtures/test-env.ts`, importando as duas constantes:

```ts
  RATE_LIMIT_MAX_REQUESTS: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
```

- [ ] **Step 5: Write the registration**

Crie `src/infra/http/rate-limit.ts`:

```ts
import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import type { Env } from '#infra/config/env'
import { clientIpKey } from './client-ip.js'

const MILLISECONDS_PER_SECOND = 1000

/**
 * Only the two values the limiter consumes. Declaring the narrow type IS the
 * slice (decision 23): callers pass `env` whole and this function still cannot
 * see `DATABASE_URL`.
 */
export type RateLimitEnv = Pick<
  Env,
  'RATE_LIMIT_MAX_REQUESTS' | 'RATE_LIMIT_WINDOW_SECONDS'
>

/**
 * A per-address ceiling on every route. It counts REQUESTS, not failed
 * authentications — no transport limiter can know a password was wrong. That
 * half was deliberately delegated to the edge and to the cost of argon2; the
 * reasoning and what reopens it are in the slice's design §10.1.
 *
 * Registered as a function rather than inline in `buildApp` for the same reason
 * `registerErrorHandling` and `registerOpenApi` are: a spec can then mount a
 * bare server and exercise the limiter without a database.
 *
 * The store is in-process. With N replicas the effective ceiling is N times the
 * configured one — which is one more reason the limit that matters belongs at
 * the edge.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  env: RateLimitEnv,
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    // Replaces the plugin's default, which reads `request.ip` raw. `normalizeIP`
    // is applied on top because overriding the generator would otherwise throw
    // away the /64 grouping that makes IPv6 limiting mean anything.
    keyGenerator: (request) => normalizeIP(clientIpKey(request)),
  })
}
```

> **Não use `allowList` para isentar rotas.** Medido: o array de strings é
> comparado com a **chave gerada**, não com o path — `allowList: ['/health']`
> não isenta nada e cinco chamadas ao `/health` tomam 429. A isenção vai na
> rota, no Step 6.

- [ ] **Step 6: Exempt the health route**

Em `src/infra/http/endpoints/health.ts`, no objeto de opções da rota, junto de `schema`:

```ts
      /**
       * Never rate limited, and this is correctness rather than convenience: a
       * liveness probe that takes a 429 makes the orchestrator kill the pod, so
       * the limiter would take down the application it exists to protect.
       *
       * Declared on the route and not in the plugin's `allowList` for two
       * reasons: `allowList` compares against the generated KEY and not the
       * path, so a list of paths silently exempts nothing (measured); and an
       * exemption that matches a path by string would break in silence the day
       * the route is renamed.
       */
      config: { rateLimit: false },
```

- [ ] **Step 7: Register it in `buildApp`**

Em `src/main/app.ts`, importe `registerRateLimit` e chame-o **antes** de qualquer rota, logo após `await app.register(fastifyCookie)`:

```ts
  // Before any route: the ceiling has to cover everything registered after it.
  await registerRateLimit(app, env)
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test:unit -- src/infra/http/rate-limit.spec.ts`
Expected: PASS

Run: `pnpm test:unit`
Expected: PASS. Se algum spec existente que dispara muitas requisições ficar vermelho, **não afrouxe o teto de produção** — dê àquela suíte um `RATE_LIMIT_MAX_REQUESTS` próprio no env que ela passa ao `buildServer`.

- [ ] **Step 9: Update the `ARCHITECTURE.md` §2 tree**

Acrescente `client-ip.ts` e `rate-limit.ts` sob `infra/http/`.

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml src/infra/config/env.ts src/infra/config/fixtures/test-env.ts src/infra/http/rate-limit.ts src/infra/http/rate-limit.spec.ts src/infra/http/endpoints/health.ts src/main/app.ts ARCHITECTURE.md
git commit -m "feat: put a per-address request ceiling on every route but the probe"
```

---

### Task 5: O teto apertado do login

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/constants.ts`
- Modify: `src/modules/auth/infra/http/endpoints/login.ts`
- Test: `tests/integration/login.spec.ts`

**Interfaces:**
- Consumes: `registerRateLimit` já ativo (Task 4); `TOO_MANY_REQUESTS_CODE` (Task 3).
- Produces: `AuthContainer['loginRateLimit']: { max: number; timeWindow: number }`.

- [ ] **Step 1: Raise the ceiling for the existing suite**

⚠️ **Sem este passo a fatia quebra 16 casos existentes.** `login.spec.ts` faz
**16 chamadas de login**, todas do mesmo endereço do `app.inject`, contra um app
montado uma vez no `beforeAll`. Com o teto de 10 por minuto, os casos do meio do
arquivo passariam a receber `429` — incluindo
`answers an unknown email exactly like a wrong password`, o guardião da
indistinguibilidade.

O conserto **não** é afrouxar o default de produção. É dar à suíte um env
próprio. Em `tests/integration/login.spec.ts`:

```ts
/**
 * This suite spends far more login attempts than any human would, from a single
 * injected address. The production default stays untouched: the one case that
 * exercises the ceiling builds its own app with its own ceiling.
 */
const CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS = 1000
```

E no `beforeAll`:

```ts
  app = await buildApp({
    ...env,
    LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS,
  })
```

- [ ] **Step 2: Write the failing integration test**

Ainda em `tests/integration/login.spec.ts`, junto às constantes de contrato
escritas à mão no topo:

```ts
const TOO_MANY_REQUESTS_STATUS_CODE = 429
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'
/** Small on purpose: the case asserts the behaviour, not the shipped number. */
const CEILING_UNDER_TEST = 3
```

E o caso, com app próprio para não gastar o orçamento dos outros:

```ts
  it('answers 429 in the envelope once the login ceiling is passed', async () => {
    const throttled = await buildApp({
      ...env,
      LOGIN_RATE_LIMIT_MAX_REQUESTS: CEILING_UNDER_TEST,
    })

    try {
      let last = await throttled.inject({
        method: POST_METHOD,
        url: LOGIN_PATH,
        payload: { email: EMAIL, password: WRONG_PASSWORD },
      })

      // One past the ceiling.
      for (let attempt = 0; attempt < CEILING_UNDER_TEST; attempt++) {
        last = await throttled.inject({
          method: POST_METHOD,
          url: LOGIN_PATH,
          payload: { email: EMAIL, password: WRONG_PASSWORD },
        })
      }

      expect(last.statusCode).toBe(TOO_MANY_REQUESTS_STATUS_CODE)
      expect(last.json().error.code).toBe(TOO_MANY_REQUESTS_CODE)
      expect(last.json().error.traceId).toEqual(expect.any(String))
      // Set by the plugin before it throws; it survives the error handler.
      expect(last.headers['retry-after']).toBeDefined()
    } finally {
      // Also ends this app's database pool, via the onClose hook in `app.ts`.
      await throttled.close()
    }
  })
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `docker compose up -d && pnpm test:integration -- tests/integration/login.spec.ts`
Expected: FAIL — as quatro tentativas respondem `401`; nunca chega a `429`.

- [ ] **Step 3: Add the module's variables**

Em `src/modules/auth/config.ts`:

```ts
/**
 * Ten failed guesses a minute from one address. It counts REQUESTS and not
 * failures — the transport cannot know a password was wrong — so it is a cost
 * multiplier on brute force, not a lockout.
 */
export const DEFAULT_LOGIN_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60
```

E no `authEnvSchema`:

```ts
  LOGIN_RATE_LIMIT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LOGIN_RATE_LIMIT_MAX_REQUESTS),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS),
```

> Estas duas são do **módulo** e não do core porque quem declara o teto é a
> **rota**, via `config` no schema do endpoint — e rota é do módulo (decisões 14
> e 23). É também por isso que o login tem janela própria: reusar
> `RATE_LIMIT_WINDOW_SECONDS` faria o módulo ler uma variável do core.

- [ ] **Step 4: Publish it on the container**

Em `src/modules/auth/container.ts`, no objeto de retorno, junto de `refreshTokenTtlSeconds`:

```ts
    /**
     * The route declares its own ceiling, so the endpoint needs the numbers.
     * Milliseconds here because that is what the plugin's `timeWindow` takes,
     * and converting at the edge keeps the endpoint free of arithmetic.
     */
    loginRateLimit: {
      max: config.LOGIN_RATE_LIMIT_MAX_REQUESTS,
      timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    },
```

- [ ] **Step 5: Declare it on the route**

Em `src/modules/auth/infra/http/constants.ts`:

```ts
export const TOO_MANY_REQUESTS_STATUS = 429
```

Em `src/modules/auth/infra/http/endpoints/login.ts`, no objeto de opções da rota:

```ts
      /**
       * Tighter than the global ceiling: this is the one endpoint where a
       * request carries a password guess. It counts requests and not failures,
       * so a legitimate user retrying a typo spends the same budget — ten a
       * minute is far above human retry and far below useful brute force.
       */
      config: { rateLimit: container.loginRateLimit },
```

E no `response` do schema:

```ts
          [TOO_MANY_REQUESTS_STATUS]: errorResponseSchema,
```

- [ ] **Step 6: Confirm the rest of the suite is untouched**

Rode o arquivo inteiro e confirme que **nenhum caso anterior virou 429** — em
especial `answers an unknown email exactly like a wrong password`. Ele continua
verde porque o limitador conta requisição e nunca consulta o repositório: e-mail
inexistente e e-mail real gastam orçamento igual.

Se ainda assim algum caso estourar, o conserto é subir
`CEILING_ABOVE_WHAT_THIS_SUITE_SPENDS`, **nunca** mexer no default de produção.

- [ ] **Step 7: Run the tests**

Run: `pnpm test:integration -- tests/integration/login.spec.ts`
Expected: PASS, **incluindo** `answers an unknown email exactly like a wrong password`, que continua verde porque o limitador conta requisição e nunca consulta o repositório.

Run: `pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/container.ts src/modules/auth/infra/http/constants.ts src/modules/auth/infra/http/endpoints/login.ts tests/integration/login.spec.ts
git commit -m "feat: give login a tighter ceiling than the rest of the API"
```

---

### Task 6: Fechar a decisão e passar os portões

**Files:**
- Modify: `docs/DECISIONS.md` §6
- Modify: `.env.example` se existir

**Interfaces:**
- Consumes: todas as tasks anteriores.
- Produces: nada em código.

- [ ] **Step 1: Falsify the tests**

Uma a uma, aplique a mutação, rode a suíte, confirme o vermelho **no alvo
previsto e em nenhum outro**, e desfaça:

| Mutação | Vermelho esperado |
|---|---|
| o schema passa a aceitar `TRUST_PROXY=1` | `refuses a hop count` |
| `keyGenerator` usa `request.ip` cru | `gives every malformed client address the same budget` |
| `clientIpKey` devolve `parsed.data` sem `normalizeIP` | `groups IPv6 addresses by their /64` |
| tire `config: { rateLimit: false }` do `/health` | `never throttles the health route` |
| tire o ramo do 429 do handler | `publishes TOO_MANY_REQUESTS for a 429` |
| tire o `config: { rateLimit }` da rota de login | o 429 do login na integração |

Teste que não ficar vermelho não prova nada — se algum ficar verde sob a
mutação, **conserte o teste** antes de seguir.

- [ ] **Step 2: Close the open decision**

Em `docs/DECISIONS.md` §6, substitua o item *"Rate limiting e proteção contra
brute force"* por:

```markdown
- ~~**Rate limiting e proteção contra brute force**~~ — **RESOLVIDA em
  2026-09-02.** Entrou teto por IP com `@fastify/rate-limit` (global, e mais
  apertado no login), `TRUST_PROXY` explícito e `clientIpKey`. A **contagem de
  falha de autenticação NÃO entrou**, e isso é decisão: só a aplicação sabe que
  a senha estava errada, mas implementá-la exigiria porta de store, política de
  dois baldes na camada pura, teto de memória com despejo e um caminho próprio
  para Redis — para reimplementar, pior, o que a borda já faz. Fica delegada à
  borda e ao custo do argon2 (7,3 ms e 19 MB por tentativa).
  **O que isso custa, dito claramente:** uma conta de e-mail conhecido e senha
  fraca pode ser quebrada por uma botnet paciente, e nada no servidor vai notar.
  **Gatilho para reabrir:** o primeiro app derivado que trate dado sensível
  (saúde, financeiro), ou o primeiro incidente de conta comprometida por força
  bruta.
  Desenho em [`specs/2026-09-02-rate-limiting-design.md`](superpowers/specs/2026-09-02-rate-limiting-design.md).
```

- [ ] **Step 3: Document the new variables in `.env.example`**

O arquivo existe. Acrescente as cinco variáveis com os defaults, e em
`TRUST_PROXY` um comentário de uma linha dizendo que número e `true` são
recusados no boot — é lá que alguém vai olhar antes do primeiro deploy atrás de
proxy.

- [ ] **Step 4: Run every gate, one at a time**

```bash
pnpm lint
echo "lint: $?"
pnpm typecheck
echo "typecheck: $?"
pnpm test
echo "test: $?"
pnpm build
echo "build: $?"
```

Leia **cada exit code**. Encadear com `| tail -1` devolve o status do `tail`.

- [ ] **Step 5: Run the architecture audit**

Use a skill `architecture-audit` com `--base main`. Ela pega comentário que
mente — e esta fatia acrescentou muitos comentários com números medidos.
Expected: 0 achados.

- [ ] **Step 6: Commit**

```bash
git add docs/DECISIONS.md .env.example
git commit -m "docs: close the rate limiting decision, and name what delegating it costs"
```

---

## Notas para quem executa

**A ordem importa em dois lugares.** A Task 2 importa `@fastify/rate-limit`, que
a Task 4 instala — se executar fora de ordem, rode o `pnpm add` antes. E a Task 3
precede a Task 4 de propósito: com o ramo do 429 já no handler, o spec do
limitador assere o envelope final em vez de asserir `BAD_REQUEST` e ser
reescrito.

**O que esta fatia deliberadamente não faz.** Não conta falha de autenticação.
Se você se pegar adicionando um contador de tentativas, um balde por e-mail ou
uma porta de store, **pare**: isso foi avaliado e recusado, e o §10.1 da spec diz
por quê. Reabrir é decisão de produto, não iniciativa de implementação.

**Não afrouxe limite para teste passar.** Se uma suíte bater no teto, o conserto
é dar àquela suíte um env próprio — nunca mexer no default que vai para produção.
