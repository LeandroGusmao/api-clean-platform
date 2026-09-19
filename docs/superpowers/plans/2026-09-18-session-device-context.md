# Fatia 21 — Contexto de dispositivo na sessão: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar IP, rótulo de aparelho e início da sessão em cada refresh token, expor os três em `GET /auth/sessions`, exigir `iss`/`aud` no access token, e ligar `helmet` com TTL de access token de 15 minutos.

**Architecture:** As três colunas entram na tabela `refresh_tokens` que já existe, nuláveis. `RefreshTokenIssuer.issue()` é o funil único por onde todo refresh token nasce, e passa a receber um quarto argumento com o contexto já resolvido pelo chamador — abertura de sessão monta o contexto a partir da request, rotação monta herdando da linha que substitui. Um helper novo em `src/infra/http/device-context.ts` é o único ponto que transforma uma `FastifyRequest` nesses valores, espelhando o `client-ip.ts` que já existe.

**Tech Stack:** TypeScript ESM, Fastify 5.12.1, Drizzle ORM + Postgres, Zod, `jose` (JWT), Vitest (projetos `unit` e `integration`), Biome. Dependências novas: `bowser` (MIT) e `@fastify/helmet` 13.1.1 (MIT).

**Spec:** [`docs/superpowers/specs/2026-09-18-session-device-context-design.md`](../specs/2026-09-18-session-device-context-design.md)

## Global Constraints

- **Idioma:** todo código, identificador, string, mensagem de log/erro e comentário em **inglês**. Só arquivos `.md` podem ser em português.
- **Sem magic string/number:** nada de literal inline. Constante nomeada em `UPPER_SNAKE_CASE`, declarada perto de onde é usada. Exceção: nomes de tabela/coluna/índice dentro de `src/modules/*/infra/drizzle/schema/*.ts`, que são a declaração em si — e a exceção cai no momento em que o nome é lido de outro arquivo.
- **Comentários:** explicam o código onde estão. Nunca história de processo ("a fatia 21 mudou", "o review pediu"). Citar a spec, não reargumentar. Não descrever o comportamento de outro módulo.
- **TDD obrigatório:** teste falhando antes da implementação, em todas as tasks.
- **Relógio:** nunca `new Date()` sem argumento em código de produção — sempre via `IClock` (regra R7). `new Date(millis)` é determinístico e permitido.
- **Dependências novas exatas:** `bowser@2.14.1`, `@fastify/helmet@13.1.1`. Ambas MIT. **`ua-parser-js` é proibida nesta fatia** — a versão atual (`2.0.10`) é AGPL-3.0-or-later.
- **Comandos:** `pnpm test:unit`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`. Migrations por `pnpm db:generate` (nunca escrever SQL de migration à mão).
- **Integração exige banco:** `pnpm db:up` antes de `pnpm test:integration`.

## Estrutura de arquivos

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `src/infra/http/device-context.ts` | Único ponto que converte `FastifyRequest` em `{ ip, label }` |
| `src/infra/http/device-context.spec.ts` | Unit |
| `src/infra/http/helmet.ts` | Registro do plugin, no formato de `cors.ts` |
| `drizzle/<gerado>.sql` | Migration das três colunas (gerada, nunca escrita à mão) |

**Modificar:**

| Arquivo | O que muda |
|---|---|
| `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts` | 3 colunas |
| `src/modules/auth/entities/refresh-token.ts` | 3 campos + getters |
| `src/modules/auth/infra/drizzle/refresh-token-mapper.ts` | 3 campos nas duas direções |
| `src/modules/auth/services/refresh-token-issuer.ts` | 4º parâmetro de `issue()` |
| `src/modules/auth/use-cases/{login-user,confirm-email,change-password,sign-in-with-google}.ts` | command ganha `device` |
| `src/modules/auth/use-cases/refresh-token.ts` | command ganha `ip`; `#issueInto` herda |
| `src/modules/auth/use-cases/list-active-sessions.ts` | resultado ganha 3 campos |
| `src/modules/auth/infra/http/endpoints/{login,confirm-email,change-password,sign-in-with-google,refresh,list-sessions}.ts` | chamam `buildDeviceContext`; `list-sessions` ganha schema |
| `src/modules/auth/infra/providers/jwt-token-signer.ts` | `iss`/`aud` |
| `src/modules/auth/config.ts` | `JWT_ISSUER`, `JWT_AUDIENCE`, TTL 3600→900 |
| `src/infra/config/fixtures/test-env.ts`, `src/infra/config/env.spec.ts` | variáveis novas |
| `src/main/app.ts` | `registerHelmet` |
| `.env.example` | variáveis novas |
| `docs/DECISIONS.md`, `docs/TODO.md` | decisão 38 e emendas |

---

### Task 1: Colunas no schema e migration

**Files:**
- Modify: `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts`
- Test: `tests/integration/refresh-tokens-schema.spec.ts`
- Create: `drizzle/<gerado>.sql` (via `pnpm db:generate`)

**Interfaces:**
- Consumes: nada.
- Produces: colunas `ip` (`text`, nulável), `device_label` (`text`, nulável), `session_started_at` (`timestamptz`, nulável) em `refresh_tokens`. No TypeScript: `refreshTokens.ip`, `refreshTokens.deviceLabel`, `refreshTokens.sessionStartedAt`.

- [ ] **Step 1: Ler o teste de schema existente para seguir o padrão**

```bash
sed -n '1,60p' tests/integration/refresh-tokens-schema.spec.ts
```

Este arquivo já verifica as colunas atuais contra o banco real. Siga exatamente a forma que ele usa para consultar `information_schema` — não invente outra.

- [ ] **Step 2: Escrever o teste falhando**

Adicione ao `tests/integration/refresh-tokens-schema.spec.ts` um caso que afirma que as três colunas existem, são nuláveis e têm o tipo certo. Adapte a forma da query ao que o arquivo já faz; o conteúdo assertivo é este:

```ts
const DEVICE_COLUMNS = [
  { name: 'ip', dataType: 'text', isNullable: 'YES' },
  { name: 'device_label', dataType: 'text', isNullable: 'YES' },
  { name: 'session_started_at', dataType: 'timestamp with time zone', isNullable: 'YES' },
] as const

it.each(DEVICE_COLUMNS)(
  'stores $name as a nullable $dataType',
  async ({ name, dataType, isNullable }) => {
    const [column] = await describeColumn(REFRESH_TOKENS_TABLE, name)

    expect(column).toMatchObject({ data_type: dataType, is_nullable: isNullable })
  },
)
```

