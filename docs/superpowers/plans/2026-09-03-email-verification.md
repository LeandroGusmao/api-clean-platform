# Fatia 10 — Verificação de e-mail: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O usuário prova que controla o e-mail cadastrado digitando um código de seis dígitos recebido por SMTP; o login passa a exigir isso; e o `register` deixa de revelar quais endereços têm conta.

**Architecture:** Uma porta `IEmailSender` em `shared/ports/` com adapter SMTP (nodemailer) em `infra/providers/`. Uma tabela `email_verification_tokens` no molde de `refresh_tokens` — hash do código, expiração, uso único, contador de tentativas. Um serviço de domínio `EmailVerificationIssuer` que **persiste dentro da transação e devolve um thunk que envia**, chamado depois do commit — é assim que a regra do §8 do Unit of Work vira estrutura em vez de comentário.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5 + `fastify-type-provider-zod`, Zod 4, Drizzle ORM `1.0.0-rc.4` + `node-postgres`, Vitest 4, Biome, nodemailer, Mailpit.

**Spec:** [`docs/superpowers/specs/2026-09-03-email-verification-design.md`](../specs/2026-09-03-email-verification-design.md) — leia antes de começar. O plano argumenta a partir dela; onde os dois divergirem, a spec vence e o plano é que está errado.

## Global Constraints

Copiadas do `CLAUDE.md`, da spec e das regras que a fatia 9 deixou. Valem para **todas** as tasks.

- **Todo código, identificador, string, log e comentário em inglês.** Markdown (`*.md`) pode ser português.
- **Nada de magic string ou magic number inline.** Extraia para constante nomeada `UPPER_SNAKE_CASE`, perto do uso; compartilhada entre módulos vai para um `constants.ts`. **Exceção:** arquivos de schema em `src/modules/*/infra/drizzle/schema/*.ts` escrevem nomes de tabela, coluna e índice inline — mas só os nomes, e só enquanto o nome aparecer exatamente uma vez. Se outro arquivo precisar ler o nome, ele vira constante exportada dentro do próprio schema.
- **R6 — só `src/infra/config/env.ts` lê `process.env`.**
- **R7 — camada pura não produz valor não determinístico.** Nada de `new Date()`, `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `randomInt` dentro de `entities/`, `value-objects/`, `use-cases/`, `services/`. Tempo e aleatoriedade entram por `IClock`, `IIdGenerator`, `ITokenGenerator`, `ITokenDigest`.
- **R1 — repositório usa só a API core do Drizzle** (`select()/insert()/update()/where()`). Nunca `db.query.*`.
- **R2 — coluna sempre nomeada explicitamente:** `id: uuid('id')`.
- **Decisão 15 — use case não loga e não recebe logger.** Só infra e fronteira logam.
- **§8 do Unit of Work — fora do callback do `uow`:** I/O externo (envie **depois do commit**), CPU pesada (argon2), escrita que precisa sobreviver à falha (contador de força bruta), e outro `uow`.
- **§9 do Unit of Work — use case que recebe o UoW declara repositório direto por `Pick<...>`,** listando só os métodos que usa.
- **`updatedAt` vai SEMPRE explícito em todo `UPDATE`.** O `$onUpdate` preenche a ausência e nunca sobrescreve a presença; omitir é o jeito silencioso de o `IClock` deixar de ser a fonte da verdade.
- **Dependências são pinadas exatas** (sem `^`): use `pnpm add -E` / `pnpm add -DE`.
- **Cada task termina com `pnpm lint`, `pnpm typecheck` e `pnpm test:unit` verdes**, rodados **separadamente**, e um commit.

### Três armadilhas de ambiente (não são do repositório)

1. `pnpm lint | tail -1` devolve o exit code do `tail`. **Rode cada portão sozinho e leia o exit code.**
2. `pnpm test:unit -- <arquivo>` **não filtra** — roda a suíte inteira. Para um arquivo só: `pnpm vitest run --project unit <caminho>`.
3. A porta **3000 pode estar ocupada** por outro processo desta máquina. Se for testar à mão, use outra porta.

### Postgres e Mailpit

`docker compose up -d` sobe `postgres` (5432), `postgres-test` (5433) e — a partir da Task 1 — `mailpit` (1025 SMTP, 8025 HTTP). A suíte de integração precisa dos três.

---

## Estrutura de arquivos

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `src/shared/ports/email-sender.ts` | contrato `IEmailSender` + `EmailMessage` |
| `src/infra/providers/smtp-email-sender.ts` | adapter nodemailer + `smtpTransportOptions` pura |
| `src/infra/providers/smtp-email-sender.spec.ts` | testes da função pura de opções |
| `src/infra/providers/best-effort-email-sender.ts` | decorador que captura, loga e resolve |
| `src/infra/providers/best-effort-email-sender.spec.ts` | |
| `src/modules/auth/infra/drizzle/schema/email-verification-tokens.ts` | declaração da tabela |
| `src/modules/auth/entities/email-verification.ts` | entidade pura |
| `src/modules/auth/entities/email-verification.spec.ts` | |
| `src/modules/auth/repositories/email-verifications-repository.ts` | contrato |
| `src/modules/auth/infra/drizzle/drizzle-email-verifications-repository.ts` | adapter Postgres |
| `src/modules/auth/infra/drizzle/email-verification-mapper.ts` | linha ↔ entidade |
| `src/modules/auth/infra/in-memory/in-memory-email-verifications-repository.ts` | adapter de teste |
| `src/modules/auth/errors/email-not-verified-error.ts` | `ForbiddenError` → 403 |
| `src/modules/auth/errors/email-verification-failed-error.ts` | `BusinessRuleError` → 422 |
| `src/modules/auth/notifications/verification-email.ts` | corpo dos e-mails, funções puras |
| `src/modules/auth/services/email-verification-issuer.ts` | emitir → persistir → devolver o thunk |
| `src/modules/auth/services/email-verification-issuer.spec.ts` | |
| `src/modules/auth/use-cases/confirm-email.ts` + `.spec.ts` | |
| `src/modules/auth/use-cases/request-email-verification.ts` + `.spec.ts` | |
| `src/modules/auth/infra/http/endpoints/confirm-email.ts` | `POST /auth/email/verify` |
| `src/modules/auth/infra/http/endpoints/resend-verification.ts` | `POST /auth/email/verify/resend` |
| `tests/integration/email-verification-tokens-schema.spec.ts` | |
| `tests/integration/drizzle-email-verifications-repository.spec.ts` | |
| `tests/integration/verify-email.spec.ts` | fluxo ponta a ponta lendo o Mailpit |
| `tests/integration/setup/mailpit.ts` | cliente HTTP do Mailpit para os testes |

**Modificar:** `src/shared/ports/token-generator.ts` · `src/infra/providers/random-token-generator.ts` (+ spec) · `src/infra/config/env.ts` (+ spec, + fixture) · `src/modules/auth/config.ts` (+ spec) · `src/modules/auth/container.ts` · `src/modules/auth/repositories/users-repository.ts` · `src/modules/auth/repositories/unit-of-work.ts` · `src/modules/auth/infra/drizzle/drizzle-users-repository.ts` · `src/modules/auth/infra/drizzle/auth-repositories.ts` · `src/modules/auth/infra/in-memory/in-memory-users-repository.ts` · `src/modules/auth/infra/http/constants.ts` · `src/modules/auth/infra/http/routes.ts` · `src/modules/auth/infra/http/endpoints/register.ts` · `src/modules/auth/infra/http/endpoints/login.ts` · `src/modules/auth/use-cases/register-user.ts` (+ spec) · `src/modules/auth/use-cases/login-user.ts` (+ spec) · `src/modules/auth/use-cases/change-password.ts` (+ spec) · `docker-compose.yml` · `.github/workflows/ci.yml` · `vitest.config.ts` · `package.json` · `tests/integration/register.spec.ts` · `tests/integration/login.spec.ts` · `docs/DECISIONS.md` · `docs/STRUCTURE.md` · `docs/local.md` · `ARCHITECTURE.md` · spec do Unit of Work.

---

## Task 1: A porta de e-mail, o adapter SMTP e o Mailpit

**Files:**
- Create: `src/shared/ports/email-sender.ts`, `src/infra/providers/smtp-email-sender.ts`, `src/infra/providers/smtp-email-sender.spec.ts`
- Modify: `package.json`, `src/infra/config/env.ts`, `src/infra/config/fixtures/test-env.ts`, `src/infra/config/env.spec.ts`, `docker-compose.yml`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `IEmailSender { send(message: EmailMessage): Promise<void> }`; `EmailMessage { to: string; subject: string; text: string }`; `smtpTransportOptions(config: SmtpEmailSenderConfig): SMTPTransport.Options`; `class SmtpEmailSender implements IEmailSender`; env keys `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_REQUIRE_TLS`, `MAIL_FROM`, `MAIL_USER`, `MAIL_PASSWORD`.

- [ ] **Step 1: Instalar nodemailer, pinado exato**

```bash
pnpm add -E nodemailer
pnpm add -DE @types/nodemailer
```

Confirme no `package.json` que as duas entradas ficaram **sem** `^`. Se o pnpm gravou `^`, edite à mão para a versão exata.

- [ ] **Step 2: Escrever a porta**

`src/shared/ports/email-sender.ts`:

```ts
/**
 * Transactional email, as the pure layer sees it.
 *
 * Lives in `shared/` and not in `modules/auth/ports/` for the same reason
 * `IClock` and `ITokenDigest` do: sending mail is a cross-cutting technical
 * capability, not a concept of authentication. The next module that needs to
 * notify someone must not have to import a port out of `auth` — that is the
 * antipattern R5 forbids.
 *
 * Plain text only. HTML doubles the template surface and brings an escaping
 * decision of its own, and an email whose payload is a six-digit code gains
 * nothing from it.
 */