Se o arquivo não tiver um helper equivalente a `describeColumn`, escreva a query inline do mesmo jeito que os casos vizinhos fazem.

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
pnpm db:up && pnpm test:integration -- refresh-tokens-schema
```

Esperado: FAIL — a coluna não existe.

- [ ] **Step 4: Adicionar as colunas ao schema**

Em `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts`, dentro do objeto de colunas, logo após `createdAt`:

```ts
    /**
     * The request that created THIS row, so a rotation shows where the client
     * is now. `null` only on rows that predate the column: an unparseable
     * address becomes the sentinel, never null.
     */
    ip: text('ip'),
    /**
     * Derived from the User-Agent at the time the family opened, and inherited
     * by every rotation — it names the DEVICE, which does not change mid
     * session. The raw header is deliberately not stored: §3.2 of the design.
     */
    deviceLabel: text('device_label'),
    /**
     * When the family opened, carried across rotations because rotation
     * discards the row that knew it.
     */
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
```

Os nomes ficam inline pela exceção do `CLAUDE.md`: nenhum dos três é lido de outro arquivo.

- [ ] **Step 5: Gerar a migration**

```bash
pnpm db:generate
```

Confira o SQL gerado: deve ser três `ALTER TABLE ... ADD COLUMN` sem `NOT NULL` e sem `DEFAULT`. Se aparecer qualquer coisa além disso, pare e reporte — não edite o arquivo à mão.

- [ ] **Step 6: Aplicar e rodar o teste**

```bash
pnpm db:migrate && pnpm test:integration -- refresh-tokens-schema
```

Esperado: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/drizzle/schema/refresh-tokens.ts drizzle/ tests/integration/refresh-tokens-schema.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): add device context columns to refresh_tokens

Nullable on purpose: a row that predates the columns has no context, and
filling it with a placeholder would make "never recorded" indistinguishable
from "recorded and unrecognised".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: A entidade `RefreshToken` carrega os três campos

**Files:**
- Modify: `src/modules/auth/entities/refresh-token.ts`
- Modify: `src/modules/auth/infra/drizzle/refresh-token-mapper.ts`
- Test: `src/modules/auth/entities/refresh-token.spec.ts`

**Interfaces:**
- Consumes: as colunas da Task 1.
- Produces:
  - `CreateRefreshTokenProps` e `TrustedRefreshTokenProps` ganham `ip: string | null`, `deviceLabel: string | null`, `sessionStartedAt: Date | null`.
  - `RefreshToken` ganha os getters `ip: string | null`, `deviceLabel: string | null`, `sessionStartedAt: Date | null`.

- [ ] **Step 1: Escrever o teste falhando**

Em `src/modules/auth/entities/refresh-token.spec.ts`:

```ts
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-09-01T10:00:00.000Z')

it('carries the device context through create', () => {
  const token = RefreshToken.create({
    id: ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

  expect(token.ip).toBe(IP)
  expect(token.deviceLabel).toBe(DEVICE_LABEL)
  expect(token.sessionStartedAt).toEqual(SESSION_STARTED_AT)
})

it('accepts a null device context, for rows that predate the columns', () => {
  const token = RefreshToken.create({
    id: ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    ip: null,
    deviceLabel: null,
    sessionStartedAt: null,
  })

  expect(token.ip).toBeNull()
  expect(token.deviceLabel).toBeNull()
  expect(token.sessionStartedAt).toBeNull()
})

it('clones sessionStartedAt on the way out, like every other date', () => {
  const token = RefreshToken.create({
    id: ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
    ip: IP,
    deviceLabel: DEVICE_LABEL,
    sessionStartedAt: SESSION_STARTED_AT,
  })

  const first = token.sessionStartedAt
  first?.setFullYear(1999)

  expect(token.sessionStartedAt).toEqual(SESSION_STARTED_AT)
})
```

Reuse as constantes (`ID`, `USER_ID`, `TOKEN_HASH`, `FAMILY_ID`, `NOW`, `TTL_SECONDS`) que o arquivo já declara; se algum nome diferir, use o do arquivo.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- refresh-token.spec
```

Esperado: FAIL — erro de tipo / `token.ip` é `undefined`.

- [ ] **Step 3: Implementar na entidade**

Em `src/modules/auth/entities/refresh-token.ts`:

1. Em `CreateRefreshTokenProps` e `TrustedRefreshTokenProps`, adicione:

```ts
  /** The request that created this row. See the schema. */
  ip: string | null
  /** Names the device, not the request: inherited across rotations. */
  deviceLabel: string | null
  /** When the family opened. Inherited across rotations. */
  sessionStartedAt: Date | null
```

2. Três campos privados e a atribuição no construtor, usando `cloneNullableDate` para a data:

```ts
  readonly #ip: string | null
  readonly #deviceLabel: string | null
  readonly #sessionStartedAt: Date | null
```

```ts
    this.#ip = props.ip
    this.#deviceLabel = props.deviceLabel
    this.#sessionStartedAt = cloneNullableDate(props.sessionStartedAt)
```

3. Em `create`, repasse os três para o construtor.

4. Três getters, com `cloneNullableDate` no da data:

```ts
  get ip(): string | null {
    return this.#ip
  }

  get deviceLabel(): string | null {
    return this.#deviceLabel
  }

  get sessionStartedAt(): Date | null {
    return cloneNullableDate(this.#sessionStartedAt)
  }
```

- [ ] **Step 4: Atualizar o mapper**

Em `src/modules/auth/infra/drizzle/refresh-token-mapper.ts`, adicione as três chaves nas duas funções:

```ts
  ip: token.ip,
  deviceLabel: token.deviceLabel,
  sessionStartedAt: token.sessionStartedAt,
```

```ts
    ip: row.ip,
    deviceLabel: row.deviceLabel,
    sessionStartedAt: row.sessionStartedAt,
```

- [ ] **Step 5: Rodar unit e typecheck**

```bash
pnpm test:unit -- refresh-token.spec && pnpm typecheck
```

Esperado: os testes da entidade passam. **O `typecheck` vai falhar** nos sete pontos que chamam `RefreshToken.create` sem os campos novos — isso é esperado e é a Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/modules/auth/entities/refresh-token.ts src/modules/auth/entities/refresh-token.spec.ts src/modules/auth/infra/drizzle/refresh-token-mapper.ts
git commit -m "$(cat <<'EOF'
feat(auth): carry device context on the RefreshToken entity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `RefreshTokenIssuer` recebe o contexto

**Files:**
- Modify: `src/modules/auth/services/refresh-token-issuer.ts`
- Test: `src/modules/auth/services/refresh-token-issuer.spec.ts` (crie se não existir)

**Interfaces:**
- Consumes: a entidade da Task 2.
- Produces:

```ts
export interface IssuedSessionContext {
  ip: string | null
  deviceLabel: string | null
  sessionStartedAt: Date | null
}

issue(
  userId: string,
  familyId: string,
  now: Date,
  context: IssuedSessionContext,
): IssuedRefreshToken
```

- [ ] **Step 1: Escrever o teste falhando**

```ts
import { describe, expect, it } from 'vitest'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '9e8d7c6b-5a49-4837-9261-0f1e2d3c4b5a'
const GENERATED_ID = '11111111-2222-4333-8444-555555555555'
const OPAQUE_TOKEN = 'opaque-token'
const NUMERIC_CODE = '000000'
const NOW = new Date('2026-09-18T12:00:00.000Z')
const TTL_SECONDS = 60
const IP = '203.0.113.7'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-09-01T10:00:00.000Z')

const makeIssuer = () =>
  new RefreshTokenIssuer(
    { opaque: () => OPAQUE_TOKEN, numericCode: () => NUMERIC_CODE },
    { hash: (value: string) => `digest:${value}` },
    { generate: () => GENERATED_ID },
    TTL_SECONDS,
  )

describe('RefreshTokenIssuer', () => {
  it('puts the supplied context on the issued entity', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

    expect(entity.ip).toBe(IP)
    expect(entity.deviceLabel).toBe(DEVICE_LABEL)
    expect(entity.sessionStartedAt).toEqual(SESSION_STARTED_AT)
  })

  it('accepts a fully null context', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: null,
      deviceLabel: null,
      sessionStartedAt: null,
    })

    expect(entity.ip).toBeNull()
    expect(entity.deviceLabel).toBeNull()
    expect(entity.sessionStartedAt).toBeNull()
  })
})
```

Confira as assinaturas reais de `ITokenGenerator`, `ITokenDigest` e `IIdGenerator` antes de rodar — se um método tiver outro nome, use o nome real.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- refresh-token-issuer
```

Esperado: FAIL.

- [ ] **Step 3: Implementar**

Em `src/modules/auth/services/refresh-token-issuer.ts`:

```ts
/**
 * Already resolved by the caller, so the issuer does not have to tell a fresh
 * family apart from a rotation: opening a session builds it from the request,
 * rotation inherits it from the row being replaced.
 */
export interface IssuedSessionContext {
  ip: string | null
  deviceLabel: string | null
  sessionStartedAt: Date | null
}
```

```ts
  issue(
    userId: string,
    familyId: string,
    now: Date,
    context: IssuedSessionContext,
  ): IssuedRefreshToken {
    const token = this.tokenGenerator.opaque()

    return {
      token,
      entity: RefreshToken.create({
        id: this.idGenerator.generate(),
        userId,
        tokenHash: this.tokenDigest.hash(token),
        familyId,
        now,
        ttlSeconds: this.ttlSeconds,
        ip: context.ip,
        deviceLabel: context.deviceLabel,
        sessionStartedAt: context.sessionStartedAt,
      }),
    }
  }
```

- [ ] **Step 4: Rodar**

```bash
pnpm test:unit -- refresh-token-issuer
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/services/refresh-token-issuer.ts src/modules/auth/services/refresh-token-issuer.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): take the session context on RefreshTokenIssuer.issue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `buildDeviceContext` na borda HTTP

**Files:**
- Create: `src/infra/http/device-context.ts`
- Create: `src/infra/http/device-context.spec.ts`
- Modify: `package.json` (dependência `bowser`)

**Interfaces:**
- Consumes: `clientIpKey` e `UNPARSEABLE_CLIENT_IP_KEY` de `src/infra/http/client-ip.ts`.
- Produces:

```ts
export const UNKNOWN_DEVICE_LABEL = 'Unknown device'
export const MAX_DEVICE_LABEL_LENGTH = 64
export interface DeviceContext {
  ip: string
  label: string
}
export function buildDeviceContext(request: FastifyRequest): DeviceContext
```

- [ ] **Step 1: Instalar a dependência**

```bash
pnpm add bowser@2.14.1
```

**Não** instale `ua-parser-js`: a versão atual é AGPL-3.0-or-later, e a §3.2 da spec a descarta por isso.

- [ ] **Step 2: Escrever o teste falhando**

Crie `src/infra/http/device-context.spec.ts`:

```ts
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { UNPARSEABLE_CLIENT_IP_KEY } from '#infra/http/client-ip'
import {
  buildDeviceContext,
  MAX_DEVICE_LABEL_LENGTH,
  UNKNOWN_DEVICE_LABEL,
} from '#infra/http/device-context'

const IP = '203.0.113.7'

const CHROME_ON_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const SAFARI_ON_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const requestWith = (ip: string, userAgent?: string) =>
  ({ ip, headers: userAgent === undefined ? {} : { 'user-agent': userAgent } }) as
    unknown as FastifyRequest

describe('buildDeviceContext', () => {
  it('names the browser and the operating system', () => {
    expect(buildDeviceContext(requestWith(IP, CHROME_ON_ANDROID)).label).toBe(
      'Chrome on Android',
    )
  })

  it('names them for iOS too', () => {
    expect(buildDeviceContext(requestWith(IP, SAFARI_ON_IOS)).label).toBe(
      'Safari on iOS',
    )
  })

  it('falls back when the header is absent', () => {
    expect(buildDeviceContext(requestWith(IP)).label).toBe(UNKNOWN_DEVICE_LABEL)
  })

  it('falls back when the header is empty', () => {
    expect(buildDeviceContext(requestWith(IP, '')).label).toBe(UNKNOWN_DEVICE_LABEL)
  })

  it('falls back when the header is not a User-Agent at all', () => {
    expect(buildDeviceContext(requestWith(IP, 'not-a-user-agent')).label).toBe(
      UNKNOWN_DEVICE_LABEL,
    )
  })

  it('bounds the label, because the header is chosen by the client', () => {
    const { label } = buildDeviceContext(requestWith(IP, 'A'.repeat(4096)))

    expect(label.length).toBeLessThanOrEqual(MAX_DEVICE_LABEL_LENGTH)
  })

  it('takes the ip through the validating helper', () => {
    expect(buildDeviceContext(requestWith(IP, CHROME_ON_ANDROID)).ip).toBe(IP)
  })

  it('collapses an unusable address onto the shared sentinel', () => {
    expect(buildDeviceContext(requestWith('not-an-ip', CHROME_ON_ANDROID)).ip).toBe(
      UNPARSEABLE_CLIENT_IP_KEY,
    )
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
pnpm test:unit -- device-context
```

Esperado: FAIL — módulo não existe.

- [ ] **Step 4: Implementar**

Crie `src/infra/http/device-context.ts`:

```ts
import Bowser from 'bowser'
import type { FastifyRequest } from 'fastify'
import { clientIpKey } from './client-ip.js'

/**
 * What the owner sees when the User-Agent names nothing recognisable. A named
 * value and not `null`: on the entity, `null` means the row predates the
 * column, and "we could not identify this device" has to stay distinct from
 * "we never recorded one".
 */
export const UNKNOWN_DEVICE_LABEL = 'Unknown device'

/**
 * The header is attacker-chosen text, and not every parser output is short.
 * Bounds what reaches a column that is later rendered back to the owner.
 */
export const MAX_DEVICE_LABEL_LENGTH = 64

const USER_AGENT_HEADER = 'user-agent'
const LABEL_SEPARATOR = ' on '

/** What a session row records about the client that opened it. */
export interface DeviceContext {
  ip: string
  label: string
}

function labelFor(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.length === 0) return UNKNOWN_DEVICE_LABEL

  const parsed = Bowser.parse(userAgent)
  const browser = parsed.browser.name
  const os = parsed.os.name

  if (browser === undefined || os === undefined) return UNKNOWN_DEVICE_LABEL

  return `${browser}${LABEL_SEPARATOR}${os}`.slice(0, MAX_DEVICE_LABEL_LENGTH)
}

/**
 * The only place a request becomes session context, for the same reason
 * `clientIpKey` is the only place `request.ip` becomes a key: the conversion
 * has rules, and a second copy of them is a second thing to get wrong.
 *
 * The raw User-Agent is deliberately not returned. §3.2 of
 * `docs/superpowers/specs/2026-09-18-session-device-context-design.md`.
 */
export function buildDeviceContext(request: FastifyRequest): DeviceContext {
  return {
    ip: clientIpKey(request),
    label: labelFor(request.headers[USER_AGENT_HEADER]),
  }
}
```

**Se `Bowser.parse` lançar** em alguma entrada do teste (ele pode, para strings muito curtas), envolva a chamada em `try`/`catch` devolvendo `UNKNOWN_DEVICE_LABEL` — e escreva um comentário de uma linha dizendo qual entrada provou que ele lança. Não adicione o `try`/`catch` "por precaução" sem um teste que o exija.

- [ ] **Step 5: Rodar**

```bash
pnpm test:unit -- device-context && pnpm lint
```

Esperado: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/device-context.ts src/infra/http/device-context.spec.ts package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(http): derive session device context from a request

Stores a derived label instead of the raw User-Agent: the raw header is a
fingerprint far beyond what "was this me?" needs, and it would sit at rest
for the refresh token's whole lifetime.

bowser (MIT) rather than ua-parser-js, whose current major is AGPL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Os quatro use cases que abrem sessão

**Files:**
- Modify: `src/modules/auth/use-cases/login-user.ts`
- Modify: `src/modules/auth/use-cases/confirm-email.ts`
- Modify: `src/modules/auth/use-cases/change-password.ts`
- Modify: `src/modules/auth/use-cases/sign-in-with-google.ts`
- Test: os quatro `.spec.ts` correspondentes

**Interfaces:**
- Consumes: `IssuedSessionContext` (Task 3), `DeviceContext` (Task 4).
- Produces: `LoginUserCommand`, `ConfirmEmailCommand`, `ChangePasswordCommand` e `SignInWithGoogleCommand` ganham:

```ts
  device: { ip: string; label: string }
```

O contexto passado ao issuer nesses quatro é sempre `{ ip: command.device.ip, deviceLabel: command.device.label, sessionStartedAt: now }` — a família está nascendo, então o início é agora.

- [ ] **Step 1: Escrever o teste falhando em `login-user.spec.ts`**

```ts
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const

it('records the device context on the issued refresh token', async () => {
  await useCase.execute({ email: EMAIL, password: PASSWORD, device: DEVICE })

  const [stored] = refreshTokensRepository.tokens

  expect(stored.ip).toBe(DEVICE.ip)
  expect(stored.deviceLabel).toBe(DEVICE.label)
  expect(stored.sessionStartedAt).toEqual(NOW)
})
```

Confira como o arquivo acessa as linhas salvas do `InMemoryRefreshTokensRepository` — se a propriedade não se chamar `tokens`, use o nome real. Adicione `device: DEVICE` às chamadas de `execute` que já existem no arquivo.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- login-user
```

Esperado: FAIL.

- [ ] **Step 3: Implementar em `login-user.ts`**

Em `LoginUserCommand`:

```ts
  /** Resolved at the edge by `buildDeviceContext`. */
  device: { ip: string; label: string }
```

Na chamada ao issuer, passe o quarto argumento:

```ts
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      now,
      {
        ip: command.device.ip,
        deviceLabel: command.device.label,
        // The family is being born, so this login IS the start.
        sessionStartedAt: now,
      },
    )