export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface IEmailSender {
  send(message: EmailMessage): Promise<void>
}
```

- [ ] **Step 3: Escrever o teste que falha, para a função pura de opções**

`src/infra/providers/smtp-email-sender.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  type SmtpEmailSenderConfig,
  smtpTransportOptions,
} from './smtp-email-sender.js'

const MINIMUM_TLS_VERSION = 'TLSv1.2'
const SMTP_HOST = 'smtp.example.com'
const SMTP_SUBMISSION_PORT = 587
const SMTP_USER = 'apikey'
const SMTP_PASSWORD = 'secret'

const baseConfig: SmtpEmailSenderConfig = {
  host: SMTP_HOST,
  port: SMTP_SUBMISSION_PORT,
  secure: false,
  requireTls: false,
  from: 'API Clean Platform <no-reply@example.com>',
}

describe('smtpTransportOptions', () => {
  it('forces STARTTLS when required, so the connection fails closed', () => {
    expect(smtpTransportOptions({ ...baseConfig, requireTls: true }).requireTLS).toBe(
      true,
    )
  })

  it('does not require STARTTLS when disabled, which is what lets Mailpit work', () => {
    expect(smtpTransportOptions(baseConfig).requireTLS).toBe(false)
  })

  it('refuses anything below TLS 1.2 whenever TLS is negotiated at all', () => {
    expect(smtpTransportOptions(baseConfig).tls?.minVersion).toBe(MINIMUM_TLS_VERSION)
  })

  it('passes implicit TLS through for SMTPS setups', () => {
    expect(smtpTransportOptions({ ...baseConfig, secure: true }).secure).toBe(true)
  })

  it('omits auth entirely when no user is configured — Mailpit accepts none', () => {
    expect(smtpTransportOptions(baseConfig).auth).toBeUndefined()
  })

  it('sends credentials when a user is configured', () => {
    expect(
      smtpTransportOptions({
        ...baseConfig,
        user: SMTP_USER,
        password: SMTP_PASSWORD,
      }).auth,
    ).toEqual({ user: SMTP_USER, pass: SMTP_PASSWORD })
  })
})
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/infra/providers/smtp-email-sender.spec.ts`
Expected: FAIL — o módulo não existe.

- [ ] **Step 5: Escrever o adapter**

`src/infra/providers/smtp-email-sender.ts`:

```ts
import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

/**
 * Refuse anything below this whenever TLS is negotiated, implicitly or through
 * STARTTLS. Harmless on the plaintext development path, where none is.
 */
const MINIMUM_TLS_VERSION = 'TLSv1.2'

export interface SmtpEmailSenderConfig {
  host: string
  port: number
  /** Implicit TLS from connect (SMTPS, port 465). */
  secure: boolean
  /**
   * Force STARTTLS, so the connection **fails closed** when the server cannot
   * upgrade instead of silently sending in the clear. Required in production:
   * without it a man in the middle only has to strip the STARTTLS advertisement
   * to read every verification code. `false` only for Mailpit, which offers no
   * STARTTLS at all. A no-op when `secure` is already true.
   */
  requireTls: boolean
  from: string
  /** Absent for Mailpit, which accepts no auth. */
  user?: string | undefined
  password?: string | undefined
}

/**
 * Pure, and exported for exactly that reason: these are the security-relevant
 * choices of the whole adapter, and this shape is what makes them assertable
 * without a live SMTP server.
 */
export function smtpTransportOptions(
  config: SmtpEmailSenderConfig,
): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    tls: { minVersion: MINIMUM_TLS_VERSION },
    auth:
      config.user === undefined
        ? undefined
        : { user: config.user, pass: config.password },
  }
}

/**
 * The SMTP adapter. One class serves development (Mailpit on 1025, no auth) and
 * production (a real provider): only the configuration differs, which is what
 * makes swapping providers an environment change rather than a code change.
 *
 * The transport is built once and reused — nodemailer pools connections across
 * repeated sends.
 */
export class SmtpEmailSender implements IEmailSender {
  readonly #transport: Transporter
  readonly #from: string