```

Ajuste os nomes das variáveis (`user.id`, `now`) ao que o arquivo já usa.

- [ ] **Step 4: Rodar**

```bash
pnpm test:unit -- login-user
```

Esperado: PASS.

- [ ] **Step 5: Repetir para `confirm-email.ts`**

Mesmo teste, adaptado ao command daquele use case:

```ts
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const

it('records the device context on the issued refresh token', async () => {
  await useCase.execute({ /* campos que o command já exige */, device: DEVICE })

  const [stored] = refreshTokensRepository.tokens

  expect(stored.ip).toBe(DEVICE.ip)
  expect(stored.deviceLabel).toBe(DEVICE.label)
  expect(stored.sessionStartedAt).toEqual(NOW)
})
```

Implemente igual ao Step 3. Rode `pnpm test:unit -- confirm-email`.

- [ ] **Step 6: Repetir para `change-password.ts`**

Mesmo par teste/implementação. Rode `pnpm test:unit -- change-password`.

- [ ] **Step 7: Repetir para `sign-in-with-google.ts` — os TRÊS pontos**

Este arquivo emite em **três** lugares, e o spec já tem um `describe` para cada um:

| `describe` | Teste que já emite sessão |
|---|---|
| `— already linked (fast path)` | `loads the user, issues a session, and does NOT open a transaction` |
| `— new email` | `creates a verified passwordless account, links it, clears pendings, issues a session — all in one uow` |
| `— email has a password account` | `links on the right password: identity + refresh token + outbox row in one uow, before the commit` |

Em cada um desses três `describe`, adicione um caso novo ao lado do existente, reusando o mesmo arranjo que o vizinho já faz:

```ts
const DEVICE = { ip: '203.0.113.7', label: 'Chrome on Android' } as const

it('records the device context on the issued refresh token', async () => {
  // Mesmo arranjo do caso vizinho deste describe.

  await useCase.execute({ /* campos que o vizinho já passa */, device: DEVICE })

  const [stored] = refreshTokensRepository.tokens

  expect(stored.ip).toBe(DEVICE.ip)
  expect(stored.deviceLabel).toBe(DEVICE.label)
  expect(stored.sessionStartedAt).toEqual(NOW)
})
```

Adicione `device: DEVICE` a **todas** as chamadas de `execute` já existentes no arquivo, inclusive as dos caminhos que não emitem sessão (recusa sem senha, senha errada, conflito de subject, identidade inválida) — o campo é obrigatório no command, então o typecheck exige os quatro também.

Rode `pnpm test:unit -- sign-in-with-google`.

- [ ] **Step 8: Rodar a suíte inteira e o typecheck**

```bash
pnpm test:unit && pnpm typecheck
```

Esperado: unit verde. O `typecheck` ainda falha nos cinco endpoints — é a Task 7.

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/use-cases/
git commit -m "$(cat <<'EOF'
feat(auth): record device context wherever a session family is born

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: A rotação herda

**Files:**
- Modify: `src/modules/auth/use-cases/refresh-token.ts`
- Test: `src/modules/auth/use-cases/refresh-token.spec.ts`

**Interfaces:**
- Consumes: Tasks 2 e 3.
- Produces: `RefreshTokenCommand` ganha `ip: string`. **Não ganha rótulo** — esse é herdado da linha, não lido da request.

- [ ] **Step 1: Escrever os testes falhando**

O arquivo já tem os helpers `store(props)`, `refresh()` e o array `repository.tokens`. Primeiro **estenda o `store` existente** para aceitar os campos novos, sem mudar os defaults que os casos atuais dependem:

```ts
const store = (props: {
  revokedAt?: Date
  replacedBy?: string
  expiresAt?: Date
  familyId?: string
  ip?: string | null
  deviceLabel?: string | null
  sessionStartedAt?: Date | null
}) =>
  repository.tokens.push(
    RefreshToken.fromTrusted({
      id: CURRENT_ID,
      userId: USER_ID,
      tokenHash: digestOf(CURRENT_TOKEN),
      familyId: props.familyId ?? FAMILY_ID,
      expiresAt: props.expiresAt ?? at(TTL_MS),
      revokedAt: props.revokedAt ?? null,
      replacedBy: props.replacedBy ?? null,
      createdAt: NOW,
      ip: props.ip ?? ORIGINAL_IP,
      deviceLabel: props.deviceLabel ?? DEVICE_LABEL,
      sessionStartedAt: props.sessionStartedAt ?? SESSION_STARTED_AT,
    }),
  )
```

Faça o mesmo em `storeSuccessor`, com os mesmos valores. Depois troque `refresh` para passar o IP, e adicione as constantes:

```ts
const ORIGINAL_IP = '203.0.113.7'
const ROTATION_IP = '198.51.100.42'
const DEVICE_LABEL = 'Chrome on Android'
const SESSION_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')

const refresh = () => useCase.execute({ refreshToken: CURRENT_TOKEN, ip: ROTATION_IP })
```

Agora os três casos novos:

```ts
const liveSuccessor = () =>
  repository.tokens.find((token) => token.id !== CURRENT_ID && !token.isRevoked())

it('takes the ip from the current request and inherits the rest', async () => {
  store({})

  await refresh()

  const successor = liveSuccessor()

  expect(successor?.ip).toBe(ROTATION_IP)
  expect(successor?.deviceLabel).toBe(DEVICE_LABEL)
  expect(successor?.sessionStartedAt).toEqual(SESSION_STARTED_AT)
})

it('adopts the replaced row createdAt when the session start predates the column', async () => {
  store({ sessionStartedAt: null })

  await refresh()

  expect(liveSuccessor()?.sessionStartedAt).toEqual(NOW)
})

it('inherits the same way inside the grace window', async () => {
  store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
  storeSuccessor()

  await refresh()

  const successor = repository.tokens.find(
    (token) => token.id !== CURRENT_ID && token.id !== SUCCESSOR_ID,
  )

  expect(successor?.deviceLabel).toBe(DEVICE_LABEL)
  expect(successor?.sessionStartedAt).toEqual(SESSION_STARTED_AT)
})
```

O `createdAt` do `store` é `NOW`, por isso o segundo caso espera `NOW` — é a própria linha substituída adotando o seu `createdAt`.

No terceiro caso, confira como o arquivo já monta o cenário da janela de graça: se o caso existente usar outro par `revokedAt`/`replacedBy`, copie o dele em vez deste.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- refresh-token.spec
```

Esperado: FAIL.

- [ ] **Step 3: Implementar**

Em `RefreshTokenCommand`:

```ts
  /** Resolved at the edge by `buildDeviceContext`. */
  ip: string
```

`#issueInto` passa a receber a linha de origem e o IP, e monta o contexto:

```ts
  async #issueInto(
    refreshTokens: IRefreshTokensRepository,
    userId: string,
    familyId: string,
    now: Date,
    context: IssuedSessionContext,
  ): Promise<IssuedRefreshToken> {
    const issued = this.issuer.issue(userId, familyId, now, context)
    await refreshTokens.save(issued.entity)

    return issued
  }
```

E um helper privado que faz a herança, chamado nos dois pontos de emissão (janela de graça e rotação normal):