  constructor(config: SmtpEmailSenderConfig) {
    this.#from = config.from
    this.#transport = nodemailer.createTransport(smtpTransportOptions(config))
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  }
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/infra/providers/smtp-email-sender.spec.ts`
Expected: PASS, 6 testes.

- [ ] **Step 7: Declarar as variáveis no env core**

Em `src/infra/config/env.ts`, acrescente as constantes de default perto das outras (`DEFAULT_*`) e as chaves em `coreEnvSchema`:

```ts
/**
 * Development points at the Mailpit service in `docker-compose.yml`. Production
 * must be explicit — see the refinement below.
 */
export const DEFAULT_MAIL_HOST = '127.0.0.1'
export const DEFAULT_MAIL_PORT = 1025
export const DEFAULT_MAIL_FROM = 'API Clean Platform <no-reply@localhost>'

/** Zod gives no boolean coercion that rejects garbage: `z.coerce.boolean()` turns every non-empty string into `true`, so `MAIL_REQUIRE_TLS=false` would read as true. */
const BOOLEAN_TRUE = 'true'
const BOOLEAN_FALSE = 'false'
const booleanFromString = z
  .enum([BOOLEAN_TRUE, BOOLEAN_FALSE])
  .transform((raw) => raw === BOOLEAN_TRUE)
```

Chaves no `coreEnvSchema`:

```ts
  MAIL_HOST: z.string().min(1).default(DEFAULT_MAIL_HOST),
  MAIL_PORT: z.coerce.number().int().positive().default(DEFAULT_MAIL_PORT),
  MAIL_SECURE: booleanFromString.default(BOOLEAN_FALSE),
  MAIL_REQUIRE_TLS: booleanFromString.default(BOOLEAN_FALSE),
  MAIL_FROM: z.string().min(1).default(DEFAULT_MAIL_FROM),
  MAIL_USER: z.string().min(1).optional(),
  MAIL_PASSWORD: z.string().min(1).optional(),
```

- [ ] **Step 8: Escrever o teste que falha, para a exigência de produção**

Em `src/infra/config/env.spec.ts`, seguindo o estilo dos testes que já estão lá (use o fixture `test-env.ts`):

```ts
const NODE_ENV_PRODUCTION = 'production'
const MAIL_REQUIRE_TLS_DISABLED = 'false'
const MAIL_REQUIRE_TLS_KEY = 'MAIL_REQUIRE_TLS'
const MAIL_FROM_KEY = 'MAIL_FROM'

describe('mail configuration in production', () => {
  it('refuses to boot without an explicit sender address', () => {
    const result = parseEnv({ ...testEnv(), NODE_ENV: NODE_ENV_PRODUCTION })

    expect(result.success).toBe(false)
  })

  it('refuses to boot with STARTTLS disabled, which would send codes in the clear', () => {
    const result = parseEnv({
      ...testEnv(),
      NODE_ENV: NODE_ENV_PRODUCTION,
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '587',
      [MAIL_FROM_KEY]: 'API <no-reply@example.com>',
      [MAIL_REQUIRE_TLS_KEY]: MAIL_REQUIRE_TLS_DISABLED,
    })

    expect(result.success).toBe(false)
  })

  it('boots when every mail setting is explicit and STARTTLS is required', () => {
    const result = parseEnv({
      ...testEnv(),
      NODE_ENV: NODE_ENV_PRODUCTION,
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '587',
      [MAIL_FROM_KEY]: 'API <no-reply@example.com>',
      [MAIL_REQUIRE_TLS_KEY]: 'true',
    })

    expect(result.success).toBe(true)
  })
})
```

> Leia `src/infra/config/fixtures/test-env.ts` antes: adapte as chamadas ao formato real do fixture (ele pode ser objeto e não função). **Não** invente API — use a que existir.

- [ ] **Step 9: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/infra/config/env.spec.ts`
Expected: FAIL — hoje produção aceita os defaults de desenvolvimento.

- [ ] **Step 10: Implementar o refinamento**

Em `src/infra/config/env.ts`, o `envSchema` passa a carregar um `superRefine`. **Ele tem de vir depois do `extend`**, senão o `extend` o descarta:

```ts
/** The mail settings that must never be inherited from a development default. */
const REQUIRED_MAIL_KEYS_IN_PRODUCTION = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_FROM'] as const

const MAIL_REQUIRED_IN_PRODUCTION_MESSAGE =
  'must be set explicitly in production, never inherited from the development default'
const MAIL_TLS_REQUIRED_MESSAGE =
  'must be true in production: without STARTTLS a man in the middle reads every verification code'

const envSchema = coreEnvSchema
  .extend(authEnvSchema.shape)
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== NODE_ENV_PRODUCTION) return

    for (const key of REQUIRED_MAIL_KEYS_IN_PRODUCTION) {
      if (source[key] === undefined) { /* see note */ }
    }
  })
```

> **Nota de implementação — leia antes de escrever.** Depois do `.default()`, o valor parseado **nunca é `undefined`**, então não dá para distinguir "veio do ambiente" de "veio do default" olhando o resultado. Duas saídas, e a segunda é a certa:
>
> 1. ❌ comparar com a constante de default — falha se alguém configurar em produção exatamente o mesmo valor;
> 2. ✅ **tornar as três chaves obrigatórias no schema e dar o default por fora**, ou seja: declarar `MAIL_HOST: z.string().min(1).optional()` e derivar o valor efetivo num `.transform()` no fim, depois do `superRefine` ter visto o `undefined` cru.
>
> Escolha a forma 2. O `superRefine` recebe o objeto **antes** do transform, então enxerga `undefined` de verdade. Reporte cada chave ausente com `ctx.addIssue({ code: 'custom', path: [key], message: MAIL_REQUIRED_IN_PRODUCTION_MESSAGE })`, e o `MAIL_REQUIRE_TLS` falso com `MAIL_TLS_REQUIRED_MESSAGE`.
>
> Ajuste `DEFAULT_MAIL_*` para serem aplicados no transform final. Mantenha `Env` com os campos **não opcionais** depois do transform, senão todo consumidor passa a lidar com `undefined`.

- [ ] **Step 11: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/infra/config/env.spec.ts`
Expected: PASS.

- [ ] **Step 12: Subir o Mailpit no compose**

Em `docker-compose.yml`, ao lado dos dois Postgres:

```yaml
  # Local SMTP catcher. Captures every outgoing message — verification codes
  # included — instead of delivering it, and exposes an HTTP API the integration
  # suite reads the code back from. The same SmtpEmailSender adapter talks to
  # this in development and to a real provider in production; only the
  # environment differs.
  mailpit:
    # Pinned exact — bump deliberately, same convention as our npm deps.
    image: axllent/mailpit:v1.30.2
    container_name: api-clean-platform-mailpit
    restart: unless-stopped
    # Bind to localhost only — never expose the dev mail UI or SMTP to the LAN.
    ports:
      - '127.0.0.1:1025:1025'
      - '127.0.0.1:8025:8025'
```

Sem volume: mensagem capturada é efêmera por desenho.

- [ ] **Step 13: Subir o Mailpit no CI**

Em `.github/workflows/ci.yml`, dentro do bloco `services:` que já tem o Postgres:

```yaml
      mailpit:
        image: axllent/mailpit:v1.30.2
        ports:
          - 1025:1025
          - 8025:8025
```

- [ ] **Step 14: Portões e commit**

```bash
docker compose up -d
pnpm lint
pnpm typecheck
pnpm test:unit
git add -A
git commit -m "feat: give the pure layer a way to send email"
```

---

## Task 2: `numericCode` na porta de tokens

**Files:**
- Modify: `src/shared/ports/token-generator.ts`, `src/infra/providers/random-token-generator.ts`, `src/infra/providers/random-token-generator.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ITokenGenerator.numericCode(digits: number): string` — devolve exatamente `digits` caracteres, só `0-9`, com zeros à esquerda preservados.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente a `src/infra/providers/random-token-generator.spec.ts`:

```ts
const CODE_DIGITS = 6
const SAMPLE_SIZE = 500
const DIGITS_ONLY_PATTERN = /^[0-9]+$/

describe('numericCode', () => {
  it('returns exactly the requested number of digits', () => {
    expect(new RandomTokenGenerator().numericCode(CODE_DIGITS)).toHaveLength(CODE_DIGITS)
  })

  it('returns digits only', () => {
    expect(new RandomTokenGenerator().numericCode(CODE_DIGITS)).toMatch(
      DIGITS_ONLY_PATTERN,
    )
  })

  // The bug this kills is real and silent: a naive `randomInt(...).toString()`
  // yields "42" for the value 42, and a five-character code is rejected by the
  // endpoint's schema — so roughly one signup in ten breaks, at random.
  it('keeps leading zeros, so a low draw is still a full-length code', () => {
    const generator = new RandomTokenGenerator()
    const codes = Array.from({ length: SAMPLE_SIZE }, () =>
      generator.numericCode(CODE_DIGITS),
    )

    expect(codes.every((code) => code.length === CODE_DIGITS)).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/infra/providers/random-token-generator.spec.ts`
Expected: FAIL — `numericCode is not a function`.

- [ ] **Step 3: Estender a porta**

Em `src/shared/ports/token-generator.ts`, dentro de `ITokenGenerator`:

```ts
  /**
   * A uniformly random decimal code of exactly `digits` digits, leading zeros
   * included, for values a human types back into an app.
   *
   * Uniform is the load-bearing word, and it is why this belongs to the port
   * rather than to the caller: deriving a code from `opaque()` with `%` would
   * bias the low digits, because 256 is not a multiple of 10. The adapter is the
   * only place allowed to know that.
   *
   * NOT a replacement for `opaque`. Six digits carry ~20 bits: safe only behind
   * a short TTL and an attempt cap, never as a bearer secret.
   */
  numericCode(digits: number): string
```

- [ ] **Step 4: Implementar no adapter**

Em `src/infra/providers/random-token-generator.ts`:

```ts
import { randomBytes, randomInt } from 'node:crypto'

const DECIMAL_BASE = 10
const PAD_CHARACTER = '0'
```

```ts
  numericCode(digits: number): string {
    // `randomInt` is rejection-sampled by Node, so the distribution is uniform
    // over the whole range — unlike `randomBytes` reduced with `%`.
    const exclusiveUpperBound = DECIMAL_BASE ** digits

    return randomInt(exclusiveUpperBound).toString().padStart(digits, PAD_CHARACTER)
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/infra/providers/random-token-generator.spec.ts`
Expected: PASS.

- [ ] **Step 6: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: let the token port mint a typeable numeric code"
```

---

## Task 3: A tabela `email_verification_tokens`

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/email-verification-tokens.ts`, `tests/integration/email-verification-tokens-schema.spec.ts`
- Modify: `drizzle/` (migration gerada)

**Interfaces:**
- Produces: `emailVerificationTokens` (tabela Drizzle) com colunas `id`, `userId`, `codeHash`, `expiresAt`, `consumedAt`, `attempts`, `createdAt`.

- [ ] **Step 1: Escrever o schema**

`src/modules/auth/infra/drizzle/schema/email-verification-tokens.ts`:

```ts
import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * A single-use, six-digit code proving control of an email address. This module
 * owns the table, and the foreign key to `users` is legal because both live
 * inside `auth` (decision 24).
 *
 * NO column defaults, exactly as in `refresh-tokens.ts` and for the same reason:
 * Postgres stores `timestamptz` in microseconds while a JS `Date` has
 * milliseconds, and the TTL compares instants — so every timestamp here comes
 * from `IClock` and both sides of every comparison share a source. `attempts` is
 * written explicitly too: the entity owns the value, and a default would be
 * defence in depth for a direct write that has no legitimate caller.
 *
 * `consumed_at` marks BOTH "burned by a successful confirm" and "superseded by a
 * reissue". `refresh_tokens` separates those into `revoked_at` + `replaced_by`
 * because reuse detection needs the distinction; here there is no chain, and
 * nothing downstream reads the difference.
 *
 * **No unique index on `code_hash`, and that is the difference from
 * `refresh_tokens` that matters.** Six digits collide by design — 10^6 values
 * for the whole base — so two accounts holding the same pending code is an
 * ordinary event, not an alarm, and a unique index would refuse the second
 * legitimate issue. Lookup is therefore ALWAYS by `user_id`: a global lookup by
 * `code_hash` would let one user's code confirm another user's account.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the code. Never the code itself. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Wrong guesses so far. The use case caps it; that cap is what makes six digits safe. */
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The FK's cascade needs it: without it every user deletion scans this table.
    index('email_verification_tokens_user_id_idx').on(table.userId),
    // The hot path — `findActiveByUserId` and `invalidateActiveForUser`. Expiry
    // is filtered at query time and NOT in this predicate: a partial index
    // predicate must be IMMUTABLE, and `now()` is not.
    index('email_verification_tokens_active_idx')
      .on(table.userId)
      .where(sql`${table.consumedAt} is null`),
  ],
)
```

- [ ] **Step 2: Gerar a migration**

```bash
docker compose up -d
DATABASE_URL='postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5432/api_clean_platform' pnpm db:generate
```

Leia o SQL gerado em `drizzle/<timestamp>_*/migration.sql` e confirme: `create table`, o FK com `on delete cascade`, os dois índices, e o parcial com `where "consumed_at" is null`. **A migration é a fonte da verdade do que chegou ao banco** — se o SQL não bate com o schema, o schema é que está errado.

- [ ] **Step 3: Aplicar**

```bash
DATABASE_URL='postgres://api_clean_platform:api_clean_platform_local_dev@127.0.0.1:5432/api_clean_platform' pnpm db:migrate
```

- [ ] **Step 4: Escrever o teste de integração do schema**

`tests/integration/email-verification-tokens-schema.spec.ts` — copie a estrutura de `tests/integration/refresh-tokens-schema.spec.ts` (leia-o primeiro) e cubra:

1. as sete colunas existem com os tipos esperados;
2. `attempts` é `not null` **sem default** — inserir sem ele falha;
3. o FK cascateia: apagar o usuário apaga suas linhas;
4. os dois índices existem, consultando `pg_indexes`;
5. o índice ativo é **parcial** — seu `indexdef` contém `WHERE (consumed_at IS NULL)`.

- [ ] **Step 5: Rodar**

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 6: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: add the email verification tokens table"
```

---

## Task 4: A entidade `EmailVerification`

**Files:**
- Create: `src/modules/auth/entities/email-verification.ts`, `src/modules/auth/entities/email-verification.spec.ts`

**Interfaces:**
- Produces:
  - `EmailVerification.create(props: CreateEmailVerificationProps): EmailVerification` onde `CreateEmailVerificationProps = { id: string; userId: string; codeHash: string; now: Date; ttlSeconds: number }`
  - `EmailVerification.fromTrusted(props: TrustedEmailVerificationProps): EmailVerification` onde `TrustedEmailVerificationProps = { id: string; userId: string; codeHash: string; expiresAt: Date; consumedAt: Date | null; attempts: number; createdAt: Date }`
  - getters `id`, `userId`, `codeHash`, `expiresAt`, `consumedAt`, `attempts`, `createdAt`
  - `isUsable(maxAttempts: number, now: Date): boolean`
  - `matches(codeHash: string): boolean`

- [ ] **Step 1: Escrever o teste que falha**

`src/modules/auth/entities/email-verification.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EmailVerification } from './email-verification.js'

const ID = '9f1a6d0f-9a3b-4c21-8a6f-2e4d2e9f1a6d'
const USER_ID = '0d3d5d8a-6f2e-4d2e-9f1a-6d0f9a3b5c21'
const CODE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const OTHER_CODE_HASH = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const TTL_SECONDS = 900
const MAX_ATTEMPTS = 5

const EXPIRES_AT = new Date('2026-09-03T12:15:00.000Z')
const ONE_MILLISECOND = 1

function create(): EmailVerification {
  return EmailVerification.create({
    id: ID,
    userId: USER_ID,
    codeHash: CODE_HASH,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
  })
}

function trusted(
  overrides: Partial<{ consumedAt: Date | null; attempts: number; expiresAt: Date }> = {},
): EmailVerification {
  return EmailVerification.fromTrusted({
    id: ID,
    userId: USER_ID,
    codeHash: CODE_HASH,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    consumedAt: overrides.consumedAt ?? null,
    attempts: overrides.attempts ?? 0,
    createdAt: NOW,
  })
}

describe('EmailVerification.create', () => {
  it('derives the expiry from the injected clock, never from the system one', () => {
    expect(create().expiresAt).toEqual(EXPIRES_AT)
  })

  it('is born unconsumed and with no attempts spent', () => {
    const verification = create()

    expect(verification.consumedAt).toBeNull()
    expect(verification.attempts).toBe(0)
  })
})

describe('isUsable', () => {
  it('is usable while fresh, unconsumed and under the cap', () => {
    expect(trusted().isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })

  it('is unusable once consumed', () => {
    expect(trusted({ consumedAt: NOW }).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is unusable at the very instant it expires, not a millisecond later', () => {
    expect(trusted().isUsable(MAX_ATTEMPTS, EXPIRES_AT)).toBe(false)
  })

  it('is still usable one millisecond before expiry', () => {
    const justBefore = new Date(EXPIRES_AT.getTime() - ONE_MILLISECOND)

    expect(trusted().isUsable(MAX_ATTEMPTS, justBefore)).toBe(true)
  })

  it('is unusable once the attempt cap is reached', () => {
    expect(trusted({ attempts: MAX_ATTEMPTS }).isUsable(MAX_ATTEMPTS, NOW)).toBe(false)
  })

  it('is still usable one attempt below the cap', () => {
    expect(trusted({ attempts: MAX_ATTEMPTS - 1 }).isUsable(MAX_ATTEMPTS, NOW)).toBe(true)
  })
})

describe('matches', () => {
  it('accepts the digest it was minted with', () => {
    expect(create().matches(CODE_HASH)).toBe(true)
  })

  it('rejects any other digest', () => {
    expect(create().matches(OTHER_CODE_HASH)).toBe(false)
  })
})

describe('immutability', () => {
  it('hands out copies of its dates, so a caller cannot rewrite its state', () => {
    const verification = create()
    verification.expiresAt.setFullYear(1970)

    expect(verification.expiresAt).toEqual(EXPIRES_AT)
  })

  it('keeps its state off the serialized form, so nothing leaks through a log', () => {
    expect(JSON.stringify(create())).toBe('{}')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/entities/email-verification.spec.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Escrever a entidade**

Espelhe `src/modules/auth/entities/refresh-token.ts` — leia-o primeiro e copie a forma: `cloneDate`/`cloneNullableDate` locais, `MILLISECONDS_PER_SECOND`, campos `#`, `Object.freeze(this)` no construtor privado, `create` + `fromTrusted`.

Pontos que a spec fixa e que o teste acima cobra:

```ts
  /**
   * Usable = not consumed, not expired, and under the attempt cap.
   *
   * Inclusive at the expiry boundary, like `RefreshToken.isExpired`: an instant
   * that has arrived is spent.
   */
  isUsable(maxAttempts: number, now: Date): boolean {
    return (
      this.#consumedAt === null &&
      this.#expiresAt.getTime() > now.getTime() &&
      this.#attempts < maxAttempts
    )
  }

  /**
   * Takes the DIGEST, never the raw code. That is what keeps this entity free of
   * ports and of `node:crypto` — hashing is `ITokenDigest`'s job, and the use
   * case does `verification.matches(tokenDigest.hash(command.code))`.
   *
   * A plain comparison, not `timingSafeEqual`, deliberately: what is compared
   * here are two digests, not two secrets. Exploiting the timing leak would mean
   * forging a code whose sha256 shares a prefix with the stored one — and each
   * attempt burns one of the five the cap allows.
   */
  matches(codeHash: string): boolean {
    return codeHash === this.#codeHash
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/entities/email-verification.spec.ts`
Expected: PASS, 12 testes.

- [ ] **Step 5: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: add the email verification entity"
```

---

## Task 5: O repositório de verificações

**Files:**
- Create: `src/modules/auth/repositories/email-verifications-repository.ts`, `src/modules/auth/infra/drizzle/email-verification-mapper.ts`, `src/modules/auth/infra/drizzle/drizzle-email-verifications-repository.ts`, `src/modules/auth/infra/in-memory/in-memory-email-verifications-repository.ts`, `tests/integration/drizzle-email-verifications-repository.spec.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts`, `src/modules/auth/infra/drizzle/auth-repositories.ts`

**Interfaces:**
- Consumes: `EmailVerification` (Task 4), `emailVerificationTokens` (Task 3).
- Produces:

```ts
export interface IEmailVerificationsRepository {
  save(verification: EmailVerification): Promise<void>
  findActiveByUserId(userId: string): Promise<EmailVerification | null>
  invalidateActiveForUser(userId: string, at: Date): Promise<void>
  incrementAttempts(id: string): Promise<void>
  consume(id: string, at: Date): Promise<boolean>
}
```
  E `AuthRepos` passa a ser `{ users; refreshTokens; emailVerifications }`.

- [ ] **Step 1: Escrever o contrato**

`src/modules/auth/repositories/email-verifications-repository.ts`, com a documentação que a spec §7.4 fixa:

```ts
import type { EmailVerification } from '#modules/auth/entities/email-verification'

export interface IEmailVerificationsRepository {
  save(verification: EmailVerification): Promise<void>

  /**
   * The most recent row for this user that has not been consumed.
   *
   * Deliberately does NOT filter expiry in SQL: whether a code is too old is
   * the entity's judgement, made against the injected `IClock`, and moving it
   * into the query would put a second clock — the database's — into a decision
   * the unit tests need to control.
   *
   * ALWAYS by user, never by digest. Six-digit codes collide by design, so a
   * global lookup would let one account's code confirm another's.
   */
  findActiveByUserId(userId: string): Promise<EmailVerification | null>

  /** Marks every unconsumed row of this user consumed, so only one code is ever live. */
  invalidateActiveForUser(userId: string, at: Date): Promise<void>

  /**
   * Records one wrong guess.
   *
   * Called OUTSIDE any transaction, and that is the third line of §8 of the unit
   * of work design: inside a transaction that rolls back, the brute-force
   * counter would be erased exactly when it matters.
   */
  incrementAttempts(id: string): Promise<void>

  /**
   * Burns the code: `WHERE id = ? AND consumed_at IS NULL`.
   *
   * Returns whether THIS call is the one that burned it. That boolean is what
   * makes single use race-proof without an explicit lock — of two simultaneous
   * confirms with the same code, one loses the conditional update, and the
   * caller turns that into the same generic failure as every other.
   */
  consume(id: string, at: Date): Promise<boolean>
}
```

- [ ] **Step 2: Estender `AuthRepos`**

Em `src/modules/auth/repositories/unit-of-work.ts`, acrescente `emailVerifications: IEmailVerificationsRepository` à interface `AuthRepos`, com uma linha de comentário dizendo por que ela entra: o `confirm` queima o código e carimba `users.email_verified_at` na mesma transação — é um fato só.

- [ ] **Step 3: Escrever o mapper**

`src/modules/auth/infra/drizzle/email-verification-mapper.ts`, no molde de `refresh-token-mapper.ts` (leia-o): duas funções puras `toDomainEmailVerification(row)` e `toPersistenceEmailVerification(verification)` (decisão 20).

- [ ] **Step 4: Escrever o adapter in-memory**

`src/modules/auth/infra/in-memory/in-memory-email-verifications-repository.ts`, no molde de `in-memory-refresh-tokens-repository.ts`. A entidade é congelada, então `incrementAttempts` e `consume` **reidratam** via `fromTrusted`, como `InMemoryUsersRepository.updatePasswordHash` faz. `consume` devolve `false` quando a linha já está consumida ou não existe.

`findActiveByUserId` devolve a **mais recente** não consumida — ordene por `createdAt` decrescente.

- [ ] **Step 5: Escrever o teste de integração que falha**

`tests/integration/drizzle-email-verifications-repository.spec.ts`, no molde de `tests/integration/drizzle-refresh-tokens-repository.spec.ts` (leia-o). Cubra:

```
1. save + findActiveByUserId devolve a entidade com os mesmos campos
2. findActiveByUserId devolve null quando a única linha está consumida
3. findActiveByUserId devolve a MAIS RECENTE quando há duas não consumidas
4. findActiveByUserId NÃO filtra expiração — uma linha expirada e não consumida
   ainda volta (é a entidade que julga)
5. invalidateActiveForUser consome todas as ativas do usuário e NENHUMA de outro
6. incrementAttempts soma exatamente 1
7. consume devolve true na primeira chamada
8. consume devolve FALSE na segunda — o uso único, contra o Postgres real
9. consume devolve false para um id inexistente
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `pnpm test:integration`
Expected: FAIL.

- [ ] **Step 7: Escrever o adapter Drizzle**

`src/modules/auth/infra/drizzle/drizzle-email-verifications-repository.ts`. Molde: `drizzle-refresh-tokens-repository.ts`. Só API core (R1). Envolva as escritas em `toPersistenceError` como os outros repositórios fazem.

O `consume` é o ponto delicado — precisa distinguir 0 de 1 linha afetada:

```ts
const NO_ROW_AFFECTED = 0

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: at })
      .where(
        and(
          eq(emailVerificationTokens.id, id),
          isNull(emailVerificationTokens.consumedAt),
        ),
      )

    return result.rowCount !== NO_ROW_AFFECTED
  }
```

> **Medir, não presumir.** A spec marca isto como `[suposto]`: confirme que o driver expõe a contagem de linhas dessa forma. Com `drizzle-orm/node-postgres`, o retorno de um `update` é o `pg.QueryResult`, que carrega `rowCount: number | null`. Se na prática for outra coisa, **descubra qual é** e ajuste — todo o uso único depende disso. Se `rowCount` puder ser `null`, trate `null` como zero e escreva por quê.

`incrementAttempts` usa `sql` para somar no banco, nunca lendo-e-escrevendo:

```ts
      .set({ attempts: sql`${emailVerificationTokens.attempts} + 1` })
```

Ler e escrever perderia incrementos concorrentes — que é exatamente o que um atacante paralelizando palpites produziria.

- [ ] **Step 8: Ligar na fábrica**

Em `src/modules/auth/infra/drizzle/auth-repositories.ts`, acrescente `emailVerifications: new DrizzleEmailVerificationsRepository(db)`.

- [ ] **Step 9: Rodar e ver passar**

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 10: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: persist email verification codes"
```

---

## Task 6: `markEmailVerified` e os erros novos

**Files:**
- Create: `src/modules/auth/errors/email-not-verified-error.ts`, `src/modules/auth/errors/email-verification-failed-error.ts`
- Modify: `src/modules/auth/repositories/users-repository.ts`, `src/modules/auth/infra/drizzle/drizzle-users-repository.ts`, `src/modules/auth/infra/in-memory/in-memory-users-repository.ts`, `src/modules/auth/infra/http/constants.ts`, `tests/integration/drizzle-users-repository.spec.ts`

**Interfaces:**
- Produces: `IUsersRepository.markEmailVerified(id: string, verifiedAt: Date, updatedAt: Date): Promise<void>`; `class EmailNotVerifiedError extends ForbiddenError`; `class EmailVerificationFailedError extends BusinessRuleError`; constantes `ACCEPTED_STATUS = 202` e `FORBIDDEN_STATUS = 403`.

- [ ] **Step 1: Escrever os dois erros**

Leia `src/modules/auth/errors/invalid-current-password-error.ts` para o formato exato (código público, mensagem). Os dois novos:

```ts
// email-not-verified-error.ts
/**
 * The login gate. Thrown ONLY after the password check has passed, so the
 * "unverified" signal never reaches anyone who does not already know the
 * password — otherwise the gate would reopen the enumeration surface that the
 * decoy hash in `login-user.ts` exists to close.
 *
 * `ForbiddenError` → 403 and not 401: decision 13 glosses 403 as "authenticated,
 * not permitted", which is literally the case here. The argument that pushed
 * slice 9 to 422 — a mobile interceptor looping on refresh when it sees 401 —
 * does not apply, because this happens at login, where there is no token to
 * refresh.
 */
```

```ts
// email-verification-failed-error.ts
/**
 * Every failure mode of a confirm: unknown email, no active code, expired,
 * attempts exhausted, wrong code, and losing the race to a concurrent confirm.
 *
 * ONE error for all six, for the reason `login-user.ts` documents about its
 * single throw: separate branches start identical and drift apart at the first
 * maintenance — one gains a log, another a message — and the oracle comes back.
 *
 * `BusinessRuleError` → 422 and not 400: the body is well formed (six digits);
 * what failed is a rule. Symmetric with `InvalidCurrentPasswordError` — a wrong
 * secret presented by someone who already identified themselves.
 */
```

- [ ] **Step 2: Acrescentar as constantes de status**

Em `src/modules/auth/infra/http/constants.ts`:

```ts
/**
 * The register endpoint's only success status. It says "accepted, and what
 * happens next happens by email" — which is exactly true, and reveals nothing
 * about whether the address already had an account.
 */
export const ACCEPTED_STATUS = 202
/** The login gate: the password was right, the account is not verified. */
export const FORBIDDEN_STATUS = 403
```

- [ ] **Step 3: Escrever o teste de integração que falha**

Em `tests/integration/drizzle-users-repository.spec.ts`, acrescente:

```
1. markEmailVerified grava email_verified_at e updated_at com os valores passados
2. markEmailVerified não toca em email nem em password_hash
3. markEmailVerified é silencioso para um id inexistente
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm test:integration`
Expected: FAIL.

- [ ] **Step 5: Declarar no contrato**

Em `src/modules/auth/repositories/users-repository.ts`:

```ts
  /**
   * Writes ONLY `email_verified_at` and `updated_at`.
   *
   * Narrow for the same two reasons as `updatePasswordHash`: the wrong column is
   * inexpressible, because this signature cannot reach `email`; and `updatedAt`
   * goes EXPLICITLY, always, because `$onUpdate` fills an absence with the
   * system clock — omitting it is the one way the injected `IClock` stops being
   * the source of truth, and it fails in silence.
   *
   * Two parameters even though the single call site passes the same instant to
   * both: collapsing them would make the repository DECIDE that
   * `email_verified_at` always equals `updated_at`, which is true of this caller
   * and is not a property of the table.
   *
   * Silent about a missing id, like `updatePasswordHash`: the caller has already
   * loaded the user.
   */
  markEmailVerified(id: string, verifiedAt: Date, updatedAt: Date): Promise<void>
```

- [ ] **Step 6: Implementar nos dois adapters**

Drizzle — copie a forma de `updatePasswordHash`, inclusive o `try/catch` com `toPersistenceError`. In-memory — reidrate por `User.fromTrusted` preservando `passwordHash`, `email` e `createdAt`.

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 8: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: let a user be marked verified"
```

---

## Task 7: O emissor, os textos e a configuração do módulo

**Files:**
- Create: `src/modules/auth/notifications/verification-email.ts`, `src/modules/auth/services/email-verification-issuer.ts`, `src/modules/auth/services/email-verification-issuer.spec.ts`
- Modify: `src/modules/auth/config.ts`, `src/modules/auth/config.spec.ts`

**Interfaces:**
- Consumes: `IEmailSender` (T1), `ITokenGenerator.numericCode` (T2), `EmailVerification` (T4), `IEmailVerificationsRepository` (T5).
- Produces:
  - `type DeliverVerification = () => Promise<void>`
  - `class EmailVerificationIssuer` com `issueFor(user: User, verifications: IEmailVerificationsRepository, now: Date): Promise<DeliverVerification>`
  - `VERIFICATION_CODE_DIGITS = 6`
  - funções puras `verificationEmail(to, code, ttlSeconds)`, `accountAlreadyExistsEmail(to)`, `passwordChangedEmail(to)` — todas devolvendo `EmailMessage`
  - env: `EMAIL_VERIFICATION_TTL_SECONDS`, `EMAIL_VERIFICATION_MAX_ATTEMPTS`, `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`, e os pares `REGISTER_RATE_LIMIT_*`, `EMAIL_VERIFY_RATE_LIMIT_*`, `EMAIL_VERIFY_RESEND_RATE_LIMIT_*`

- [ ] **Step 1: Escrever os textos**

`src/modules/auth/notifications/verification-email.ts` — funções puras, sem nenhuma string solta:

```ts
import type { Email } from '#modules/auth/value-objects/email'
import type { EmailMessage } from '#shared/ports/email-sender'

const SECONDS_PER_MINUTE = 60

const VERIFICATION_SUBJECT = 'Confirm your email address'
const ALREADY_EXISTS_SUBJECT = 'Someone tried to register with your address'
const PASSWORD_CHANGED_SUBJECT = 'Your password was changed'

/**
 * The bodies live here, as pure functions, rather than inline in the use cases:
 * they are the one thing in this slice a non-engineer may want to reword, and a
 * reviewer should be able to read every message the system can send in one file.
 */
export function verificationEmail(
  to: Email,
  code: string,
  ttlSeconds: number,
): EmailMessage {
  const minutes = Math.round(ttlSeconds / SECONDS_PER_MINUTE)

  return {
    to: to.value,
    subject: VERIFICATION_SUBJECT,
    text:
      `Your verification code is ${code}.\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n\n` +
      'If you did not create an account, you can ignore this message.',
  }
}

/**
 * Sent when someone registers with an address that already has a VERIFIED
 * account. It is half of what lets the endpoint answer 202 to everyone: the
 * response cannot distinguish the two cases, so the mail does — and it goes only
 * to whoever owns the address.
 */
export function accountAlreadyExistsEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: ALREADY_EXISTS_SUBJECT,
    text:
      'Someone tried to create an account with this email address, ' +
      'and one already exists.\n\n' +
      'If that was you, sign in instead — or reset your password if you have ' +
      'forgotten it. If it was not, no action is needed: nothing changed.',
  }
}

/**
 * The real defence behind the password change endpoint (§11.1 of the slice 9
 * design): an attacker holding a stolen access token can change the password,
 * and the owner finding out is what makes that recoverable.
 */
export function passwordChangedEmail(to: Email): EmailMessage {
  return {
    to: to.value,
    subject: PASSWORD_CHANGED_SUBJECT,
    text:
      'Your password was just changed, and every other session was signed out.\n\n' +
      'If this was not you, reset your password immediately.',
  }
}
```

- [ ] **Step 2: Escrever o teste que falha, para o emissor**

`src/modules/auth/services/email-verification-issuer.spec.ts`. O teste que carrega a fatia é o de **ordem**:

```ts
const INVALIDATE = 'invalidateActiveForUser'
const SAVE = 'save'
const SEND = 'send'

it('invalidates the previous code BEFORE persisting the new one', async () => {
  const { issuer, verifications, callLog } = makeIssuer()

  await issuer.issueFor(user, verifications, NOW)

  expect(callLog).toEqual([INVALIDATE, SAVE])
})

it('does NOT send while issuing — the send is what it returns', async () => {
  const { issuer, verifications, callLog } = makeIssuer()

  await issuer.issueFor(user, verifications, NOW)

  expect(callLog).not.toContain(SEND)
})

it('sends only when the returned thunk is called', async () => {
  const { issuer, verifications, callLog } = makeIssuer()

  const deliver = await issuer.issueFor(user, verifications, NOW)
  await deliver()

  expect(callLog).toEqual([INVALIDATE, SAVE, SEND])
})

it('emails the code in plaintext but persists only its digest', async () => {
  const { issuer, verifications, sent, saved } = makeIssuer()

  const deliver = await issuer.issueFor(user, verifications, NOW)
  await deliver()

  const code = extractCode(sent[0].text)
  expect(saved[0].codeHash).toBe(fakeDigest.hash(code))
  expect(sent[0].text).not.toContain(saved[0].codeHash)
})
```

Escreva os dubles (`callLog`, `fakeDigest`, gerador determinístico) no próprio arquivo, como as outras specs do módulo fazem.

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Escrever o emissor**

`src/modules/auth/services/email-verification-issuer.ts`:

```ts
import { EmailVerification } from '#modules/auth/entities/email-verification'
import type { User } from '#modules/auth/entities/user'
import { verificationEmail } from '#modules/auth/notifications/verification-email'
import type { IEmailVerificationsRepository } from '#modules/auth/repositories/email-verifications-repository'
import type { IEmailSender } from '#shared/ports/email-sender'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** Six digits: what a person can retype from a phone without copy and paste. */
export const VERIFICATION_CODE_DIGITS = 6

/**
 * The send, deferred. Calling it is what puts an email on the wire.
 */
export type DeliverVerification = () => Promise<void>

/**
 * Mints a verification code, persists its digest, and returns the send.
 *
 * **Returning the send is the whole point, and it is what makes the first line
 * of §8 of the unit of work design structural instead of advisory.** The rule
 * says external I/O must happen AFTER the commit, for two independent reasons:
 * the transaction runner re-executes its callback on a deadlock, so a send in
 * there goes out up to three times; and a rollback after a send means an email
 * about an account that does not exist. Because this method hands the send back
 * rather than performing it, there is nothing inside the callback that could
 * send — the caller has to reach the returned function, outside, to do it.
 *
 * `verifications` is a PARAMETER and not a constructor dependency, so the caller
 * chooses which one: pass the transaction-bound repository from the `uow`
 * callback, and the writes join the transaction; pass the autocommit singleton,
 * and they stand alone.
 */
export class EmailVerificationIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly idGenerator: IIdGenerator,
    private readonly ttlSeconds: number,
  ) {}

  async issueFor(
    user: User,
    verifications: IEmailVerificationsRepository,
    now: Date,
  ): Promise<DeliverVerification> {
    // Before the insert, always: only one code may be live per user, and a
    // reissue that left the previous one usable would multiply the attempt
    // budget an attacker gets by the number of resends they can trigger.
    await verifications.invalidateActiveForUser(user.id, now)

    const code = this.tokenGenerator.numericCode(VERIFICATION_CODE_DIGITS)

    await verifications.save(
      EmailVerification.create({
        id: this.idGenerator.generate(),
        userId: user.id,
        codeHash: this.tokenDigest.hash(code),
        now,
        ttlSeconds: this.ttlSeconds,
      }),
    )

    // Returned, NOT awaited. See the class comment.
    return () =>
      this.emailSender.send(verificationEmail(user.email, code, this.ttlSeconds))
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/services/email-verification-issuer.spec.ts`
Expected: PASS.

- [ ] **Step 6: Acrescentar a configuração do módulo**

Em `src/modules/auth/config.ts`, no estilo exato do arquivo (constante `DEFAULT_*` documentada + chave no schema com `.int().positive()`):

```ts
/**
 * 15 minutes. Short because the code is only six digits: what makes 10^6
 * acceptable is not entropy, it is the TTL, the attempt cap and the resend
 * cooldown together. Lengthen any one of them and the other two have to answer
 * for it.
 */
export const DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS = 900

/** Five wrong guesses kill the code. The second half of what substitutes for entropy. */
export const DEFAULT_EMAIL_VERIFICATION_MAX_ATTEMPTS = 5

/**
 * One minute between codes for the same account. Without it, the resend endpoint
 * is an oracle that mints fresh attempt budget on demand — and a way to fill a
 * stranger's inbox from an anonymous request.
 */
export const DEFAULT_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60

/**
 * Registration now sends mail to an arbitrary address from an anonymous request,
 * which makes it a spam amplifier. Until this slice it inherited only the global
 * 300/min. Its own pair, not a shared one, for the reason the login pair already
 * documents: a field named for one route, used by another, is a comment that lies.
 */
export const DEFAULT_REGISTER_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_REGISTER_RATE_LIMIT_WINDOW_SECONDS = 60

/** A request here carries a code guess. Same reasoning as login. */
export const DEFAULT_EMAIL_VERIFY_RATE_LIMIT_MAX_REQUESTS = 10
export const DEFAULT_EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS = 60

/** Same amplifier as register, plus the ability to burn a victim's live code. */
export const DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_MAX_REQUESTS = 5
export const DEFAULT_EMAIL_VERIFY_RESEND_RATE_LIMIT_WINDOW_SECONDS = 60
```

Acrescente as nove chaves correspondentes ao `authEnvSchema`, todas com `z.coerce.number().int().positive().default(...)`.

- [ ] **Step 7: Rodar os portões e commitar**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: mint verification codes without sending them"
```

---

## Task 8: `RegisterUser` responde 202

**Files:**
- Modify: `src/modules/auth/use-cases/register-user.ts`, `src/modules/auth/use-cases/register-user.spec.ts`, `src/modules/auth/infra/http/endpoints/register.ts`, `src/modules/auth/container.ts`

**Interfaces:**
- Consumes: `EmailVerificationIssuer` (T7), `IAuthUnitOfWork` com `emailVerifications` (T5).
- Produces: `RegisterUserUseCase.execute(command): Promise<void>` — `RegisterUserResult` **deixa de existir**.

- [ ] **Step 1: Escrever os testes que falham**

Reescreva `src/modules/auth/use-cases/register-user.spec.ts`. Os testes normativos:

```ts
const USERS_SAVE = 'users.save'
const VERIFICATIONS_INVALIDATE = 'verifications.invalidateActiveForUser'
const VERIFICATIONS_SAVE = 'verifications.save'
const COMMIT = 'COMMIT'
const EMAIL_SEND = 'email.send'

it('persists the user and the code, commits, and only then sends', async () => {
  await useCase.execute({ email: EMAIL, password: PASSWORD })

  // toEqual and not toContain: this single assertion kills a deleted deliver(),
  // a send moved inside the callback, and any reordering of the three writes.
  expect(callLog).toEqual([
    USERS_SAVE,
    VERIFICATIONS_INVALIDATE,
    VERIFICATIONS_SAVE,
    COMMIT,
    EMAIL_SEND,
  ])
})

it('emails a fresh code when the address has an UNVERIFIED account', async () => { /* one message, and it carries a code */ })

it('emails "you already have an account" when the address is VERIFIED', async () => { /* subject differs, no code in the body */ })

it('sends nothing when an unverified account got a code inside the cooldown', async () => {
  expect(sent).toHaveLength(0)
})

it('answers the same way whether the address is free or taken', async () => {
  // both calls resolve; neither throws
})

it('lets an error that is NOT EmailAlreadyInUseError propagate', async () => {
  await expect(useCase.execute(...)).rejects.toThrow(SomeOtherError)
})
```

O fake do `uow` precisa registrar `COMMIT` no `callLog` quando o callback resolve — escreva-o assim no arquivo de teste.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/register-user.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Reescrever o use case**

```ts
export class RegisterUserUseCase {
  constructor(
    /**
     * `Pick`, and the narrowing IS the rule (§9 of the unit of work design):
     * with the full interface, a `save` outside the transaction would compile.
     * The read is here for the collision path only — after a 23505 the
     * transaction is gone, and the decision of WHICH email to send needs to know
     * whether the existing account is already verified.
     */
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    private readonly emailVerifications: Pick<
      IEmailVerificationsRepository,
      'findActiveByUserId'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly issuer: EmailVerificationIssuer,
    private readonly emailSender: IEmailSender,
    private readonly hashProvider: IHashProvider,
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    private readonly resendCooldownMs: number,
  ) {}

  async execute(command: RegisterUserCommand): Promise<void> { /* ... */ }
}
```

O corpo, com a documentação que a spec §6.1 e §9.1 fixam:

```ts
    const email = Email.create(command.email)
    const password = Password.create(command.password)

    // Before the transaction: §8 forbids argon2 inside one.
    const passwordHash = await this.hashProvider.hash(password.value)

    // Read ONCE — the same instant stamps the user, the code and its expiry.
    const now = this.clock.now()

    const user = User.create({
      id: this.idGenerator.generate(),
      email,
      passwordHash,
      now,
    })

    let deliver: DeliverVerification
    try {
      deliver = await this.uow(async ({ users, emailVerifications }) => {
        await users.save(user)

        return this.issuer.issueFor(user, emailVerifications, now)
      })
    } catch (error) {
      if (!(error instanceof EmailAlreadyInUseError)) throw error

      deliver = await this.#deliverForExistingAccount(email, now)
    }

    await deliver()
```

E o caminho de colisão:

```ts
  /**
   * The address is taken, and the response must not say so — so the decision of
   * what the owner is told moves into the mail.
   *
   * The unverified branch is what keeps 202 honest. Without it, someone who
   * registered, lost the email, and tried again would be told they already have
   * an account and would be stuck forever. With it, registering again IS
   * resending — subject to the same cooldown, so it cannot be used to flood.
   */
  async #deliverForExistingAccount(
    email: Email,
    now: Date,
  ): Promise<DeliverVerification> {
    const existing = await this.usersRepository.findByEmail(email)

    // Raced: the row was deleted between the violation and this read. Nothing
    // truthful to send.
    if (existing === null) return NO_DELIVERY

    if (existing.emailVerifiedAt !== null) {
      return () => this.emailSender.send(accountAlreadyExistsEmail(email))
    }

    const active = await this.emailVerifications.findActiveByUserId(existing.id)
    if (active !== null && now.getTime() - active.createdAt.getTime() < this.resendCooldownMs) {
      return NO_DELIVERY
    }

    // A second unit of work, opened after the first one has already unwound —
    // sequential, not nested, so the AsyncLocalStorage guard of §4.2 does not
    // fire. The two writes inside `issueFor` still belong together.
    return this.uow((repos) => this.issuer.issueFor(existing, repos.emailVerifications, now))
  }
```

Com, no topo do arquivo:

```ts
/** Nothing truthful to send, and silence must cost the same as sending. */
const NO_DELIVERY: DeliverVerification = async () => {}
```

> **Medir, não presumir.** A spec marca como `[suposto]` que o segundo `uow`, aberto no `catch` do primeiro, é sequencial e não aninhado. **Prove com um teste** contra o `uow` real (integração) ou lendo a implementação da guarda em `src/infra/database/unit-of-work.ts`. Se a guarda disparar, mova a emissão do caminho de colisão para o repositório autocommit e escreva o porquê.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/register-user.spec.ts`
Expected: PASS.

- [ ] **Step 5: Trocar o contrato do endpoint**

Em `src/modules/auth/infra/http/endpoints/register.ts`:

- resposta passa a ser `[ACCEPTED_STATUS]: z.null()`; some `createdSchema`, some `CREATED_STATUS`, some `CONFLICT_STATUS`;
- o handler vira `await container.registerUser.execute(request.body); return reply.status(ACCEPTED_STATUS).send(null)`;
- `config: { rateLimit: container.registerRateLimit }` — copie a forma do `login.ts`;
- atualize `REGISTER_DESCRIPTION` para dizer a verdade nova:

```ts
const REGISTER_DESCRIPTION =
  'Creates an account from an email and a password, and emails a verification ' +
  'code. Always answers 202, whether or not the address already had an account: ' +
  'a status that distinguished the two would let anyone enumerate accounts. What ' +
  'differs is the email the address receives.'
```

- [ ] **Step 6: Ligar o container**

Em `src/modules/auth/container.ts`: instancie `SmtpEmailSender`, `EmailVerificationIssuer`, exponha `registerRateLimit`, e passe as novas dependências ao `RegisterUserUseCase`. O container precisa de `Env` (para `MAIL_*`) além de `AuthConfig` — leia como `makeAuthContainer` é chamado em `src/main/container.ts` e ajuste a assinatura de forma consistente.

- [ ] **Step 7: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: close the account oracle on register"
```

---

## Task 9: `ConfirmEmail`

**Files:**
- Create: `src/modules/auth/use-cases/confirm-email.ts`, `src/modules/auth/use-cases/confirm-email.spec.ts`, `src/modules/auth/infra/http/endpoints/confirm-email.ts`
- Modify: `src/modules/auth/container.ts`, `src/modules/auth/infra/http/routes.ts`

**Interfaces:**
- Produces: `ConfirmEmailUseCase.execute(command: { email: string; code: string }): Promise<{ accessToken: string; refreshToken: string }>`; rota `POST /auth/email/verify`.

- [ ] **Step 1: Escrever os testes que falham**

`src/modules/auth/use-cases/confirm-email.spec.ts`. Os obrigatórios:

```
1. os SEIS modos de falha lançam EmailVerificationFailedError, e a MESMA
   mensagem: e-mail desconhecido, sem código ativo, expirado, tentativas
   esgotadas, código errado, consume devolvendo false
2. código errado chama incrementAttempts exatamente uma vez, FORA da transação
   (callLog não contém COMMIT antes dele)
3. o sucesso: expect(callLog).toEqual([
     'verifications.consume', 'users.markEmailVerified',
     'refreshTokens.save', COMMIT,
   ])
4. o access token carrega sub = user.id
5. consume devolvendo false NÃO marca o usuário verificado
6. o mesmo instante do IClock vai para consume, markEmailVerified e o token
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/confirm-email.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Escrever o use case**

Corpo exatamente como o §9.2 da spec. Construtor:

```ts
  constructor(
    private readonly usersRepository: Pick<IUsersRepository, 'findByEmail'>,
    /**
     * `incrementAttempts` is a WRITE, and it is in this Pick on purpose.
     *
     * §9 of the unit of work design tells a use case holding the UoW to declare
     * its direct repository with the READ methods it uses. This is the first
     * justified exception, and the third line of §8 is the justification: a
     * brute-force counter written inside a transaction that rolls back is erased
     * exactly when it matters. The rule is therefore not "reads only" but "what
     * the use case uses, and a write only where §8 puts it outside".
     */
    private readonly verifications: Pick<
      IEmailVerificationsRepository,
      'findActiveByUserId' | 'incrementAttempts'
    >,
    private readonly uow: IAuthUnitOfWork,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly maxAttempts: number,
  ) {}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/confirm-email.spec.ts`
Expected: PASS.

- [ ] **Step 5: Escrever o endpoint**

`src/modules/auth/infra/http/endpoints/confirm-email.ts`, copiando a forma de `login.ts` (leia-o): `sessionTokensSchema` na resposta `200`, cookie de refresh via `refresh-cookie.ts`, `config: { rateLimit: container.emailVerifyRateLimit }`.

```ts
const CONFIRM_EMAIL_PATH = '/email/verify'
const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/
const EXAMPLE_VERIFICATION_CODE = '042317'
```

Corpo: `{ email, code }`, com o `email` no mesmo formato do `register` e o `code` validado pelo padrão. Respostas declaradas: `200`, `400`, `422`, `429`, `503`.

- [ ] **Step 6: Registrar a rota e ligar o container**

Em `routes.ts` e `container.ts`.

- [ ] **Step 7: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: expose POST /auth/email/verify"
```

---

## Task 10: Reenvio e o gate do login

**Files:**
- Create: `src/modules/auth/use-cases/request-email-verification.ts` + `.spec.ts`, `src/modules/auth/infra/http/endpoints/resend-verification.ts`
- Modify: `src/modules/auth/use-cases/login-user.ts` + `.spec.ts`, `src/modules/auth/infra/http/endpoints/login.ts`, `src/modules/auth/container.ts`, `src/modules/auth/infra/http/routes.ts`

- [ ] **Step 1: Escrever os testes que falham, para o reenvio**

```
1. e-mail desconhecido: resolve, nenhum envio
2. conta já verificada: resolve, nenhum envio
3. código ativo criado dentro do cooldown: resolve, nenhum envio
4. código ativo criado ANTES do cooldown: emite e envia, nessa ordem
5. nenhum código ativo: emite e envia
6. o envio acontece depois do COMMIT — toEqual no callLog
```

- [ ] **Step 2: Escrever o teste que falha, para o gate**

Em `src/modules/auth/use-cases/login-user.spec.ts`:

```ts
it('refuses an unverified account with EmailNotVerifiedError', async () => {
  await expect(useCase.execute(validCredentials)).rejects.toBeInstanceOf(
    EmailNotVerifiedError,
  )
})

// THE test of this task. Deleting the gate breaks the one above; moving it
// ABOVE the password check breaks only this one — and moving it up is exactly
// the "simplification" a future reader will be tempted by.
it('reports bad credentials, not the gate, when the password is wrong on an unverified account', async () => {
  await expect(
    useCase.execute({ email: EMAIL, password: WRONG_PASSWORD }),
  ).rejects.toBeInstanceOf(InvalidCredentialsError)
})

it('issues a session for a verified account', async () => { /* unchanged */ })
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:unit`
Expected: FAIL nos dois arquivos.

- [ ] **Step 4: Implementar o reenvio**

`RequestEmailVerificationUseCase`, corpo conforme §9.3 da spec. `execute(command: { email: string }): Promise<void>`. Construtor recebe `Pick<IUsersRepository, 'findByEmail'>`, `Pick<IEmailVerificationsRepository, 'findActiveByUserId'>`, `IAuthUnitOfWork`, `EmailVerificationIssuer`, `IClock`, `cooldownMs: number`.

- [ ] **Step 5: Implementar o gate**

Em `login-user.ts`, depois do `if (user === null || !matches)`:

```ts
    // AFTER the credential check, never before: the "unverified" signal must
    // only ever reach someone who already proved they know the password.
    // Checking first would hand any anonymous caller an account oracle — the
    // very thing the decoy hash above exists to deny them.
    if (user.emailVerifiedAt === null) throw new EmailNotVerifiedError()
```

Remova o parágrafo do docstring que diz que o gate não existe, e substitua por uma frase dizendo que ele existe e por que a ordem importa.

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Endpoint de reenvio e `403` no login**

`resend-verification.ts`: `POST /email/verify/resend`, corpo `{ email }`, resposta `[ACCEPTED_STATUS]: z.null()`, `config: { rateLimit: container.emailVerifyResendRateLimit }`. Descrição dizendo que a resposta é a mesma para endereço inexistente, já verificado, ou dentro do cooldown — e por quê.

Em `login.ts`, acrescente `[FORBIDDEN_STATUS]: errorResponseSchema` às respostas.

Registre a rota e ligue o container.

- [ ] **Step 8: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
git add -A
git commit -m "feat: gate login on a verified email, and allow a resend"
```

---

## Task 11: A notificação de troca de senha

**Files:**
- Create: `src/infra/providers/best-effort-email-sender.ts` + `.spec.ts`
- Modify: `src/modules/auth/use-cases/change-password.ts` + `.spec.ts`, `src/modules/auth/container.ts`

- [ ] **Step 1: Escrever o teste que falha, para o decorador**

```ts
it('resolves even when the wrapped sender rejects', async () => {
  await expect(bestEffort.send(MESSAGE)).resolves.toBeUndefined()
})

it('logs the failure, so a silent outage is still visible', async () => {
  await bestEffort.send(MESSAGE)

  expect(logged).toHaveLength(1)
})

it('does not log the message body, which may name the recipient', async () => {
  await bestEffort.send(MESSAGE)

  expect(JSON.stringify(logged)).not.toContain(MESSAGE.text)
})

it('passes a successful send straight through', async () => {
  await bestEffort.send(MESSAGE)

  expect(sent).toEqual([MESSAGE])
})
```

- [ ] **Step 2: Escrever o decorador**

`src/infra/providers/best-effort-email-sender.ts`:

```ts
import type { EmailMessage, IEmailSender } from '#shared/ports/email-sender'

const SEND_FAILED_MESSAGE = 'best-effort email delivery failed'

/**
 * The only thing this decorator needs from a logger, declared as its own shape
 * for the same reason `WarnLogger` is: pino's methods are overloaded, and
 * picking one drags every overload along, which would make this untestable
 * without a full pino instance.
 */
export interface ErrorLogger {
  error(details: Record<string, unknown>, message: string): void
}

/**
 * Swallows a delivery failure instead of letting it fail the request.
 *
 * It exists because the two families of email in this system want OPPOSITE
 * policies. A verification code that fails to send should propagate: the account
 * is unusable without it, and registering again heals itself through the
 * collision path. A "your password was changed" notice must not: the password
 * has ALREADY changed, so a 500 would tell the user the change failed while
 * their old password no longer works — active misinformation, and worse than
 * silence.
 *
 * The policy lives here, in infrastructure, and is applied by wiring, because
 * decision 15 forbids the use case from receiving a logger — and a use case that
 * caught this itself would have nowhere to report it. The composition root wraps
 * the sender for the notification and passes the bare one everywhere else, which
 * puts the choice where decision 08 says it belongs.
 */
export class BestEffortEmailSender implements IEmailSender {
  constructor(
    private readonly inner: IEmailSender,
    private readonly logger: ErrorLogger,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.inner.send(message)
    } catch (error) {
      // The subject, never the body: a body can carry a code, and `to` is
      // already an address the log has no reason to repeat in full.
      this.logger.error({ err: error, subject: message.subject }, SEND_FAILED_MESSAGE)
    }
  }
}
```

- [ ] **Step 3: Escrever o teste que falha, no `change-password`**

```ts
it('notifies the owner AFTER the transaction commits', async () => {
  await useCase.execute(command)

  expect(callLog).toEqual([
    'users.updatePasswordHash',
    'refreshTokens.revokeAllForUser',
    'refreshTokens.save',
    'COMMIT',
    'email.send',
  ])
})

it('still returns a session when the notification cannot be delivered', async () => {
  // with a sender that rejects, wrapped by BestEffortEmailSender
  await expect(useCase.execute(command)).resolves.toHaveProperty('accessToken')
})
```

- [ ] **Step 4: Implementar**

`ChangePasswordUseCase` ganha `private readonly emailSender: IEmailSender` e, **depois** do `await this.uow(...)** e antes do `return`:

```ts
    // After the commit, like every other send in this module (§8). The wiring —
    // not this line — is what makes a failure here harmless: the composition
    // root hands this use case a best-effort sender, because the password has
    // already changed and a 500 would misinform.
    await this.emailSender.send(passwordChangedEmail(user.email))
```

- [ ] **Step 5: Rodar, ligar o container, portões, commit**

```bash
pnpm test:unit
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
git add -A
git commit -m "feat: tell the owner their password changed"
```

---

## Task 12: Os testes de integração ponta a ponta

**Files:**
- Create: `tests/integration/setup/mailpit.ts`, `tests/integration/verify-email.spec.ts`
- Modify: `tests/integration/register.spec.ts`, `tests/integration/login.spec.ts`, `tests/integration/change-password.spec.ts`

- [ ] **Step 1: Escrever o cliente do Mailpit**

`tests/integration/setup/mailpit.ts` — mesma justificativa de `test-database-url.ts` para a URL ser constante e não vir do ambiente:

```ts
const MAILPIT_BASE_URL = 'http://127.0.0.1:8025'
const MESSAGES_ENDPOINT = `${MAILPIT_BASE_URL}/api/v1/messages`
const LATEST_MESSAGE_ENDPOINT = `${MAILPIT_BASE_URL}/api/v1/message/latest`
const VERIFICATION_CODE_PATTERN = /\b(\d{6})\b/
```

Exporte:
- `clearMailpit(): Promise<void>` — `DELETE` em `/api/v1/messages`, chamado no `beforeEach`;
- `latestMessage(): Promise<{ subject: string; text: string; to: string }>`;
- `messageCount(): Promise<number>`;
- `extractVerificationCode(text: string): string` — lança se não achar, porque um teste que aceita "não achei" não testa nada.

> A entrega SMTP é assíncrona: o `send` resolve quando o servidor aceita, e o Mailpit indexa logo depois. Escreva uma espera por condição (poll curto com timeout) em vez de um `sleep` fixo, e **documente o porquê no arquivo**.

- [ ] **Step 2: Escrever o teste ponta a ponta**

`tests/integration/verify-email.spec.ts`:

```
1. register responde 202 com corpo vazio; o Mailpit recebe UMA mensagem
2. o código extraído dela confirma a conta: 200, com accessToken e cookie de
   refresh; users.email_verified_at deixa de ser nulo
3. login ANTES de confirmar responde 403 EMAIL_NOT_VERIFIED
4. login DEPOIS de confirmar responde 200
5. o mesmo código não confirma duas vezes — a segunda responde 422
6. cinco códigos errados esgotam as tentativas; o código CERTO então responde 422
7. resend com a conta ainda não verificada entrega uma mensagem nova, e o código
   ANTIGO deixa de funcionar
8. resend para e-mail inexistente responde 202 e não entrega nada
```

- [ ] **Step 3: Atualizar os testes que o contrato quebrou**

`register.spec.ts`: `201` vira `202`, corpo vazio, e o caso de e-mail duplicado passa a esperar `202` — **não** `409`. Acrescente: as duas respostas são byte a byte iguais.

`login.spec.ts`: as contas dos cenários precisam ser verificadas antes; acrescente o caso `403`.

`change-password.spec.ts`: a conta precisa estar verificada para logar.

- [ ] **Step 4: Rodar tudo**

```bash
docker compose up -d
pnpm test:integration
```

- [ ] **Step 5: Portões e commit**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPES_OK
pnpm test:unit
pnpm test:integration
pnpm build
git add -A
git commit -m "test: prove the verification flow against a real SMTP server"
```

---

## Task 13: As emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/superpowers/specs/2026-08-29-unit-of-work-design.md`, `ARCHITECTURE.md`, `docs/STRUCTURE.md`, `docs/local.md`

- [ ] **Step 1: `DECISIONS.md`**

Na decisão 13, registre `EmailNotVerifiedError` → 403 e `EmailVerificationFailedError` → 422 como as instâncias novas da taxonomia. Acrescente uma seção curta sobre a mudança de contrato do `register` (`202` sempre) e sobre a **ausência deliberada de backfill**, com a ressalva normativa para apps derivados que já estejam em produção.

- [ ] **Step 2: §8 e §9 da spec do Unit of Work**

§8: acrescente o thunk `deliver` como o caso concreto da linha "I/O externo", e a distinção entre os dois estragos (retry × rollback).

§9: emende a regra. Hoje ela diz que o `Pick` lista métodos de **leitura**. Passa a dizer: o `Pick` lista o que o use case usa, e uma **escrita** só entra quando a terceira linha do §8 a justifica — com `ConfirmEmailUseCase.incrementAttempts` como o primeiro caso, e o porquê escrito no lugar.

- [ ] **Step 3: `ARCHITECTURE.md` §11**

Acrescente à seção "Bibliotecas que falham em silêncio" o que a implementação tiver descoberto sobre o nodemailer — começando por `requireTLS`, que por default é `false` e manda em texto claro sem avisar. **Escreva só o que você mediu.**

- [ ] **Step 4: `STRUCTURE.md` e `local.md`**

Arquivos novos na árvore; Mailpit em `http://127.0.0.1:8025` nas instruções locais.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: amend the rules the verification slice moved"
```

---

## Self-review do plano

**Cobertura da spec:** §5 → T7; §6.1 → T8; §6.2 → T2+T4; §6.3/§6.4 → T6+T9+T10; §6.5 → T10; §6.6 → T9; §6.7 → T3; §7.1 → T1; §7.2 → T3; §7.3 → T4; §7.4 → T5+T6; §8.1 → T1; §8.2 → T7; §8.3 → T1; §9.1 → T8; §9.2 → T9; §9.3/§9.4 → T10; §9.5 → T11; §10 → distribuído + T12; §11 → T5 (rowCount) e T8 (uow sequencial); §13 → T13. **Sem lacunas.**

**Consistência de tipos:** `IEmailSender.send` / `EmailMessage` (T1) usados em T7, T8, T11 · `numericCode` (T2) usado em T7 · `EmailVerification.create`/`isUsable`/`matches` (T4) usados em T5, T7, T9 · `IEmailVerificationsRepository` (T5) usado em T7, T8, T9, T10 · `markEmailVerified` (T6) usado em T9 · `DeliverVerification` (T7) usado em T8, T10 · `ACCEPTED_STATUS`/`FORBIDDEN_STATUS` (T6) usados em T8, T9, T10.

**Dois pontos que a implementação tem de MEDIR, não presumir** — a spec os marca `[suposto]` e as tasks repetem a cobrança: o `rowCount` do `consume` (T5) e o `uow` sequencial no `catch` (T8).