```ts
  /**
   * The ip follows the client; the label names the device and the start names
   * the family, so both ride along from the row being replaced. A row that
   * predates the column adopts its own `createdAt`, which is later than the
   * real start but stable from then on.
   */
  #inherit(current: RefreshToken, ip: string): IssuedSessionContext {
    return {
      ip,
      deviceLabel: current.deviceLabel,
      sessionStartedAt: current.sessionStartedAt ?? current.createdAt,
    }
  }
```

Importe `IssuedSessionContext` de `#modules/auth/services/refresh-token-issuer` e `RefreshToken` de `#modules/auth/entities/refresh-token`.

Nos dois `await this.#issueInto(...)`, passe `this.#inherit(current, command.ip)` como último argumento.

- [ ] **Step 4: Rodar**

```bash
pnpm test:unit -- refresh-token.spec
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/refresh-token.ts src/modules/auth/use-cases/refresh-token.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): inherit device label and session start across rotation

Rotation discards the row, so anything that describes the SESSION rather than
the request has to ride along or it is lost on the next refresh.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Os cinco endpoints

**Files:**
- Modify: `src/modules/auth/infra/http/endpoints/login.ts`
- Modify: `src/modules/auth/infra/http/endpoints/confirm-email.ts`
- Modify: `src/modules/auth/infra/http/endpoints/change-password.ts`
- Modify: `src/modules/auth/infra/http/endpoints/sign-in-with-google.ts`
- Modify: `src/modules/auth/infra/http/endpoints/refresh.ts`
- Test: `tests/integration/login.spec.ts`

**Interfaces:**
- Consumes: `buildDeviceContext` (Task 4), os commands das Tasks 5 e 6.
- Produces: nada consumido por tasks seguintes.

- [ ] **Step 1: Escrever o teste de integração falhando**

Em `tests/integration/login.spec.ts`:

```ts
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const EXPECTED_LABEL = 'Chrome on Android'

it('stores the device context of the request that logged in', async () => {
  // Arrange: um usuário verificado, do jeito que os casos vizinhos criam o deles.

  await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'user-agent': USER_AGENT },
    payload: { email: EMAIL, password: PASSWORD },
  })

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.userId, userId))

  expect(row.deviceLabel).toBe(EXPECTED_LABEL)
  expect(row.ip).not.toBeNull()
  expect(row.sessionStartedAt).not.toBeNull()
})
```

Use o mesmo acesso ao `db` e à criação de usuário que o arquivo já usa.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm db:up && pnpm test:integration -- login
```

Esperado: FAIL.

- [ ] **Step 3: Ligar os quatro endpoints de abertura de sessão**

Em cada um de `login.ts`, `confirm-email.ts`, `change-password.ts` e `sign-in-with-google.ts`, importe:

```ts
import { buildDeviceContext } from '#infra/http/device-context'
```

e no handler troque a chamada ao use case por:

```ts
      const { accessToken, refreshToken } = await container.loginUser.execute({
        ...request.body,
        device: buildDeviceContext(request),
      })
```

Ajuste o nome do use case e o destructuring ao que cada arquivo já faz. Em `change-password.ts` e `sign-in-with-google.ts`, onde o command é montado campo a campo em vez de espalhado do body, adicione só a linha `device: buildDeviceContext(request),`.

- [ ] **Step 4: Ligar o `refresh.ts`**

```ts
      const { accessToken, refreshToken } = await container.refreshToken.execute({
        refreshToken: presented,
        ip: buildDeviceContext(request).ip,
      })
```

- [ ] **Step 5: Rodar tudo**

```bash
pnpm test:integration -- login && pnpm typecheck && pnpm lint
```

Esperado: PASS nos três. **O `typecheck` tem que estar limpo agora** — este é o ponto em que a mudança de assinatura das Tasks 2, 3, 5 e 6 se fecha.

- [ ] **Step 6: Rodar a suíte inteira**

```bash
pnpm test
```

Esperado: tudo verde.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/infra/http/endpoints/ tests/integration/login.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): resolve device context at the edge on every session route

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `GET /auth/sessions` expõe os três campos

**Files:**
- Modify: `src/modules/auth/use-cases/list-active-sessions.ts`
- Modify: `src/modules/auth/infra/http/endpoints/list-sessions.ts`
- Test: `src/modules/auth/use-cases/list-active-sessions.spec.ts`
- Test: `tests/integration/list-sessions.spec.ts`

**Interfaces:**
- Consumes: a entidade da Task 2.
- Produces:

```ts
export interface ActiveSessionResult {
  id: string
  createdAt: Date
  expiresAt: Date
  ip: string | null
  deviceLabel: string | null
  /** Never null: falls back to `createdAt`. */
  startedAt: Date
}
```

- [ ] **Step 1: Escrever o teste unit falhando**

```ts
it('returns the device context of each session', async () => {
  // Arrange: uma linha viva com ip, deviceLabel e sessionStartedAt preenchidos.

  const [session] = await useCase.execute(USER_ID)

  expect(session.ip).toBe(IP)
  expect(session.deviceLabel).toBe(DEVICE_LABEL)
  expect(session.startedAt).toEqual(SESSION_STARTED_AT)
})

it('falls back to createdAt for a session that predates the column', async () => {
  // Arrange: uma linha viva com sessionStartedAt: null e createdAt: CREATED_AT.

  const [session] = await useCase.execute(USER_ID)

  expect(session.startedAt).toEqual(CREATED_AT)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- list-active-sessions
```

Esperado: FAIL.

- [ ] **Step 3: Implementar no use case**

```ts
export interface ActiveSessionResult {
  id: string
  createdAt: Date
  expiresAt: Date
  ip: string | null
  deviceLabel: string | null
  /**
   * Never null, unlike the column: a row that predates it reports its own
   * `createdAt`, so the client never has to render "session without a start".
   */
  startedAt: Date
}
```

```ts
    return tokens.map((token) => ({
      id: token.familyId,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      ip: token.ip,
      deviceLabel: token.deviceLabel,
      startedAt: token.sessionStartedAt ?? token.createdAt,
    }))
```

- [ ] **Step 4: Rodar**

```bash
pnpm test:unit -- list-active-sessions
```

Esperado: PASS.

- [ ] **Step 5: Atualizar o schema de resposta do endpoint**

Em `src/modules/auth/infra/http/endpoints/list-sessions.ts`, acrescente ao schema do item, seguindo o estilo de descrição que o arquivo já usa nos campos atuais:

```ts
      ip: z.string().nullable(),
      deviceLabel: z.string().nullable(),
      startedAt: z.iso.datetime(),
```

Confira qual forma de data o arquivo já usa para `createdAt`/`expiresAt` e use **a mesma** — não introduza uma segunda convenção.

- [ ] **Step 6: Teste e2e**

Em `tests/integration/list-sessions.spec.ts`:

```ts
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like ' +
  'Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const EXPECTED_LABEL = 'Chrome on Android'

it('describes each session well enough for the owner to recognise it', async () => {
  // Arrange: login com o header acima, do jeito que os casos vizinhos logam.

  const response = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${accessToken}` },
  })

  expect(response.json()).toMatchObject([
    { deviceLabel: EXPECTED_LABEL },
  ])
  expect(response.json()[0].ip).not.toBeNull()
  expect(response.json()[0].startedAt).toEqual(expect.any(String))
})
```

- [ ] **Step 7: Rodar**

```bash
pnpm test:integration -- list-sessions && pnpm lint
```

Esperado: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/use-cases/list-active-sessions.ts src/modules/auth/use-cases/list-active-sessions.spec.ts src/modules/auth/infra/http/endpoints/list-sessions.ts tests/integration/list-sessions.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): describe each active session by device, address and start

Closes the limitation decision 35 recorded as deliberate and blocked on a
migration: the response was an opaque UUID, which cannot answer "was this me?".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `iss` e `aud` no access token

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/modules/auth/infra/providers/jwt-token-signer.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Modify: `src/infra/config/env.spec.ts`
- Modify: `.env.example`
- Test: `src/modules/auth/infra/providers/jwt-token-signer.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `authEnvSchema` ganha `JWT_ISSUER: z.string().min(1)` e `JWT_AUDIENCE: z.string().min(1)`, **sem `.default()`**. O `Pick<AuthConfig, ...>` do construtor de `JwtTokenSigner` cresce para incluir os dois.

- [ ] **Step 1: Escrever os testes falhando**

Em `src/modules/auth/infra/providers/jwt-token-signer.spec.ts`:

```ts
const OTHER_ISSUER = 'another-system'
const OTHER_AUDIENCE = 'another-audience'

it('stamps the configured issuer and audience', async () => {
  const token = await signer.sign({ sub: USER_ID })

  const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET))

  expect(payload.iss).toBe(JWT_ISSUER)
  expect(payload.aud).toBe(JWT_AUDIENCE)
})

it('rejects a token minted for another issuer', async () => {
  const foreign = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer(OTHER_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(new TextEncoder().encode(JWT_SECRET))

  await expect(signer.verify(foreign)).rejects.toThrow()
})

it('rejects a token minted for another audience', async () => {
  const foreign = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer(JWT_ISSUER)
    .setAudience(OTHER_AUDIENCE)
    .sign(new TextEncoder().encode(JWT_SECRET))

  await expect(signer.verify(foreign)).rejects.toThrow()
})

it('rejects a token carrying neither claim', async () => {
  const bare = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET))

  await expect(signer.verify(bare)).rejects.toThrow()
})
```

Adicione `JWT_ISSUER` e `JWT_AUDIENCE` à config com que o `signer` do `beforeEach` é construído.

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm test:unit -- jwt-token-signer
```

Esperado: FAIL.

- [ ] **Step 3: Adicionar as variáveis ao `authEnvSchema`**

Em `src/modules/auth/config.ts`, dentro de `authEnvSchema`:

```ts
  /**
   * `iss` and `aud`. Required with NO default, and that is the whole point: a
   * shared default would give two deployments the same stamp, so a token from
   * one would keep verifying in the other — exactly what the claims exist to
   * prevent.
   */
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
```

- [ ] **Step 4: Implementar no signer**

Em `src/modules/auth/infra/providers/jwt-token-signer.ts`:

1. O `Pick` do construtor passa a ser:

```ts
    config: Pick<
      AuthConfig,
      'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS' | 'JWT_ISSUER' | 'JWT_AUDIENCE'
    >,
```

2. Dois campos privados `#issuer` e `#audience`, atribuídos no construtor.

3. Em `sign`, encadeie antes do `.sign(...)`:

```ts
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
```

4. Em `verify`, acrescente às opções do `jwtVerify`:

```ts
      // Rejects a token that verifies cryptographically but was minted by, or
      // for, another deployment sharing this secret.
      issuer: this.#issuer,
      audience: this.#audience,
```

- [ ] **Step 5: Atualizar fixture, spec de env e `.env.example`**

Em `src/infra/config/fixtures/test-env.ts`, adicione as duas com valores de teste. Em `src/infra/config/env.spec.ts`, adicione um caso afirmando que a ausência de cada uma reprova o parse — copiando a forma dos casos que já fazem isso para `JWT_SECRET`. Em `.env.example`, adicione as duas com valores de exemplo e um comentário de uma linha.

- [ ] **Step 6: Rodar**

```bash
pnpm test:unit && pnpm typecheck
```

Esperado: PASS.

- [ ] **Step 7: Rodar integração**

```bash
pnpm test:integration
```

Esperado: PASS. Se algum teste montar a config à mão em vez de usar o fixture, adicione as duas variáveis lá também.

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/infra/providers/jwt-token-signer.ts src/modules/auth/infra/providers/jwt-token-signer.spec.ts src/infra/config/ .env.example
git commit -m "$(cat <<'EOF'
feat(auth): require iss and aud on the access token

Required with no default: a shared default would stamp two deployments
identically, and a token from one would verify in the other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `helmet` e o TTL de 900s

**Files:**
- Create: `src/infra/http/helmet.ts`
- Modify: `src/main/app.ts`
- Modify: `src/modules/auth/config.ts`
- Modify: `package.json`
- Test: `tests/integration/health.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `registerHelmet(app: FastifyInstance): Promise<void>`.

- [ ] **Step 1: Instalar**

```bash
pnpm add @fastify/helmet@13.1.1
```

- [ ] **Step 2: Escrever o teste falhando**

Em `tests/integration/health.spec.ts` — a rota mais barata que existe, e o header é global:

```ts
const CONTENT_TYPE_OPTIONS_HEADER = 'x-content-type-options'
const NO_SNIFF = 'nosniff'

it('sends transport security headers on every response', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })

  expect(response.headers[CONTENT_TYPE_OPTIONS_HEADER]).toBe(NO_SNIFF)
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
pnpm test:integration -- health
```

Esperado: FAIL — header ausente.

- [ ] **Step 4: Criar o registro**

`src/infra/http/helmet.ts`:

```ts
import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'

/**
 * Transport security headers, plugin defaults.
 *
 * A function rather than an inline register in `buildApp`, for the same reason
 * as `registerCors` and `registerRateLimit`: a spec can then mount a bare
 * server and assert the headers without a database.
 */
export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(helmet)
}
```

- [ ] **Step 5: Registrar no `buildApp`**

Em `src/main/app.ts`, junto de `registerCors` e antes de qualquer rota:

```ts
  await registerHelmet(app)
```

com o import correspondente.

- [ ] **Step 6: Rodar**

```bash
pnpm test:integration -- health
```

Esperado: PASS.

- [ ] **Step 7: Baixar o TTL**

Em `src/modules/auth/config.ts`:

```ts
/**
 * 15 minutes. This IS the revocation latency of `logout-all`: a session revoked
 * at the refresh layer still opens doors until the access token already in the
 * client's hands expires.
 */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900
```

A referência à decisão 11 que estava no comentário antigo continua valendo para o desenho do par de tokens; mantenha-a se o texto que você escrever ainda a citar.

- [ ] **Step 8: Rodar tudo**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Esperado: tudo verde. Se algum teste dependia de 3600 literalmente, ele estava acoplado ao default — ajuste para ler a constante.

- [ ] **Step 9: Commit**

```bash
git add src/infra/http/helmet.ts src/main/app.ts src/modules/auth/config.ts package.json pnpm-lock.yaml tests/integration/health.spec.ts
git commit -m "$(cat <<'EOF'
feat(http): add transport security headers and shorten the access token

The TTL is the real revocation latency of logout-all, so an hour meant a
stolen session kept working for an hour after being revoked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Decisão 38 e emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: tudo o que as Tasks 1–10 entregaram.
- Produces: nada.

- [ ] **Step 1: Escrever a decisão 38**

Em `docs/DECISIONS.md`, após a decisão 37, no formato exato das vizinhas (`### 38 — <título>`, separada por `---`). Cubra, cada um em seu parágrafo em negrito:

- **O critério de recorte** (§3.1 da spec): coluna não se conserta sozinha, claim de token se conserta em uma janela de TTL. É o que decide o que entrou e o que não.
- **Rótulo derivado, não `User-Agent` cru** (§3.2), incluindo a licença que descartou `ua-parser-js` — `2.0.10` é AGPL-3.0-or-later, verificado no registry.
- **A herança na rotação** (§6): IP do request, rótulo e início herdados, fallback para o `createdAt` da linha substituída.
- **`iss`/`aud` obrigatórios, sem default** (§3.4).
- **O que ficou de fora e por quê** (§2): `kid`, `auth_time`/`amr`, tabela de sessão, flag de sessão atual, `last_used_at`.

Aponte para a spec em vez de repetir os argumentos dela.

- [ ] **Step 2: Emendar a decisão 35**

O parágrafo "**Sem informação de dispositivo, de propósito.**" descreve o estado anterior. Acrescente ao fim dele uma frase dizendo que a decisão 38 fechou isso, para não continuar lendo como estado atual. **Não reescreva o parágrafo** — o registro do que era verdade continua sendo o mapa.

- [ ] **Step 3: Corrigir a linha errada do `TODO.md`**

Na tabela "Achados que não estavam rastreados em lugar nenhum", a linha `iss` / `aud` / `kid` afirma que *"trocar o segredo desloga todo mundo de uma vez"*. Substitua a nota por uma que diga o que é verdade: `iss`/`aud` entregues pela fatia 21; `kid` continua aberto, e o que ele compra é evitar que todos os clientes ativos corram ao `/refresh` ao mesmo tempo quando o segredo é trocado — não um logout, porque `POST /auth/refresh` não lê o access token.

- [ ] **Step 4: Marcar os itens fechados**

Na mesma tabela, marque como fechados por esta fatia: "Contexto de dispositivo em `refresh_tokens`", "Headers de segurança (`helmet`)". Na seção "O que a auditoria promove de decisão aceita para pendência", marque o bullet "**TTL do access token**" como resolvido, citando 900s.

- [ ] **Step 5: Atualizar o cabeçalho e a seção final do `TODO.md`**

Acrescente o bloco da fatia 21 no topo, no formato dos blocos das fatias 16–20. Atualize "O que eu faria a seguir": o item (2) da ordem da auditoria (`helmet` e TTL) está fechado, e o (3) está parcialmente fechado — as colunas entraram, a **notificação de reuso** não. Ela é o próximo item desbloqueado, e agora tem rótulo e IP para citar no e-mail.

- [ ] **Step 6: Conferir que nada ficou dizendo o contrário**

```bash
grep -rn "kid\|last_used_at\|sem informação de dispositivo\|helmet" docs/*.md | grep -iv "fatia 21"
```

Leia cada resultado e confirme que nenhum ainda descreve o estado anterior como atual.

- [ ] **Step 7: Commit**

```bash
git add docs/DECISIONS.md docs/TODO.md
git commit -m "$(cat <<'EOF'
docs(auth): record decision 38 and correct the kid rationale

The TODO justified `kid` with "rotating the secret signs everyone out".
POST /auth/refresh never reads the access token, so what rotation actually
costs is one 401 and a transparent refresh per active client.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Verificação final

**Files:** nenhum.

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces: nada.

- [ ] **Step 1: Suíte completa, do zero**

```bash
pnpm db:down && pnpm db:up && pnpm db:migrate && pnpm test && pnpm lint && pnpm typecheck
```

Os quatro precisam sair verdes. **Cole a saída real** — não afirme que passou sem ela.

- [ ] **Step 2: Conferir a migration contra um banco limpo**

O `db:down`/`db:up` do passo anterior já destrói o volume. Se `db:migrate` falhou ali, a migration gerada na Task 1 não aplica em banco novo — pare e reporte, não conserte editando o SQL.

- [ ] **Step 3: Conferir que `ua-parser-js` não entrou**

```bash
grep -rn "ua-parser" package.json pnpm-lock.yaml || echo "ok: ausente"
```

- [ ] **Step 4: Revisar o diff inteiro**

```bash
git diff main...HEAD
```

Procure por: comentário com história de processo ("a fatia 21", "o review"), literal inline que devia ser constante, string em português em código, e qualquer `new Date()` sem argumento.
