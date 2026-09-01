# Fatia 7 — Refresh token rotativo: plano de implementação

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`) para acompanhamento.

**Goal:** fechar a decisão 11 — refresh opaco de 60 dias, rotativo a cada uso,
com janela de graça de 30s, detecção de reuso que revoga a família, e revogação
explícita por `logout` e `logout-all`, nos dois transportes da decisão 12.

**Architecture:** a rotação inteira roda dentro do `uow` da fatia 4, com
`SELECT ... FOR UPDATE` na linha do token apresentado. A entidade `RefreshToken`
carrega os predicados de fronteira (expirado, revogado, dentro da janela); o
repositório expõe comandos (`revokeFamily`, `revokeAllForUser`) porque revogar
família é um `UPDATE`, não N. O token em claro nunca é persistido — só o digest
SHA-256, que é indexável.

**Tech Stack:** TypeScript 7.0.2 · Fastify 5.12.1 · `@fastify/cookie` 11.1.2
(**dependência nova**) · Drizzle 1.0.0-rc.4 · Zod 4.4.3 · Vitest 4 · Biome 2.5.9

**Spec:** [`docs/superpowers/specs/2026-08-31-refresh-token-design.md`](../specs/2026-08-31-refresh-token-design.md)

---

## Pré-requisito de ambiente

`package.json` exige `node >=24.19.0 <25` e o `pnpm` **recusa rodar scripts**
fora disso. `nvm use` (ou `fnm use`) e confira com `node -v`.

Postgres precisa estar de pé da **Task 3** em diante: `docker compose up -d`
(dev em 5432, test em 5433). Tasks 1 e 2 rodam sem banco.

> ⚠️ **A store do pnpm mora sob a revisão do snap do VS Code.** Quando o snap
> atualiza (`~/snap/code/255` → `259`), `pnpm add` recusa com *"currently linked
> from the store at …/255"* e `pnpm install` responde "Already up to date" sem
> relinkar — a guarda só dispara numa mutação. Contorno usado no planejamento:
> `pnpm add <pkg> --store-dir ~/snap/code/255/.local/share/pnpm/store/v11`,
> apontando para a revisão de onde o `node_modules` está linkado. Isso **não é
> problema do repositório**, e `@fastify/cookie` já foi instalado por este
> caminho — a Task 6 encontra a dependência pronta.

## Global Constraints

Valem para **todas** as tarefas. Copiadas do `CLAUDE.md`, do `biome.jsonc`, do
`ARCHITECTURE.md` e da spec.

- **Idioma:** todo código, identificador, string, mensagem de erro e
  **comentário** em **inglês**. Só arquivo `.md` pode ser português.
- **Zero magic string/number.** Constante nomeada em `UPPER_SNAKE_CASE`,
  declarada perto do uso. Inclui status HTTP, nome de cookie, algoritmo de
  digest, contagens e timeouts.
  **Exceção:** `schema/*.ts` escreve nome de tabela, coluna e índice inline —
  mas ela **para de valer para `refresh_tokens_token_hash_unique`**, que o
  repositório lê para nomear a colisão. O próprio `CLAUDE.md` prevê isso: a
  exceção morre quando o nome passa a ser lido de outro arquivo, e ele vira
  constante exportada **declarada dentro do arquivo de schema**, como
  `USERS_EMAIL_LOWER_UNIQUE_INDEX`. Os outros dois índices seguem inline.
- **Formatação (Biome):** indentação de 2 espaços, largura **90**, aspas
  **simples**, **sem** ponto e vírgula, trailing comma. Rode `pnpm lint:fix`
  antes de cada commit.
- **Imports:** subpath imports (`#shared/*`, `#infra/*`, `#modules/*`) para
  outra pasta; relativo com sufixo `.js` (`./schema/users.js`) para irmão.
  **Ordem alfabética pelo especificador** — o `organizeImports` do Biome trata
  ordem errada como **erro**, não aviso.
- **`type` e não `interface` para contrato só-chamável.** Vale para tipo com
  única call signature (`IUnitOfWork`); interface com **métodos nomeados**
  (`IRefreshTokensRepository`, `ITokenGenerator`) continua `interface`.
- **Camada pura não importa infra.** `entities/`, `value-objects/`,
  `use-cases/`, `services/`, `ports/` e `repositories/` não podem importar
  `drizzle-orm`, `pg`, `fastify` nem `#infra/database/client`.
- **R7 — camada pura não produz valor não determinístico.** Nada de
  `new Date()` sem argumento, `Date.now()`, `Math.random()` ou
  `crypto.randomUUID()`. Tempo vem do `IClock`, id do `IIdGenerator`,
  aleatoriedade do `ITokenGenerator`. `new Date(millis)` é determinístico e
  **permitido**.
- **Todo endpoint declara todo status que ele mesmo produz** (`ARCHITECTURE`
  §7). Não se declara `500` nem `415`, que são universais.
- **Comandos:** `pnpm typecheck` · `pnpm lint` · `pnpm test:unit` ·
  `pnpm test:integration` · `pnpm test` · `pnpm db:generate` · `pnpm db:migrate`

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/shared/ports/token-generator.ts` | **Criar.** Contrato do valor opaco. Puro. |
| `src/shared/ports/token-digest.ts` | **Criar.** Contrato do digest indexável. Puro. |
| `src/infra/providers/random-token-generator.ts` | **Criar.** `randomBytes` → base64url. |
| `src/infra/providers/sha256-token-digest.ts` | **Criar.** `createHash('sha256')` → hex. |
| `src/modules/auth/entities/refresh-token.ts` | **Criar.** Estado e os três predicados de fronteira. Puro. |
| `src/modules/auth/services/refresh-token-issuer.ts` | **Criar.** Cunha um par (claro + entidade). Puro. **Pasta nova** — ver achado 9. |
| `src/modules/auth/errors/invalid-refresh-token-error.ts` | **Criar.** 401. |
| `src/modules/auth/errors/refresh-token-reused-error.ts` | **Criar.** 401, e a linha de log do evento de segurança. |
| `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts` | **Criar.** A declaração da tabela. |
| `src/modules/auth/infra/drizzle/refresh-token-mapper.ts` | **Criar.** Linha ↔ entidade (decisão 20). |
| `src/modules/auth/repositories/refresh-tokens-repository.ts` | **Criar.** O contrato. Puro. |
| `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts` | **Criar.** `FOR UPDATE`, `SET LOCAL`, os três comandos de revogação, e `RefreshTokenHashCollisionError`. |
| `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts` | **Criar.** Dublê dos testes unitários. |
| `src/modules/auth/infra/drizzle/auth-repositories.ts` | **Modificar.** Uma linha. |
| `src/modules/auth/repositories/unit-of-work.ts` | **Modificar.** `AuthRepos` ganha `refreshTokens`. |
| `src/modules/auth/config.ts` | **Modificar.** TTL e janela de graça. |
| `src/modules/auth/use-cases/login-user.ts` | **Modificar.** Passa a emitir o par. |
| `src/modules/auth/use-cases/refresh-token.ts` | **Criar.** A máquina de estados do §4.1 da spec. |
| `src/modules/auth/use-cases/logout.ts` | **Criar.** Revoga a família do token apresentado. |
| `src/modules/auth/use-cases/logout-all.ts` | **Criar.** Revoga todas as famílias do usuário. |
| `src/modules/auth/infra/http/refresh-cookie.ts` | **Criar.** Os atributos do cookie, em **um** lugar. |
| `src/modules/auth/infra/http/endpoints/{refresh,logout,logout-all}.ts` | **Criar.** Um arquivo por endpoint (decisão 03). |
| `src/modules/auth/infra/http/endpoints/login.ts` | **Modificar.** `refreshTransport` e o par na resposta. |
| `src/modules/auth/infra/http/constants.ts` | **Modificar.** 204 e 503. |
| `src/modules/auth/infra/http/routes.ts` | **Modificar.** Três linhas. |
| `src/modules/auth/container.ts` | **Modificar.** Três use cases, três providers, o issuer. |
| `src/main/app.ts` | **Modificar.** Registra `@fastify/cookie`. |
| `src/infra/config/fixtures/test-env.ts` | **Modificar.** As duas variáveis. |

## Achados da fase de planejamento

Foram **executados** durante o planejamento, não presumidos. Contam como
resolvidos; se algum falhar na sua mão, é regressão, não incerteza.

1. **`SET LOCAL lock_timeout = $1` é REJEITADO pelo Postgres** —
   `42601 syntax error at or near "$1"`. `SET` não aceita parâmetro ligado.
   Tem de ser `sql.raw`, e por isso o valor **nunca** pode vir de request:
   ```ts
   await db.execute(sql`SET LOCAL lock_timeout = ${sql.raw(String(ROTATION_LOCK_TIMEOUT_MS))}`)
   ```
2. **`SET LOCAL` reverte no commit.** Medido na mesma sessão: `1s` dentro da
   transação, `5s` (o do pool) depois do `COMMIT`. É seguro com pool.
3. **`.for('update')` existe no Drizzle 1.0.0-rc.4** e compila sobre o
   tipo-união `Database`. `LockStrength` é `'update' | 'no key update' | 'share'
   | 'key share'`.
4. **`db.execute(sql\`…\`)` compila sobre o tipo-união `Database`** — não
   precisa de narrowing nem cast.
5. **`randomBytes(32).toString('base64url')` → 43 caracteres**, sem `+`, `/` nem
   `=`. `createHash('sha256').digest('hex')` → 64 caracteres.
6. **Com o type provider do Zod, só se pode responder um status DECLARADO.**
   `reply.status(204)` num endpoint que declara só `401` é **erro de
   compilação**: `Argument of type '204' is not assignable to parameter of type
   '401'`. A regra do §7 do `ARCHITECTURE.md` ganha dente do compilador para o
   status do próprio handler.
7. **204 exige `.send(null)`, não `.send()`** — `.send()` dá
   `Expected 1 arguments, but got 0`. Declarado como `z.null()`, o corpo sai
   com **0 bytes** e o OpenAPI publica `{"description":"Default Response"}`
   **sem `content`**, que é a forma certa para um 204.
8. **`clearCookie` NÃO herda os atributos do `setCookie`.** Com só `{ path }`
   sai `SameSite=Lax`, **sem `HttpOnly` e sem `Secure`**. Passando o conjunto
   completo sai `HttpOnly; Secure; SameSite=Strict`. A deleção funciona nos dois
   casos (o browser casa por nome+domínio+path), mas divergir é ruído — passe
   sempre o conjunto completo.
9. **A ordem de registro do `@fastify/cookie` NÃO importa.** Registrado *depois*
   das rotas, `request.cookies` funciona. Diferente do `@fastify/swagger`, que
   engancha `onRoute` e precisa vir antes. Não generalize a armadilha do swagger.
10. **`setCookie` emite exatamente o que a decisão 12 pede:**
    `refresh_token=…; Max-Age=5184000; Path=/auth; HttpOnly; Secure; SameSite=Strict`.
11. **Zod `z.enum([...]).default('body')` funciona nos dois sentidos** e rejeita
    valor fora do conjunto. A armadilha do `.default()` do §11 do
    `ARCHITECTURE.md` não morde aqui porque entrada e saída são o mesmo tipo.
12. **`container.auth.uow` TEM um consumidor**: `tests/integration/unit-of-work.spec.ts:51`.
    Ele continua publicado — não remova, e atualize o comentário que diz "sem
    nenhum consumidor".
13. **Baseline verde antes de começar:** 29 arquivos, **214 testes**,
    `pnpm typecheck` e `pnpm lint` limpos.
14. **`@fastify/cookie@11.1.2` já instalado**, versão exata, declara
    `fastify: ^5.0.0`.
15. **Schema com FK `onDelete: 'cascade'` e coluna `replaced_by` sem FK
    compila.** Sem FK auto-referente não é preciso anotar `AnyPgColumn`.

> **9 — a pasta `services/` é nova, e é um desvio da árvore do §9 da spec.**
> O motivo é o construtor: sem um `RefreshTokenIssuer`, o `LoginUserUseCase`
> receberia nove colaboradores (repositório de usuários, de refresh, hash,
> signer, generator, digest, clock, idGenerator, TTL). Cunhar um par —
> gerar opaco, digerir, montar a entidade — é a mesma operação em `login` e nos
> dois ramos da rotação, então ela vira um **domain service** puro. Com ele,
> os dois use cases ficam em seis parâmetros.

---

## Task 1: As duas portas e os dois adapters

**Files:**
- Create: `src/shared/ports/token-generator.ts`
- Create: `src/shared/ports/token-digest.ts`
- Create: `src/infra/providers/random-token-generator.ts`
- Create: `src/infra/providers/sha256-token-digest.ts`
- Test: `src/infra/providers/random-token-generator.spec.ts`
- Test: `src/infra/providers/sha256-token-digest.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `interface ITokenGenerator { opaque(bytes?: number): string }`
  - `interface ITokenDigest { hash(value: string): string }`
  - `class RandomTokenGenerator implements ITokenGenerator`
  - `class Sha256TokenDigest implements ITokenDigest`
  - `const DEFAULT_OPAQUE_TOKEN_BYTES = 32`

**Contexto que o executor precisa.** São **duas** portas e não uma porque gerar
segredo e indexar segredo mudam por razões diferentes — é o mesmo critério que
a emenda da decisão 21 usou para partir `ITokenGenerator` de `IIdGenerator`. E
tem consequência de segurança: com a digest atrás de porta, não existe na camada
pura um lugar onde alguém escreva `hashProvider.hash(token)` (argon2) e veja
aquilo virar `token_hash`. Argon2 tem salt aleatório, então `WHERE token_hash =
?` nunca casaria e a busca degeneraria em varrer a tabela rodando argon2 por
linha — DoS de CPU num endpoint de alta frequência (decisão 11).

- [ ] **Step 1: Escrever os specs que falham**

Crie `src/infra/providers/random-token-generator.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPAQUE_TOKEN_BYTES,
  RandomTokenGenerator,
} from '#infra/providers/random-token-generator'

const SAMPLE_SIZE = 200
const SMALLER_BYTES = 16
const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/

/** 32 bytes in base64url is 43 characters, with no padding. */
const DEFAULT_ENCODED_LENGTH = 43

describe('RandomTokenGenerator', () => {
  it('never repeats a value across a large sample', () => {
    const generator = new RandomTokenGenerator()

    const values = new Set(
      Array.from({ length: SAMPLE_SIZE }, () => generator.opaque()),
    )

    expect(values.size).toBe(SAMPLE_SIZE)
  })

  it('encodes as base64url, so the value is safe in a cookie and in a URL', () => {
    // `+`, `/` and `=` are what plain base64 would add. A `+` in a cookie value
    // is decoded as a space by some clients, which would silently corrupt the
    // token on the way back.
    expect(new RandomTokenGenerator().opaque()).toMatch(BASE64URL_ONLY)
  })

  it('defaults to 32 bytes of entropy', () => {
    expect(DEFAULT_OPAQUE_TOKEN_BYTES).toBe(32)
    expect(new RandomTokenGenerator().opaque()).toHaveLength(DEFAULT_ENCODED_LENGTH)
  })

  it('honours a requested size', () => {
    const shorter = new RandomTokenGenerator().opaque(SMALLER_BYTES)

    expect(shorter.length).toBeLessThan(DEFAULT_ENCODED_LENGTH)
  })
})
```

Crie `src/infra/providers/sha256-token-digest.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Sha256TokenDigest } from '#infra/providers/sha256-token-digest'

const TOKEN = 'an-opaque-refresh-token'
const OTHER_TOKEN = 'another-opaque-refresh-token'

/** sha256 in hex is always 64 characters. */
const HEX_DIGEST_LENGTH = 64

describe('Sha256TokenDigest', () => {
  it('is deterministic, which is what makes the column indexable', () => {
    // The whole point, and the reason argon2 is wrong here: a random salt would
    // make `WHERE token_hash = ?` never match, and the lookup would degenerate
    // into scanning the table hashing every row.
    const digest = new Sha256TokenDigest()

    expect(digest.hash(TOKEN)).toBe(digest.hash(TOKEN))
  })

  it('separates different tokens', () => {
    const digest = new Sha256TokenDigest()

    expect(digest.hash(TOKEN)).not.toBe(digest.hash(OTHER_TOKEN))
  })

  it('never returns the token itself', () => {
    const hashed = new Sha256TokenDigest().hash(TOKEN)

    expect(hashed).not.toContain(TOKEN)
    expect(hashed).toHaveLength(HEX_DIGEST_LENGTH)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falham**

Run: `pnpm test:unit -- random-token-generator sha256-token-digest`
Expected: FAIL — não resolve `#infra/providers/random-token-generator`.

- [ ] **Step 3: Escrever as portas**

Crie `src/shared/ports/token-generator.ts`:

```ts
/**
 * The only source of cryptographic randomness the pure layer may use (R7).
 *
 * Deliberately separate from `ITokenDigest`, and from `IIdGenerator` before it:
 * minting a secret, making a secret findable, and naming an entity change for
 * different reasons. Bundling them would hand a use case that only wants an id
 * a port that also mints secrets.
 */
export interface ITokenGenerator {
  /**
   * An unguessable opaque value, for refresh tokens and anything else that must
   * carry entropy and no meaning. The encoding is the adapter's business.
   */
  opaque(bytes?: number): string
}
```

Crie `src/shared/ports/token-digest.ts`:

```ts
/**
 * A deterministic digest of an opaque value, so the value can be found through
 * a unique index.
 *
 * NEVER a password hash. Argon2 salts randomly, so `WHERE token_hash = ?` would
 * never match, and the lookup would degenerate into scanning the table running
 * argon2 per row — a CPU denial-of-service vector on an endpoint a mobile app
 * calls every hour. An opaque token already carries 256 bits of entropy; what
 * it needs is a deterministic digest, not key stretching (decision 11).
 *
 * That is why this is a port of its own rather than a method on
 * `IHashProvider`: the two must not be reachable from the same object.
 */
export interface ITokenDigest {
  hash(value: string): string
}
```

- [ ] **Step 4: Escrever os adapters**

Crie `src/infra/providers/random-token-generator.ts`:

```ts
import { randomBytes } from 'node:crypto'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/** 256 bits — the size decision 11 gives the refresh token. */
export const DEFAULT_OPAQUE_TOKEN_BYTES = 32

/**
 * Not plain base64: a `+` in a cookie value is decoded as a space by some
 * clients, and `=` padding needs escaping in a URL. base64url has neither.
 */
const TOKEN_ENCODING = 'base64url'

export class RandomTokenGenerator implements ITokenGenerator {
  opaque(bytes: number = DEFAULT_OPAQUE_TOKEN_BYTES): string {
    return randomBytes(bytes).toString(TOKEN_ENCODING)
  }
}
```

Crie `src/infra/providers/sha256-token-digest.ts`:

```ts
import { createHash } from 'node:crypto'
import type { ITokenDigest } from '#shared/ports/token-digest'

const DIGEST_ALGORITHM = 'sha256'
const DIGEST_ENCODING = 'hex'

/**
 * The digest that makes `token_hash` indexable. Read the port's comment before
 * changing this to anything with a salt.
 */
export class Sha256TokenDigest implements ITokenDigest {
  hash(value: string): string {
    return createHash(DIGEST_ALGORITHM).update(value).digest(DIGEST_ENCODING)
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passam**

Run: `pnpm test:unit -- random-token-generator sha256-token-digest`
Expected: PASS, 7 testes.

- [ ] **Step 6: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/shared/ports/token-generator.ts src/shared/ports/token-digest.ts \
        src/infra/providers/random-token-generator.ts \
        src/infra/providers/random-token-generator.spec.ts \
        src/infra/providers/sha256-token-digest.ts \
        src/infra/providers/sha256-token-digest.spec.ts
git commit -m "feat: mint opaque tokens, and index them without argon2"
```

---

## Task 2: A entidade `RefreshToken`

**Files:**
- Create: `src/modules/auth/entities/refresh-token.ts`
- Test: `src/modules/auth/entities/refresh-token.spec.ts`

**Interfaces:**
- Consumes: nada da Task 1 — a entidade é pura e não conhece porta.
- Produces:
  - `interface CreateRefreshTokenProps { id, userId, tokenHash, familyId, now: Date, ttlSeconds: number }`
  - `interface TrustedRefreshTokenProps { id, userId, tokenHash, familyId, expiresAt: Date, revokedAt: Date | null, replacedBy: string | null, createdAt: Date }`
  - `class RefreshToken` com `static create`, `static fromTrusted`,
    `isExpired(now)`, `isRevoked()`, `isWithinGraceWindow(now, graceWindowMs)`
    e getters `id`, `userId`, `tokenHash`, `familyId`, `expiresAt`,
    `revokedAt`, `replacedBy`, `createdAt`.

**Contexto que o executor precisa.** `isWithinGraceWindow` é o predicado mais
importante da fatia. Ele exige **duas** condições, e a segunda não é óbvia:
`replacedBy` precisa ser não-nulo. Um token revogado por **logout** não tem
`replacedBy`; sem essa guarda, um logout seguido de um refresh dentro de 30
segundos emitiria um par novo — logout que não desloga, e a janela de graça
vira um bypass da revogação explícita.

- [ ] **Step 1: Escrever o spec que falha**

Crie `src/modules/auth/entities/refresh-token.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'

const TOKEN_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const SUCCESSOR_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const TOKEN_HASH = 'a'.repeat(64)

const NOW = new Date('2026-08-31T12:00:00.000Z')
const TTL_SECONDS = 60
const GRACE_WINDOW_MS = 30_000
const ONE_MILLISECOND = 1

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

const active = () =>
  RefreshToken.create({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
  })

const revoked = (revokedAt: Date, replacedBy: string | null) =>
  RefreshToken.fromTrusted({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: at(TTL_SECONDS * 1000),
    revokedAt,
    replacedBy,
    createdAt: NOW,
  })

describe('RefreshToken.create', () => {
  it('derives expiresAt from the injected clock plus the TTL', () => {
    // Never `Date.now()`: R7, and without it neither the expiry test above nor
    // the grace window tests below could exist at all.
    expect(active().expiresAt).toEqual(at(TTL_SECONDS * 1000))
  })

  it('is born active and unreplaced', () => {
    const token = active()

    expect(token.revokedAt).toBeNull()
    expect(token.replacedBy).toBeNull()
    expect(token.isRevoked()).toBe(false)
  })
})

describe('RefreshToken.isExpired', () => {
  it('is not expired one millisecond before expiresAt', () => {
    expect(active().isExpired(at(TTL_SECONDS * 1000 - ONE_MILLISECOND))).toBe(false)
  })

  it('IS expired exactly at expiresAt', () => {
    // The boundary is inclusive on purpose: a token whose instant has arrived
    // is spent. Flipping this to `<` would keep it alive for one more tick,
    // which is the kind of off-by-one nobody ever notices.
    expect(active().isExpired(at(TTL_SECONDS * 1000))).toBe(true)
  })
})

describe('RefreshToken.isWithinGraceWindow', () => {
  it('accepts a rotation retry inside the window', () => {
    const token = revoked(NOW, SUCCESSOR_ID)

    expect(token.isWithinGraceWindow(at(GRACE_WINDOW_MS), GRACE_WINDOW_MS)).toBe(true)
  })

  it('refuses one millisecond past the window', () => {
    const token = revoked(NOW, SUCCESSOR_ID)

    expect(
      token.isWithinGraceWindow(at(GRACE_WINDOW_MS + ONE_MILLISECOND), GRACE_WINDOW_MS),
    ).toBe(false)
  })

  it('refuses a token revoked by LOGOUT, even inside the window', () => {
    // The guard of the whole slice. A logout leaves `replacedBy` null; without
    // this branch, logging out and refreshing within 30 seconds would hand back
    // a fresh pair, and the grace window would become a bypass of explicit
    // revocation.
    const loggedOut = revoked(NOW, null)

    expect(loggedOut.isWithinGraceWindow(at(ONE_MILLISECOND), GRACE_WINDOW_MS)).toBe(false)
  })

  it('refuses an active token', () => {
    expect(active().isWithinGraceWindow(NOW, GRACE_WINDOW_MS)).toBe(false)
  })
})

describe('RefreshToken immutability', () => {
  it('does not let a caller mutate its dates through a getter', () => {
    // `Object.freeze` is shallow: it locks the bindings, not the Date objects
    // they point at. Without cloning, this line would rewrite the entity.
    const token = active()

    token.expiresAt.setFullYear(1970)

    expect(token.expiresAt).toEqual(at(TTL_SECONDS * 1000))
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm test:unit -- refresh-token.spec`
Expected: FAIL — não resolve `#modules/auth/entities/refresh-token`.

- [ ] **Step 3: Escrever a entidade**

Crie `src/modules/auth/entities/refresh-token.ts`:

```ts
/**
 * `Object.freeze` is shallow: it locks the bindings on an instance, not the
 * internals of the objects they point at. Copying on the way in and on the way
 * out is what makes the immutability this class claims actually hold — the same
 * reasoning as in `user.ts`.
 */
function cloneDate(value: Date): Date {
  return new Date(value.getTime())
}

function cloneNullableDate(value: Date | null): Date | null {
  return value === null ? null : cloneDate(value)
}

const MILLISECONDS_PER_SECOND = 1000

export interface CreateRefreshTokenProps {
  id: string
  userId: string
  /** The digest, never the token itself. See `ITokenDigest`. */
  tokenHash: string
  /** The chain this token belongs to. A login starts a new one. */
  familyId: string
  /** Supplied by `IClock`, never by `new Date()` — R7. */
  now: Date
  ttlSeconds: number
}

/** The complete state of an already-persisted token. See `User.fromTrusted`. */
export interface TrustedRefreshTokenProps {
  id: string
  userId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
  replacedBy: string | null
  createdAt: Date
}

/**
 * One link in a rotating refresh chain (decision 11).
 *
 * State lives in `#` private fields, which are genuinely private and
 * non-enumerable at runtime: `JSON.stringify(token)` yields `{}`, so the digest
 * cannot escape through an accidental `reply.send(token)` or a stray
 * `log.info({ token })`.
 *
 * The plaintext token is NEVER here. It exists only in the response being
 * built; what survives is the digest.
 */
export class RefreshToken {
  readonly #id: string
  readonly #userId: string
  readonly #tokenHash: string
  readonly #familyId: string
  readonly #expiresAt: Date
  readonly #revokedAt: Date | null
  readonly #replacedBy: string | null
  readonly #createdAt: Date

  private constructor(props: TrustedRefreshTokenProps) {
    this.#id = props.id
    this.#userId = props.userId
    this.#tokenHash = props.tokenHash
    this.#familyId = props.familyId
    this.#expiresAt = cloneDate(props.expiresAt)
    this.#revokedAt = cloneNullableDate(props.revokedAt)
    this.#replacedBy = props.replacedBy
    this.#createdAt = cloneDate(props.createdAt)
    Object.freeze(this)
  }

  /**
   * Born active. `expiresAt` is derived from the injected clock rather than
   * from a column default: Postgres stores `timestamptz` in microseconds while
   * a JS `Date` has milliseconds, and the grace window compares instants — so
   * both sides of every comparison have to come from the same source
   * (decision 11).
   */
  static create(props: CreateRefreshTokenProps): RefreshToken {
    return new RefreshToken({
      id: props.id,
      userId: props.userId,
      tokenHash: props.tokenHash,
      familyId: props.familyId,
      // `new Date(millis)` is deterministic, so it is not the R7 hazard that
      // `new Date()` with no argument is.
      expiresAt: new Date(
        props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
      ),
      revokedAt: null,
      replacedBy: null,
      createdAt: props.now,
    })
  }

  /** Rehydrates a row. Validation is `create`'s job, on the way in. */
  static fromTrusted(props: TrustedRefreshTokenProps): RefreshToken {
    return new RefreshToken(props)
  }

  /** Inclusive at the boundary: an instant that has arrived is spent. */
  isExpired(now: Date): boolean {
    return this.#expiresAt.getTime() <= now.getTime()
  }

  isRevoked(): boolean {
    return this.#revokedAt !== null
  }

  /**
   * True when this token was revoked BY ROTATION and recently enough to be the
   * retry of a response that got lost — the mobile case decision 11 describes:
   * the phone sends the refresh, the server rotates and answers, the answer
   * dies in a tunnel, and the app retries with the token it still has.
   *
   * `replacedBy` is the load-bearing half. A token revoked by LOGOUT carries
   * none, and must never land here: handing it a fresh pair would make this
   * window a bypass of explicit revocation.
   */
  isWithinGraceWindow(now: Date, graceWindowMs: number): boolean {
    if (this.#revokedAt === null || this.#replacedBy === null) return false

    return now.getTime() - this.#revokedAt.getTime() <= graceWindowMs
  }

  get id(): string {
    return this.#id
  }

  get userId(): string {
    return this.#userId
  }

  get tokenHash(): string {
    return this.#tokenHash
  }

  get familyId(): string {
    return this.#familyId
  }

  get expiresAt(): Date {
    return cloneDate(this.#expiresAt)
  }

  get revokedAt(): Date | null {
    return cloneNullableDate(this.#revokedAt)
  }

  get replacedBy(): string | null {
    return this.#replacedBy
  }

  get createdAt(): Date {
    return cloneDate(this.#createdAt)
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm test:unit -- refresh-token.spec`
Expected: PASS, 9 testes.

- [ ] **Step 5: FALSIFICAR a guarda `replacedBy`**

Isto não é opcional. Troque temporariamente a primeira linha de
`isWithinGraceWindow` por:

```ts
    if (this.#revokedAt === null) return false
```

Run: `pnpm test:unit -- refresh-token.spec`
Expected: **FAIL**, exatamente em `refuses a token revoked by LOGOUT, even inside
the window`. Se passar, o teste não está provando nada — pare e conserte o teste
antes de seguir. Depois **restaure** a linha e confirme verde de novo.

- [ ] **Step 6: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test:unit
git add src/modules/auth/entities/refresh-token.ts \
        src/modules/auth/entities/refresh-token.spec.ts
git commit -m "feat: model the refresh token, and the window that forgives a lost response"
```

---

## Task 3: Schema, migration e o teste de schema

**Files:**
- Create: `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts`
- Create: `drizzle/<timestamp>_create_refresh_tokens_table/` (gerada)
- Test: `tests/integration/refresh-tokens-schema.spec.ts`

**Interfaces:**
- Consumes: `users` de `src/modules/auth/infra/drizzle/schema/users.ts`.
- Produces: `export const refreshTokens` (tabela Drizzle), com
  `$inferSelect` / `$inferInsert` usados pelo mapper da Task 4.

**Contexto que o executor precisa.** Postgres tem de estar de pé. **Nenhuma
coluna leva `defaultNow()` nem `defaultRandom()`**, ao contrário de `users`: a
janela de graça compara instantes, e um valor gravado pelo default do banco
chega truncado de microssegundos para milissegundos. Aqui não existe escrita
direta legítima — um refresh token nasce de uma rotação ou não nasce — então o
default seria só a assimetria, sem a defesa em profundidade que justifica os de
`users`.

- [ ] **Step 1: Escrever o schema**

Crie `src/modules/auth/infra/drizzle/schema/refresh-tokens.ts`:

```ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * One link in a rotating refresh chain (decision 11). This module owns the
 * table, and the foreign key to `users` is legal because both live inside
 * `auth` (decision 24).
 *
 * NO column defaults, unlike `users`. Postgres stores `timestamptz` in
 * microseconds while a JS `Date` has milliseconds, and the grace window
 * compares instants — so every timestamp here comes from `IClock`, and both
 * sides of every comparison share a source. `users` can afford defaults
 * because they are defence in depth for direct writes; a refresh token has no
 * legitimate direct write to defend.
 *
 * `replaced_by` carries NO foreign key on purpose. It is what separates
 * "revoked by rotation" from "revoked by logout" — diagnosis and state, not
 * referential integrity — and a self-reference would force the future pruning
 * job to delete a chain in order.
 */

/**
 * Exported because the repository reads it: a `23505` carrying THIS constraint
 * is not a database error, it is a security alarm — 32 bytes of `randomBytes`
 * do not collide, so what produces it in practice is a token generator that
 * regressed to something low-entropy, meaning issued tokens are predictable.
 *
 * The primary key raises `23505` too, and that one keeps bubbling as an
 * ordinary persistence failure: a repeated id means a broken `IIdGenerator`,
 * which is annoying rather than dangerous.
 *
 * The `CLAUDE.md` exception that lets schema files spell names inline justifies
 * itself by the name appearing exactly once. This one no longer does.
 */
export const REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX = 'refresh_tokens_token_hash_unique'

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the opaque token. Never the token itself. */
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex(REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX).on(table.tokenHash),
    // The WHERE of `revokeFamily` and `revokeAllForUser`. Without them each
    // revocation scans the table, on the hottest write path in the module.
    // Spelled inline because each appears exactly once — the constant above is
    // the one the repository reads back.
    index('refresh_tokens_family_id_idx').on(table.familyId),
    index('refresh_tokens_user_id_idx').on(table.userId),
  ],
)
```

- [ ] **Step 2: Gerar e aplicar a migration**

```bash
docker compose up -d
pnpm db:generate --name create_refresh_tokens_table
pnpm db:migrate
```

Abra o `migration.sql` gerado e **confirme com os olhos** que ele tem
`CREATE TABLE "refresh_tokens"`, a FK com `ON DELETE cascade`, o
`CREATE UNIQUE INDEX "refresh_tokens_token_hash_unique"` e os dois índices. R4:
migration é forward-only — se algo estiver errado, corrija o schema e gere
**outra**, nunca edite uma já aplicada.

- [ ] **Step 3: Escrever o teste de schema**

Crie `tests/integration/refresh-tokens-schema.spec.ts`:

```ts
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported from the schema: these values ARE the
// contract. Importing them would make the assertions tautological — renaming
// the index would break the database and still keep this suite green.
const TOKEN_HASH_UNIQUE_INDEX = 'refresh_tokens_token_hash_unique'
const FOREIGN_KEY_VIOLATION = '23503'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const TOKEN_HASH = 'a'.repeat(64)
const OTHER_TOKEN_HASH = 'b'.repeat(64)
const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000'
const TOKEN_ID = '6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
const OTHER_TOKEN_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'

const USER_MISSING_MESSAGE = 'no user row was stored'

let db: Database
let pool: Pool
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  // `refresh_tokens` goes first: the cascade would take it anyway, but deleting
  // in dependency order keeps this hook honest about what it is doing.
  await db.delete(refreshTokens)
  await db.delete(users)

  const [row] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning()

  if (row === undefined) throw new Error(USER_MISSING_MESSAGE)
  userId = row.id
})

const row = (overrides: Partial<typeof refreshTokens.$inferInsert> = {}) => ({
  id: TOKEN_ID,
  userId,
  tokenHash: TOKEN_HASH,
  familyId: FAMILY_ID,
  expiresAt: new Date('2026-12-31T00:00:00.000Z'),
  createdAt: new Date('2026-08-31T00:00:00.000Z'),
  ...overrides,
})

describe('refresh_tokens table', () => {
  it('rejects a duplicate token_hash, naming the unique index', async () => {
    await db.insert(refreshTokens).values(row())

    // Asserting on the constraint NAME, not just on "it threw": that is what
    // proves the rejection came from the token_hash index rather than from the
    // primary key, which raises 23505 as well. Drizzle's own message is the
    // failed query text; the driver error underneath — whose `constraint` field
    // names the violated index — is preserved as `cause`.
    await expect(
      db.insert(refreshTokens).values(row({ id: OTHER_TOKEN_ID })),
    ).rejects.toMatchObject({
      cause: { constraint: TOKEN_HASH_UNIQUE_INDEX },
    })
  })

  it('rejects a token pointing at a user that does not exist', async () => {
    await expect(
      db.insert(refreshTokens).values(row({ userId: UNKNOWN_USER_ID })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } })
  })

  it('deletes a user tokens along with the user', async () => {
    await db.insert(refreshTokens).values(row())

    await db.delete(users)

    expect(await db.select().from(refreshTokens)).toHaveLength(0)
  })

  it('stores revoked_at and replaced_by as nullable, and defaults neither', async () => {
    // The reserved seats of the state machine. If a default ever appears on
    // either, a freshly inserted token would read as already revoked or
    // already replaced, and the grace window would misfire on every rotation.
    await db.insert(refreshTokens).values(row())

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.revokedAt).toBeNull()
    expect(stored?.replacedBy).toBeNull()
  })

  it('accepts a second live token in the same family', async () => {
    // Not an accident: inside the grace window a family legitimately holds more
    // than one active token (spec §4.2). A unique index on family_id would be
    // wrong, and this test is what would catch someone adding one.
    await db.insert(refreshTokens).values(row())
    await db
      .insert(refreshTokens)
      .values(row({ id: OTHER_TOKEN_ID, tokenHash: OTHER_TOKEN_HASH }))

    expect(await db.select().from(refreshTokens)).toHaveLength(2)
  })
})
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm test:integration -- refresh-tokens-schema`
Expected: PASS, 5 testes.

Se falhar com *relation "refresh_tokens" does not exist*, o `globalSetup` do
projeto de integração migra o banco de teste (5433) — confirme que
`docker compose up -d` subiu os **dois** containers.

- [ ] **Step 5: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add src/modules/auth/infra/drizzle/schema/refresh-tokens.ts \
        tests/integration/refresh-tokens-schema.spec.ts drizzle/
git commit -m "feat: give refresh tokens a table, with the clock as its only source of time"
```

---

## Task 4: O repositório — contrato, adapter Drizzle e dublê

**Files:**
- Create: `src/modules/auth/repositories/refresh-tokens-repository.ts`
- Create: `src/modules/auth/infra/drizzle/refresh-token-mapper.ts`
- Create: `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts`
- Create: `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts`
- Modify: `src/modules/auth/repositories/unit-of-work.ts`
- Modify: `src/modules/auth/infra/drizzle/auth-repositories.ts`
- Test: `tests/integration/drizzle-refresh-tokens-repository.spec.ts`

**Interfaces:**
- Consumes: `RefreshToken` (Task 2), `refreshTokens` (Task 3), `Database` e
  `toPersistenceError` de `#infra/database/driver-error`.
- Produces:
  - `interface IRefreshTokensRepository` com `save`, `findByHashForUpdate`,
    `markRotated`, `revokeFamily`, `revokeAllForUser`
  - `class DrizzleRefreshTokensRepository`
  - `class RefreshTokenHashCollisionError extends Error`
  - `class InMemoryRefreshTokensRepository` (com o array público `tokens`)
  - `AuthRepos` passa a ser `{ users: IUsersRepository; refreshTokens: IRefreshTokensRepository }`
  - `const ROTATION_LOCK_TIMEOUT_MS = 1_000`
  - `const REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX` (da Task 3)

**Contexto que o executor precisa.** Duas coisas que só existem aqui:

`SET LOCAL lock_timeout` **não aceita parâmetro ligado** — o Postgres devolve
`42601 syntax error at or near "$1"`. Tem de ser `sql.raw`, e por isso o valor
nunca pode vir de request. Ele reverte sozinho no commit (medido), então é
seguro com pool.

`.for('update')` é o que faz a detecção de reuso existir. Sem ele, dois refreshes
simultâneos com o mesmo token leem os dois `revoked_at IS NULL`, rotacionam os
dois, e a detecção nunca dispara em lugar nenhum. O índice único não pega: os
dois sucessores têm hashes diferentes.

- [ ] **Step 1: Escrever o contrato e o dublê**

Crie `src/modules/auth/repositories/refresh-tokens-repository.ts`:

```ts
import type { RefreshToken } from '#modules/auth/entities/refresh-token'

/**
 * Commands rather than a mutable entity, and the reason is `revokeFamily`:
 * revoking a chain is ONE `UPDATE`, while "load every entity, revoke each, save
 * each" would be N reads and N writes for the same effect — slower, locking
 * more rows, and still able to miss a row inserted in between.
 */
export interface IRefreshTokensRepository {
  save(token: RefreshToken): Promise<void>

  /**
   * Finds by digest and LOCKS the row (`SELECT ... FOR UPDATE`).
   *
   * Only meaningful inside a transaction: outside one the lock is released at
   * the end of the statement, which is the same as no lock at all. The lock is
   * what makes reuse detection possible — without it two simultaneous refreshes
   * of the same token both read it as active and both rotate, and no reuse is
   * ever detected.
   */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>

  /** Revokes one token and points it at its successor, in a single write. */
  markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one chain. */
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one user, across every chain. */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>
}
```

Crie `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts`:

```ts
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'

/**
 * In-memory adapter, for the unit tests of the use cases (decision 09).
 *
 * It models NO row lock, because there is nothing to lock: a unit test runs one
 * call at a time. Concurrency is proved against real Postgres, in
 * `tests/integration/refresh-token.spec.ts` — treating this class as evidence
 * that the locking works would be exactly the mistake `FOR UPDATE` exists to
 * prevent.
 */
export class InMemoryRefreshTokensRepository implements IRefreshTokensRepository {
  readonly tokens: RefreshToken[] = []

  async save(token: RefreshToken): Promise<void> {
    this.tokens.push(token)
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    return this.tokens.find((token) => token.tokenHash === tokenHash) ?? null
  }

  async markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void> {
    this.#replace((token) => token.id === id, { replacedBy, revokedAt })
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    this.#replace(
      (token) => token.familyId === familyId && token.revokedAt === null,
      { revokedAt },
    )
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    this.#replace(
      (token) => token.userId === userId && token.revokedAt === null,
      { revokedAt },
    )
  }

  /** The entity is frozen, so "updating" means rebuilding it in place. */
  #replace(
    matches: (token: RefreshToken) => boolean,
    changes: { revokedAt: Date; replacedBy?: string },
  ): void {
    this.tokens.forEach((token, index) => {
      if (!matches(token)) return

      this.tokens[index] = RefreshToken.fromTrusted({
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        familyId: token.familyId,
        expiresAt: token.expiresAt,
        revokedAt: changes.revokedAt,
        replacedBy: changes.replacedBy ?? token.replacedBy,
        createdAt: token.createdAt,
      })
    })
  }
}
```

- [ ] **Step 2: Escrever o mapper e o adapter Drizzle**

Crie `src/modules/auth/infra/drizzle/refresh-token-mapper.ts`:

```ts
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { refreshTokens } from './schema/refresh-tokens.js'

type NewRefreshTokenRow = typeof refreshTokens.$inferInsert
type RefreshTokenRow = typeof refreshTokens.$inferSelect

/**
 * Entity to row. This file is the only place that knows both shapes — the pure
 * layer never learns what a row looks like (decision 20).
 */
export const toPersistenceRefreshToken = (
  token: RefreshToken,
): NewRefreshTokenRow => ({
  id: token.id,
  userId: token.userId,
  tokenHash: token.tokenHash,
  familyId: token.familyId,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  replacedBy: token.replacedBy,
  createdAt: token.createdAt,
})

/** Row to entity. Rehydrates rather than validates — see `RefreshToken.fromTrusted`. */
export const toDomainRefreshToken = (row: RefreshTokenRow): RefreshToken =>
  RefreshToken.fromTrusted({
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedBy: row.replacedBy,
    createdAt: row.createdAt,
  })
```

Crie `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts`:

```ts
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '#infra/database/client'
import { findDriverError, toPersistenceError } from '#infra/database/driver-error'
import type { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import { toDomainRefreshToken, toPersistenceRefreshToken } from './refresh-token-mapper.js'
import {
  REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX,
  refreshTokens,
} from './schema/refresh-tokens.js'

/** Every lookup here returns at most one row. */
const SINGLE_ROW = 1

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505'

const HASH_COLLISION_ERROR_NAME = 'RefreshTokenHashCollisionError'
const HASH_COLLISION_MESSAGE =
  'two refresh tokens produced the same sha256 digest: the opaque token ' +
  'generator has almost certainly regressed, and issued tokens may be predictable'

/**
 * Deliberately NOT an `AppError`, for the same reason `PersistenceError` and
 * `NestedTransactionError` are not: this is a defect, not one of the seven
 * semantic categories. It falls through to the error handler's generic branch
 * and answers 500 — which is what it is. And it carries no `code`, because in
 * this project `code` on an error is PUBLIC CONTRACT (decision 13), and there
 * is nothing a client could do with this one.
 *
 * What it adds over the `PersistenceError` this would otherwise become is not
 * data: that error already reaches the log carrying `code: '23505'` and the
 * constraint name, and a dropped connection carries neither, so the two are
 * already distinguishable. What it adds is the DIAGNOSIS — whoever is woken by
 * this should not have to work out from an index name that the entropy source
 * is broken.
 */
export class RefreshTokenHashCollisionError extends Error {
  constructor() {
    super(HASH_COLLISION_MESSAGE)
    this.name = HASH_COLLISION_ERROR_NAME
  }
}

/**
 * Matches the constraint NAME, not just the code: this table carries a second
 * unique constraint — its primary key — so an id collision raises `23505` as
 * well, and matching the code alone would report a broken `IIdGenerator` as a
 * compromised token generator. That one keeps bubbling as a `PersistenceError`:
 * a repeated UUID fails a request, it does not make a session guessable.
 */
function isTokenHashCollision(error: unknown): boolean {
  const driverError = findDriverError(error)

  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX
  )
}

/**
 * Deliberately shorter than the connection-wide 5s of the connection-limits
 * slice. This is the hottest single row in the system, and every legitimate
 * holder finishes in milliseconds; five seconds of waiting is pooled
 * connections standing still exactly when contention already says the pool is
 * under pressure. What blows this timeout is `55P03`, which the transaction
 * runner deliberately does NOT retry — the client gets a 503 and can come back.
 */
export const ROTATION_LOCK_TIMEOUT_MS = 1_000

export class DrizzleRefreshTokensRepository implements IRefreshTokensRepository {
  constructor(private readonly db: Database) {}

  async save(token: RefreshToken): Promise<void> {
    try {
      await this.db.insert(refreshTokens).values(toPersistenceRefreshToken(token))
    } catch (error) {
      // Named before the generic branch: this is the rarest and most suspicious
      // failure the module can produce, and it must not read as "the database
      // rejected a statement".
      if (isTokenHashCollision(error)) throw new RefreshTokenHashCollisionError()

      // Never re-throw what the driver gave us: Drizzle's error glues every
      // bound parameter into its own message, and this insert binds the digest
      // that IS the lookup key for a live session.
      throw toPersistenceError(error)
    }
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    // `sql.raw`, not a bound parameter: Postgres rejects `SET LOCAL x = $1`
    // with 42601 — SET takes no parameters. Safe only because the value is a
    // compile-time constant; never interpolate anything that came from a
    // request. `SET LOCAL` reverts at COMMIT, so the pooled connection goes
    // back with the connection-wide default intact (verified).
    await this.db.execute(
      sql`SET LOCAL lock_timeout = ${sql.raw(String(ROTATION_LOCK_TIMEOUT_MS))}`,
    )

    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(SINGLE_ROW)
      // The whole reuse detection rests on this. Without it, two simultaneous
      // refreshes of the same token both read it as active and both rotate.
      .for('update')

    return row === undefined ? null : toDomainRefreshToken(row)
  }

  async markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt, replacedBy })
      .where(eq(refreshTokens.id, id))
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      // `isNull` is not decoration: without it an already-revoked token would
      // have its `revokedAt` pushed forward, sliding the grace window of a
      // token that should already be dead.
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
  }
}
```

- [ ] **Step 3: Ligar ao Unit of Work**

Em `src/modules/auth/repositories/unit-of-work.ts`, substitua a interface
`AuthRepos` e o comentário que promete a fatia de refresh:

```ts
import type { IUnitOfWork } from '#shared/ports/unit-of-work'
import type { IRefreshTokensRepository } from './refresh-tokens-repository.js'
import type { IUsersRepository } from './users-repository.js'

/**
 * The module's repositories, every one bound to the SAME open transaction.
 *
 * `refreshTokens` is what the rotation writes twice in one transaction —
 * revoking the current token and inserting its successor — which is the case
 * decision 22 was written for.
 */
export interface AuthRepos {
  users: IUsersRepository
  refreshTokens: IRefreshTokensRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
```

Em `src/modules/auth/infra/drizzle/auth-repositories.ts`, acrescente o import e
a segunda entrada:

```ts
import { DrizzleRefreshTokensRepository } from './drizzle-refresh-tokens-repository.js'
```

```ts
export function authRepositories(db: Database): AuthRepos {
  return {
    users: new DrizzleUsersRepository(db),
    refreshTokens: new DrizzleRefreshTokensRepository(db),
  }
}
```

- [ ] **Step 4: Escrever o teste de integração do repositório**

Crie `tests/integration/drizzle-refresh-tokens-repository.spec.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { PersistenceError } from '#infra/database/driver-error'
import { createTransactionRunner } from '#infra/database/transaction-runner'
import { createUnitOfWork } from '#infra/database/unit-of-work'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { authRepositories } from '#modules/auth/infra/drizzle/auth-repositories'
import { RefreshTokenHashCollisionError } from '#modules/auth/infra/drizzle/drizzle-refresh-tokens-repository'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'

const EMAIL = 'joao@example.com'
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash'
const TTL_SECONDS = 3600
const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:00:05.000Z')

const FAMILY_A = '11112222-3333-4444-8555-666677778888'
const FAMILY_B = '99990000-1111-4222-8333-444455556666'
/** Deliberately given to two different tokens, to force the unique violation. */
const SHARED_HASH = 'c'.repeat(64)

const USER_MISSING_MESSAGE = 'no user row was stored'
const NO_WARNINGS = { warn: () => {} }

/** Comfortably under ROTATION_LOCK_TIMEOUT_MS, so the waiter waits rather than 55P03s. */
const HOLD_MS = 300
const CONTENTION_DELAY_MS = 100

let db: Database
let pool: Pool
let uow: IAuthUnitOfWork
let userId: string

beforeAll(() => {
  ;({ db, pool } = createDatabase(env))
  uow = createUnitOfWork(createTransactionRunner(db, NO_WARNINGS), authRepositories)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(users)

  const [row] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: PASSWORD_HASH })
    .returning()

  if (row === undefined) throw new Error(USER_MISSING_MESSAGE)
  userId = row.id
})

let sequence = 0
const nextId = () => {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

const token = (familyId: string, hash: string) =>
  RefreshToken.create({
    id: nextId(),
    userId,
    tokenHash: hash,
    familyId,
    now: NOW,
    ttlSeconds: TTL_SECONDS,
  })

describe('DrizzleRefreshTokensRepository', () => {
  it('round trips a token through save and findByHashForUpdate', async () => {
    const saved = token(FAMILY_A, 'a'.repeat(64))

    const found = await uow(async ({ refreshTokens: repo }) => {
      await repo.save(saved)
      return repo.findByHashForUpdate(saved.tokenHash)
    })

    expect(found?.id).toBe(saved.id)
    expect(found?.familyId).toBe(FAMILY_A)
    expect(found?.expiresAt).toEqual(saved.expiresAt)
    expect(found?.revokedAt).toBeNull()
    expect(found?.replacedBy).toBeNull()
  })

  it('returns null for a hash it has never seen', async () => {
    const found = await uow(({ refreshTokens: repo }) =>
      repo.findByHashForUpdate('f'.repeat(64)),
    )

    expect(found).toBeNull()
  })

  it('markRotated sets both revokedAt and replacedBy in one write', async () => {
    const current = token(FAMILY_A, 'a'.repeat(64))
    const successor = token(FAMILY_A, 'b'.repeat(64))

    const rotated = await uow(async ({ refreshTokens: repo }) => {
      await repo.save(current)
      await repo.save(successor)
      await repo.markRotated(current.id, successor.id, LATER)
      return repo.findByHashForUpdate(current.tokenHash)
    })

    expect(rotated?.revokedAt).toEqual(LATER)
    expect(rotated?.replacedBy).toBe(successor.id)
  })

  it('revokeFamily revokes the whole chain and leaves another chain alone', async () => {
    const mine = token(FAMILY_A, 'a'.repeat(64))
    const alsoMine = token(FAMILY_A, 'b'.repeat(64))
    const other = token(FAMILY_B, 'c'.repeat(64))

    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(mine)
      await repo.save(alsoMine)
      await repo.save(other)
      await repo.revokeFamily(FAMILY_A, LATER)
    })

    const stored = await db.select().from(refreshTokens)
    const revoked = stored.filter((row) => row.revokedAt !== null)

    expect(revoked).toHaveLength(2)
    expect(stored.find((row) => row.familyId === FAMILY_B)?.revokedAt).toBeNull()
  })

  it('revokeFamily does NOT push an already-revoked token forward', async () => {
    // Sliding `revokedAt` would slide the grace window with it, keeping a token
    // that should already be dead alive for another 30 seconds every time the
    // family is revoked again.
    const current = token(FAMILY_A, 'a'.repeat(64))

    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(current)
      await repo.revokeFamily(FAMILY_A, NOW)
      await repo.revokeFamily(FAMILY_A, LATER)
    })

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.revokedAt).toEqual(NOW)
  })

  it('names a token_hash collision instead of burying it in a generic failure', async () => {
    // Unreachable with 32 bytes of randomBytes, and that is exactly the point:
    // what produces this in practice is a generator that regressed, which means
    // issued tokens are predictable. A security incident, not a database error.
    const first = token(FAMILY_A, SHARED_HASH)
    const colliding = token(FAMILY_A, SHARED_HASH)

    await expect(
      uow(async ({ refreshTokens: repo }) => {
        await repo.save(first)
        await repo.save(colliding)
      }),
    ).rejects.toBeInstanceOf(RefreshTokenHashCollisionError)
  })

  it('lets an id collision bubble as an ordinary persistence failure', async () => {
    // The primary key raises 23505 too. Matching the CODE alone would report a
    // broken IIdGenerator as a compromised token generator — this is the test
    // that keeps the two apart.
    const first = token(FAMILY_A, 'a'.repeat(64))
    const sameId = RefreshToken.create({
      id: first.id,
      userId,
      tokenHash: 'b'.repeat(64),
      familyId: FAMILY_A,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    })

    const failure = uow(async ({ refreshTokens: repo }) => {
      await repo.save(first)
      await repo.save(sameId)
    })

    await expect(failure).rejects.toBeInstanceOf(PersistenceError)
    await expect(failure).rejects.not.toBeInstanceOf(RefreshTokenHashCollisionError)
  })

  it('makes a second reader WAIT for the first transaction to commit', async () => {
    // THE test that defends `.for('update')`, and it lives here rather than in
    // the HTTP suite for a reason worth knowing: end to end, the lock is
    // invisible. With the grace window on, the rotation branch and the grace
    // branch produce the same visible answer — 200, new pair, same family — so
    // two simultaneous refreshes look identical with and without the lock. Only
    // at this level is the difference observable: without it, the second read
    // returns the stale row immediately.
    const current = token(FAMILY_A, 'a'.repeat(64))
    const successor = token(FAMILY_A, 'b'.repeat(64))
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(current)
      await repo.save(successor)
    })

    const first = uow(async ({ refreshTokens: repo }) => {
      await repo.findByHashForUpdate(current.tokenHash)
      await repo.markRotated(current.id, successor.id, LATER)
      // Hold the lock, but well under the 1s `ROTATION_LOCK_TIMEOUT_MS` the
      // repository sets — going over it would fail the waiter with 55P03
      // instead of making it wait.
      await sleep(HOLD_MS)
    })

    await sleep(CONTENTION_DELAY_MS)
    const seen = await uow(({ refreshTokens: repo }) =>
      repo.findByHashForUpdate(current.tokenHash),
    )
    await first

    expect(seen?.revokedAt).toEqual(LATER)
    expect(seen?.replacedBy).toBe(successor.id)
  })

  it('revokeAllForUser revokes across every family of that user', async () => {
    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, 'a'.repeat(64)))
      await repo.save(token(FAMILY_B, 'b'.repeat(64)))
      await repo.revokeAllForUser(userId, LATER)
    })

    const stored = await db.select().from(refreshTokens)

    expect(stored.every((row) => row.revokedAt !== null)).toBe(true)
  })
})
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm test:integration -- drizzle-refresh-tokens-repository`
Expected: PASS, 9 testes.

- [ ] **Step 6: FALSIFICAR o `FOR UPDATE` — obrigatório**

O passo mais importante do plano. **Remova** temporariamente a linha
`.for('update')` de `findByHashForUpdate`.

Run: `pnpm test:integration -- drizzle-refresh-tokens-repository`
Expected: **FAIL** em `makes a second reader WAIT for the first transaction to
commit` — sem o lock a segunda leitura volta na hora com `revokedAt: null`.

Se ele **passar** sem o lock, pare: o teste não está exercendo a corrida.
Aumente `HOLD_MS` e confirme que a segunda leitura realmente acontece durante a
janela em que a primeira transação está aberta. Só então restaure
`.for('update')` e confirme verde.

- [ ] **Step 7: FALSIFICAR o `IS NULL` do `revokeFamily`**

Remova `isNull(refreshTokens.revokedAt)` do `WHERE` de `revokeFamily`.
Expected: **FAIL** em `revokeFamily does NOT push an already-revoked token
forward` — e o defeito real que isso representa é a janela de graça deslizando a
cada revogação. Restaure.

- [ ] **Step 8: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add src/modules/auth/repositories/refresh-tokens-repository.ts \
        src/modules/auth/repositories/unit-of-work.ts \
        src/modules/auth/infra/drizzle/refresh-token-mapper.ts \
        src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts \
        src/modules/auth/infra/drizzle/auth-repositories.ts \
        src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts \
        tests/integration/drizzle-refresh-tokens-repository.spec.ts
git commit -m "feat: persist refresh tokens, and lock the row the rotation turns on"
```

---

## Task 5: Config, o issuer, e o login passando a emitir o par

**Files:**
- Modify: `src/modules/auth/config.ts`
- Modify: `src/infra/config/fixtures/test-env.ts`
- Modify: `.env.example`
- Create: `src/modules/auth/services/refresh-token-issuer.ts`
- Modify: `src/modules/auth/use-cases/login-user.ts`
- Modify: `src/modules/auth/use-cases/login-user.spec.ts`
- Modify: `src/modules/auth/container.ts`
- Modify: `src/modules/auth/infra/http/endpoints/login.ts`
- Modify: `tests/integration/login.spec.ts`

**Interfaces:**
- Consumes: `ITokenGenerator`, `ITokenDigest` (Task 1), `RefreshToken` (Task 2),
  `IRefreshTokensRepository` e `InMemoryRefreshTokensRepository` (Task 4).
- Produces:
  - `const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 5_184_000`
  - `const DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS = 30`
  - `interface IssuedRefreshToken { token: string; entity: RefreshToken }`
  - `class RefreshTokenIssuer` com
    `issue(userId: string, familyId: string, now: Date): IssuedRefreshToken` e
    `newFamilyId(): string`
  - `LoginUserResult` passa a ser `{ accessToken: string; refreshToken: string }`
  - `container.refreshTokenTtlSeconds: number`

**Contexto que o executor precisa.** O `login` **não** recebe o `uow` e **não**
declara 503, e isso é deliberado: ele escreve num repositório só, e faz argon2
(~100ms). O §8 da spec do Unit of Work proíbe CPU pesada dentro da transação —
um hash de 100ms com a transação aberta é um cabo do pool parado.

O `RefreshTokenIssuer` existe para o construtor não explodir: sem ele o
`LoginUserUseCase` receberia nove colaboradores. Ele é **puro** e mora numa
pasta nova, `services/`.

- [ ] **Step 1: Escrever o issuer e as variáveis de config**

Crie `src/modules/auth/services/refresh-token-issuer.ts`:

```ts
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import type { IIdGenerator } from '#shared/ports/id-generator'
import type { ITokenDigest } from '#shared/ports/token-digest'
import type { ITokenGenerator } from '#shared/ports/token-generator'

/**
 * The plaintext token and the row that remembers it. The plaintext exists only
 * long enough to reach the client — nothing persists it, and the server can
 * never reproduce it, which is why the grace window issues a NEW pair instead
 * of replaying the old one (decision 11).
 */
export interface IssuedRefreshToken {
  token: string
  entity: RefreshToken
}

/**
 * Mints one link of a refresh chain. A domain service rather than a method on
 * the entity: the entity must not know about ports, and this operation is the
 * same in `login` and in both branches of the rotation — inlining it three
 * times is how one of them ends up hashing with the wrong digest.
 */
export class RefreshTokenIssuer {
  constructor(
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly idGenerator: IIdGenerator,
    private readonly ttlSeconds: number,
  ) {}

  issue(userId: string, familyId: string, now: Date): IssuedRefreshToken {
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
      }),
    }
  }

  /** A login starts a new chain, so revoking one device never touches another. */
  newFamilyId(): string {
    return this.idGenerator.generate()
  }
}
```

Em `src/modules/auth/config.ts`, acrescente as constantes e as duas entradas do
schema:

```ts
/** 60 days — decision 11. Sliding: every rotation issues a fresh window. */
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 5_184_000

/**
 * 30 seconds — decision 11. The window in which a refresh that has already been
 * rotated is still accepted, because the response carrying its successor may
 * have died in a tunnel. Without it, rotation in a mobile app produces random
 * logouts.
 */
export const DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS = 30
```

```ts
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_TTL_SECONDS),
  // `.positive()` and not `.nonnegative()`: a grace window of zero brings back
  // the random logout the window exists to remove, and rejecting zero is also
  // what rejects an empty value — exactly as for `PORT`.
  REFRESH_TOKEN_GRACE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_GRACE_WINDOW_SECONDS),
```

Em `src/infra/config/fixtures/test-env.ts`, importe as duas constantes de
`#modules/auth/config` e acrescente-as ao objeto — **pelas constantes, nunca por
literal**, para que um default alterado não deixe a fixture para trás.

Em `.env.example`, acrescente:

```
# Refresh token (decision 11). Seconds, both of them.
REFRESH_TOKEN_TTL_SECONDS=5184000
REFRESH_TOKEN_GRACE_WINDOW_SECONDS=30
```

- [ ] **Step 2: Escrever os testes que falham no login**

Em `src/modules/auth/use-cases/login-user.spec.ts`, acrescente ao `beforeEach` o
repositório de refresh, o issuer e o clock, e junte estes casos:

```ts
  it('issues a refresh token alongside the access token', async () => {
    const result = await useCase.execute({ email: EMAIL, password: PASSWORD })

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken).toEqual(expect.any(String))
    expect(result.refreshToken.length).toBeGreaterThan(0)
  })

  it('persists the DIGEST of the refresh token, never the token itself', async () => {
    // The single most important assertion in this file. A stored plaintext
    // token is a stored password.
    const { refreshToken } = await useCase.execute({ email: EMAIL, password: PASSWORD })

    const [stored] = refreshTokensRepository.tokens

    expect(stored?.tokenHash).toBe(digestOf(refreshToken))
    expect(stored?.tokenHash).not.toBe(refreshToken)
  })

  it('starts a NEW family on every login', async () => {
    // One chain per device. Sharing a family would make logging out on the
    // phone log the tablet out too.
    await useCase.execute({ email: EMAIL, password: PASSWORD })
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    const [first, second] = refreshTokensRepository.tokens

    expect(first?.familyId).not.toBe(second?.familyId)
  })

  it('takes expiresAt from the injected clock, not from the wall clock', async () => {
    await useCase.execute({ email: EMAIL, password: PASSWORD })

    const [stored] = refreshTokensRepository.tokens

    expect(stored?.expiresAt).toEqual(
      new Date(NOW.getTime() + REFRESH_TTL_SECONDS * 1000),
    )
  })

  it('stores no refresh token when the credentials are wrong', async () => {
    await expect(
      useCase.execute({ email: EMAIL, password: WRONG_PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(refreshTokensRepository.tokens).toHaveLength(0)
  })
```

O `beforeEach` precisa dos dublês novos — acrescente antes da construção do use
case, junto das constantes `REFRESH_TTL_SECONDS = 60` e
`digestOf = (v: string) => \`digest:${v}\``:

```ts
  refreshTokensRepository = new InMemoryRefreshTokensRepository()
  let generated = 0
  const issuer = new RefreshTokenIssuer(
    { opaque: () => `opaque-${(generated += 1)}` },
    { hash: digestOf },
    { generate: () => `id-${(generated += 1)}` },
    REFRESH_TTL_SECONDS,
  )
  useCase = new LoginUserUseCase(
    usersRepository,
    hashProvider,
    tokenSigner,
    refreshTokensRepository,
    issuer,
    { now: () => NOW },
  )
```

- [ ] **Step 3: Rodar e confirmar que falham**

Run: `pnpm test:unit -- login-user`
Expected: FAIL — o construtor de `LoginUserUseCase` ainda recebe três
argumentos, e `result.refreshToken` não existe.

- [ ] **Step 4: Fazer o login emitir o par**

Substitua `src/modules/auth/use-cases/login-user.ts` inteiro:

```ts
import { InvalidCredentialsError } from '#modules/auth/errors/invalid-credentials-error'
import type { IHashProvider } from '#modules/auth/ports/hash-provider'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IUsersRepository } from '#modules/auth/repositories/users-repository'
import type { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { Email } from '#modules/auth/value-objects/email'
import type { IClock } from '#shared/ports/clock'

/** Raw, untrusted input. */
export interface LoginUserCommand {
  email: string
  password: string
}

export interface LoginUserResult {
  accessToken: string
  refreshToken: string
}

/**
 * Authenticates by email and password, issuing a short-lived access token and
 * the opaque refresh token that carries the session (decision 11).
 *
 * Takes the refresh repository DIRECTLY and not the unit of work, and that is
 * deliberate on both counts: it writes to one repository, so there is no
 * atomicity to protect — and it runs argon2, which §8 of the unit of work
 * design forbids inside a transaction, because a 100ms hash with the
 * transaction open is a pooled connection standing still.
 *
 * Does not check `emailVerifiedAt`: nothing can verify an email yet, so the
 * gate would lock every account out. It arrives with the verification path.
 */
export class LoginUserUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
    private readonly refreshTokensRepository: IRefreshTokensRepository,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly clock: IClock,
  ) {}

  async execute(command: LoginUserCommand): Promise<LoginUserResult> {
    const email = Email.create(command.email)
    const user = await this.usersRepository.findByEmail(email)

    // Always compares, decoy included, so a missing account and a wrong
    // password cost the same. Returning early here would let the response time
    // answer "does this account exist?".
    const hashed = user?.passwordHash ?? this.hashProvider.dummyHash
    const matches = await this.hashProvider.compare(command.password, hashed)

    // One `throw`, not two branches: separate branches start identical and
    // drift apart at the first maintenance — one gains a log, the other a
    // message — and the oracle comes back.
    if (user === null || !matches) throw new InvalidCredentialsError()

    // A fresh family per login: each device owns its chain, so logging out on
    // the phone leaves the tablet signed in.
    const issued = this.refreshTokenIssuer.issue(
      user.id,
      this.refreshTokenIssuer.newFamilyId(),
      this.clock.now(),
    )

    await this.refreshTokensRepository.save(issued.entity)

    return {
      accessToken: await this.tokenSigner.sign({ sub: user.id }),
      refreshToken: issued.token,
    }
  }
}
```

- [ ] **Step 5: Atualizar o container**

Em `src/modules/auth/container.ts`, dentro de `makeAuthContainer`, acrescente os
providers e o issuer, desestruture o segundo repositório, e passe os novos
argumentos ao `LoginUserUseCase`:

```ts
  const { users: usersRepository, refreshTokens: refreshTokensRepository } =
    authRepositories(db)
  const tokenGenerator = new RandomTokenGenerator()
  const tokenDigest = new Sha256TokenDigest()
  const refreshTokenIssuer = new RefreshTokenIssuer(
    tokenGenerator,
    tokenDigest,
    idGenerator,
    config.REFRESH_TOKEN_TTL_SECONDS,
  )
```

```ts
    loginUser: new LoginUserUseCase(
      usersRepository,
      hashProvider,
      tokenSigner,
      refreshTokensRepository,
      refreshTokenIssuer,
      clock,
    ),
```

E publique o TTL, que o endpoint precisa para o `Max-Age` do cookie na Task 6:

```ts
    /**
     * Published because the cookie's `Max-Age` has to match the token's own
     * lifetime, and the endpoint is where the cookie is written. One source for
     * both, so they cannot drift.
     */
    refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
```

Atualize também o comentário do `uow`, que hoje diz "Published with no consumer
yet" — a rotação chega na Task 7, e o `unit-of-work.spec.ts` já o consome.

- [ ] **Step 6: Devolver o par no endpoint**

Em `src/modules/auth/infra/http/endpoints/login.ts`, troque o `okSchema` e o
handler:

```ts
const okSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
})
```

```ts
    async (request, reply) => {
      const tokens = await container.loginUser.execute(request.body)

      return reply.status(OK_STATUS).send(tokens)
    },
```

- [ ] **Step 7: Rodar tudo**

Run: `pnpm test:unit -- login-user` → PASS
Run: `pnpm test:integration -- login` → PASS

Em `tests/integration/login.spec.ts`, acrescente ao caso do caminho feliz:

```ts
  it('answers 200 with both tokens for valid credentials', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    // Opaque, so deliberately NOT a JWT: a refresh token that parses as a JWT
    // is the discarded stateless option sneaking back in.
    expect(response.json().refreshToken).toEqual(expect.any(String))
    expect(response.json().refreshToken).not.toMatch(JWT_PATTERN)
  })

  it('stores only the digest of the refresh token', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    const [stored] = await db.select().from(refreshTokens)

    expect(stored?.tokenHash).not.toBe(response.json().refreshToken)
    expect(response.body).not.toContain(stored?.tokenHash)
  })
```

Acrescente `refreshTokens` ao import e ao `beforeEach` de limpeza — **antes** do
`db.delete(users)`.

- [ ] **Step 8: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat: hand out a refresh token at login, and keep only its digest"
```

---

## Task 6: O cookie, e o campo que escolhe o transporte

**Files:**
- Modify: `src/main/app.ts`
- Create: `src/modules/auth/infra/http/refresh-cookie.ts`
- Modify: `src/modules/auth/infra/http/endpoints/login.ts`
- Modify: `tests/integration/login.spec.ts`

**Interfaces:**
- Consumes: `container.refreshTokenTtlSeconds` (Task 5).
- Produces:
  - `const REFRESH_COOKIE_NAME = 'refresh_token'`
  - `function readRefreshCookie(request): string | undefined`
  - `function setRefreshCookie(reply, token: string, maxAgeSeconds: number): void`
  - `function clearRefreshCookie(reply): void`
  - `const refreshTransportSchema` — `z.enum(['body', 'cookie']).default('body')`
  - `const REFRESH_TRANSPORT_COOKIE = 'cookie'`

**Contexto que o executor precisa.** Três achados verificados que mudam o código:

1. **`Path=/auth`, não `/auth/refresh`.** A decisão 12 escreveu o path estreito
   antes de o logout existir; com ele, o browser nunca manda o cookie para
   `/auth/logout` e o logout por cookie fica impossível. Esta é uma **emenda**, e
   está registrada no §6.2 da spec.
2. **`clearCookie` NÃO herda os atributos do `setCookie`** — com só `{ path }`
   sai `SameSite=Lax`, sem `HttpOnly` e sem `Secure`. Passe o conjunto completo.
3. **A ordem de registro do `@fastify/cookie` não importa** (verificado
   registrando-o depois das rotas). Registre junto da infra global mesmo assim,
   por legibilidade — mas não é a armadilha `onRoute` do swagger.

- [ ] **Step 1: Registrar o plugin**

Em `src/main/app.ts`, acrescente o import e o registro logo antes do
`registerOpenApi`:

```ts
import fastifyCookie from '@fastify/cookie'
```

```ts
  // Global infra: the auth module never registers a transport plugin of its
  // own. Unlike `registerOpenApi` below, the position is not load-bearing —
  // `@fastify/cookie` decorates the request and does not hook `onRoute` —
  // but it belongs with the rest of the global setup.
  await app.register(fastifyCookie)
```

- [ ] **Step 2: Escrever o módulo do cookie**

Crie `src/modules/auth/infra/http/refresh-cookie.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

export const REFRESH_COOKIE_NAME = 'refresh_token'

/**
 * `/auth`, and NOT the `/auth/refresh` decision 12 wrote.
 *
 * A browser sends a cookie only to paths at or below `Path`, so the narrower
 * value never reaches `POST /auth/logout` — which would make cookie-mode logout
 * unimplementable. The cost is the cookie also travelling to `/auth/login` and
 * `/auth/register`, which ignore it; it stays HttpOnly, Secure and
 * SameSite=Strict throughout, and `headers.cookie` is already redacted from the
 * logs.
 */
const REFRESH_COOKIE_PATH = '/auth'

export const REFRESH_TRANSPORT_BODY = 'body'
export const REFRESH_TRANSPORT_COOKIE = 'cookie'

/**
 * Which channel carries the refresh token back. Only `login` needs it: every
 * other endpoint learns the channel from the request that arrived.
 *
 * Not the market default — Firebase, Supabase, Cognito and Auth0 all answer in
 * the body and leave cookies to a BFF. Decision 12 deliberately puts the cookie
 * in the API itself so one surface serves both clients, and process-level
 * configuration cannot decide it, because both clients hit the same process.
 */
export const refreshTransportSchema = z
  .enum([REFRESH_TRANSPORT_BODY, REFRESH_TRANSPORT_COOKIE])
  .default(REFRESH_TRANSPORT_BODY)

/**
 * `Secure` is on in EVERY environment, development included, and deliberately
 * not keyed on `NODE_ENV`: that variable carries `.default('development')` in
 * `env.ts`, so a deploy that forgets to set it would ship this cookie without
 * `Secure` — in silence. A security attribute that fails open on a missing
 * variable is the wrong trade at any price.
 *
 * **The price, and it is measured, not feared. Safari refuses a `Secure`
 * cookie even on `http://localhost`.** Probed 2026-09-01 with exactly these
 * attributes, against a pair of cookies differing only by `Secure`:
 *
 * | Client | Origin | `Secure` | Control |
 * |---|---|---|---|
 * | Safari, macOS | `http://localhost` | REFUSED | stored |
 * | Safari, iOS 18.7 | `http://192.168.x.x` | REFUSED | stored |
 * | Chrome, Linux | `http://localhost` | accepted | stored |
 * | Firefox 154, Linux | `http://localhost` | accepted | stored |
 *
 * So it is WebKit specifically, not "HTTP", that refuses: both Gecko and Blink
 * accept the same cookie at the same origin.
 *
 * The control coming back everywhere is what makes the attribution clean: it
 * carries `SameSite=Strict`, `Path=/auth` and `HttpOnly`, so those three are
 * fine in WebKit and only `Secure` is refused.
 *
 * So cookie mode cannot be exercised from Safari in development — `/docs` is
 * development-only and served over `http://localhost`. Use a Chromium browser,
 * or terminate TLS in front of the API. Testing from a real device over a LAN
 * IP fails the same way in EVERY browser, since a bare LAN address is never a
 * trustworthy origin.
 *
 * The failure is silent in both cases: nothing is stored, nothing is warned,
 * and the next refresh answers 401 exactly as if no one had logged in.
 *
 * Production is unaffected (HTTPS), and so is mobile — a native client never
 * asks for this cookie (decision 12); it takes the token in the body and stores
 * it in the Keychain or Keystore.
 */
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
} as const

export function readRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE_NAME]
}

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    ...cookieOptions,
    maxAge: maxAgeSeconds,
  })
}

export function clearRefreshCookie(reply: FastifyReply): void {
  // The full attribute set, not just the path: `clearCookie` does NOT inherit
  // what `setCookie` used, and passing only the path emits SameSite=Lax with no
  // HttpOnly and no Secure (verified). Deletion works either way — browsers
  // match on name, domain and path — but emitting a weaker cookie is noise
  // nobody wants to explain later.
  reply.clearCookie(REFRESH_COOKIE_NAME, cookieOptions)
}
```

- [ ] **Step 3: Escrever os testes que falham**

Em `tests/integration/login.spec.ts`, acrescente:

```ts
const REFRESH_COOKIE_NAME = 'refresh_token'

  it('sends the refresh token as a cookie, and NOT in the body, when asked', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: 'cookie',
    })

    expect(response.statusCode).toBe(OK_STATUS_CODE)
    expect(response.json().accessToken).toMatch(JWT_PATTERN)
    // The whole point of the cookie: if the token is ALSO in the body, the SPA's
    // JavaScript can read it, and HttpOnly has bought nothing.
    expect(response.json().refreshToken).toBeUndefined()
  })

  it('sets the cookie with every attribute decision 12 requires', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: 'cookie',
    })

    const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)

    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.secure).toBe(true)
    expect(cookie?.sameSite).toBe('Strict')
    // `/auth` and not `/auth/refresh`: the amendment that makes cookie-mode
    // logout possible at all.
    expect(cookie?.path).toBe('/auth')
    expect(cookie?.maxAge).toBe(REFRESH_TOKEN_TTL_SECONDS)
  })

  it('defaults to the body when the field is absent', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD })

    expect(response.json().refreshToken).toEqual(expect.any(String))
    expect(response.cookies).toHaveLength(0)
  })

  it('answers 400 for an unknown transport', async () => {
    const response = await login({
      email: EMAIL,
      password: PASSWORD,
      refreshTransport: 'carrier-pigeon',
    })

    expect(response.statusCode).toBe(BAD_REQUEST_STATUS_CODE)
  })
```

Importe `DEFAULT_REFRESH_TOKEN_TTL_SECONDS as REFRESH_TOKEN_TTL_SECONDS` de
`#modules/auth/config`.

- [ ] **Step 4: Rodar e confirmar que falham**

Run: `pnpm test:integration -- login`
Expected: FAIL — `refreshToken` continua vindo no body, e nenhum cookie é setado.

- [ ] **Step 5: Ligar o transporte no endpoint**

Em `src/modules/auth/infra/http/endpoints/login.ts`: acrescente
`refreshTransport: refreshTransportSchema` ao `bodySchema`, torne `refreshToken`
opcional no `okSchema`, e troque o handler:

```ts
const okSchema = z.object({
  accessToken: z.string(),
  /**
   * Absent in cookie mode. Optional and not two schemas because the serializer
   * validates the body against whatever this status declares — and the §7
   * warning of `ARCHITECTURE.md` is that a shape it cannot serialize answers
   * 500 instead of the intended status.
   */
  refreshToken: z.string().optional(),
})
```

```ts
    async (request, reply) => {
      const { accessToken, refreshToken } = await container.loginUser.execute(
        request.body,
      )

      if (request.body.refreshTransport === REFRESH_TRANSPORT_COOKIE) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
```

`LoginUserCommand` tem `email` e `password`; `request.body` traz `refreshTransport`
a mais, o que o TypeScript aceita porque a passagem não é um literal de objeto.

- [ ] **Step 6: Rodar e confirmar que passam**

Run: `pnpm test:integration -- login`
Expected: PASS.

- [ ] **Step 7: FALSIFICAR o teste do cookie**

Troque temporariamente `httpOnly: true` por `httpOnly: false` em
`cookieOptions`.
Run: `pnpm test:integration -- login`
Expected: **FAIL** em `sets the cookie with every attribute decision 12
requires`. Restaure e confirme verde.

- [ ] **Step 8: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat: carry the refresh token in a cookie when the client asks for one"
```

---

## Task 7: A rotação

**Files:**
- Create: `src/modules/auth/errors/invalid-refresh-token-error.ts`
- Create: `src/modules/auth/errors/refresh-token-reused-error.ts`
- Create: `src/modules/auth/use-cases/refresh-token.ts`
- Test: `src/modules/auth/use-cases/refresh-token.spec.ts`
- Modify: `src/modules/auth/container.ts`

**Interfaces:**
- Consumes: `IAuthUnitOfWork` (Task 4), `RefreshTokenIssuer` (Task 5),
  `ITokenDigest` (Task 1), `ITokenSigner`, `IClock`.
- Produces:
  - `class InvalidRefreshTokenError extends UnauthorizedError` — code `INVALID_REFRESH_TOKEN`
  - `class RefreshTokenReusedError extends UnauthorizedError` — code `REFRESH_TOKEN_REUSED`
  - `interface RefreshTokenCommand { refreshToken: string }`
  - `interface RefreshTokenResult { accessToken: string; refreshToken: string }`
  - `class RefreshTokenUseCase` com
    `execute(command: RefreshTokenCommand): Promise<RefreshTokenResult>`
  - `container.refreshToken`

**Contexto que o executor precisa.** É o coração da fatia. Três regras que o
código tem de honrar e que quebram em silêncio se invertidas:

**A ordem é normativa: revogado ANTES de expirado.** Um cliente que rotaciona um
segundo antes de `expiresAt` e perde a resposta chega com um token revogado *e*
expirado; checando expiração primeiro ele leva 401 — o logout aleatório que a
janela existe para eliminar.

**O use case recebe o `uow` e NENHUM repositório direto.** Um
`this.refreshTokensRepository.save(...)` dentro do callback compila, passa no
teste unitário, e escreve fora da transação em produção.

**`now` é calculado UMA vez, fora do callback.** O runner pode reexecutar o
callback num retry de deadlock; um `clock.now()` lá dentro daria instantes
diferentes por tentativa.

- [ ] **Step 1: Escrever os erros**

Crie `src/modules/auth/errors/invalid-refresh-token-error.ts`:

```ts
import { UnauthorizedError } from '#shared/errors/app-error'

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN'
const INVALID_REFRESH_TOKEN_MESSAGE = 'Invalid or expired refresh token'

/**
 * The answer to a token that is unknown, expired, or absent. Says nothing about
 * which: a client that knows what it sent gains nothing from the distinction,
 * and an attacker probing values would.
 */
export class InvalidRefreshTokenError extends UnauthorizedError {
  readonly code = INVALID_REFRESH_TOKEN_CODE

  constructor() {
    super(INVALID_REFRESH_TOKEN_MESSAGE)
  }
}
```

Crie `src/modules/auth/errors/refresh-token-reused-error.ts`:

```ts
import { UnauthorizedError } from '#shared/errors/app-error'

const REFRESH_TOKEN_REUSED_CODE = 'REFRESH_TOKEN_REUSED'
const REFRESH_TOKEN_REUSED_MESSAGE =
  'Refresh token was already used; the session family has been revoked'

/**
 * A refresh token presented after it was already spent, outside the grace
 * window. The family is revoked before this is thrown.
 *
 * A separate code from `InvalidRefreshTokenError`, and the reason is
 * observability: decision 15 keeps the use case from logging, and makes the
 * error `code` the log line instead. Folding the two together would erase from
 * the logs the only trace that reuse detection ever fired — the security event
 * this whole design exists to produce. The client also acts differently: this
 * one means "wipe the secure storage and send the user back to the login
 * screen", not "retry".
 */
export class RefreshTokenReusedError extends UnauthorizedError {
  readonly code = REFRESH_TOKEN_REUSED_CODE

  constructor() {
    super(REFRESH_TOKEN_REUSED_MESSAGE)
  }
}
```

- [ ] **Step 2: Escrever o spec que falha**

Crie `src/modules/auth/use-cases/refresh-token.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import { RefreshTokenReusedError } from '#modules/auth/errors/refresh-token-reused-error'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { RefreshTokenIssuer } from '#modules/auth/services/refresh-token-issuer'
import { RefreshTokenUseCase } from '#modules/auth/use-cases/refresh-token'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const CURRENT_TOKEN = 'current-opaque-token'
const UNKNOWN_TOKEN = 'never-issued-token'
const ACCESS_TOKEN = 'signed.access.token'

const NOW = new Date('2026-08-31T12:00:00.000Z')
const TTL_SECONDS = 3600
const GRACE_WINDOW_MS = 30_000
const ONE_MILLISECOND = 1

const digestOf = (value: string) => `digest:${value}`
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

let repository: InMemoryRefreshTokensRepository
let useCase: RefreshTokenUseCase
let clockReading: Date

/**
 * Passthrough, exactly like the unit of work fake of slice 4: it runs the
 * callback against the same repositories and models NO rollback. Anything that
 * needs a real transaction is proved in `tests/integration/refresh-token.spec.ts`.
 */
const makeUow = (repos: AuthRepos): IAuthUnitOfWork => (work) => work(repos)

let generated = 0

const build = () => {
  repository = new InMemoryRefreshTokensRepository()
  generated = 0

  const issuer = new RefreshTokenIssuer(
    { opaque: () => `opaque-${(generated += 1)}` },
    { hash: digestOf },
    { generate: () => `id-${(generated += 1)}` },
    TTL_SECONDS,
  )

  useCase = new RefreshTokenUseCase(
    makeUow({
      users: {
        save: async () => {},
        findByEmail: async () => null,
        findById: async () => null,
      },
      refreshTokens: repository,
    }),
    issuer,
    { sign: async () => ACCESS_TOKEN, verify: async () => ({ sub: USER_ID }) },
    { hash: digestOf },
    { now: () => clockReading },
    GRACE_WINDOW_MS,
  )
}

const store = (props: {
  revokedAt?: Date | null
  replacedBy?: string | null
  expiresAt?: Date
  familyId?: string
}) =>
  repository.tokens.push(
    RefreshToken.fromTrusted({
      id: 'current-id',
      userId: USER_ID,
      tokenHash: digestOf(CURRENT_TOKEN),
      familyId: props.familyId ?? FAMILY_ID,
      expiresAt: props.expiresAt ?? at(TTL_SECONDS * 1000),
      revokedAt: props.revokedAt ?? null,
      replacedBy: props.replacedBy ?? null,
      createdAt: NOW,
    }),
  )

const refresh = () => useCase.execute({ refreshToken: CURRENT_TOKEN })

beforeEach(() => {
  clockReading = NOW
  build()
})

describe('RefreshTokenUseCase — rotation', () => {
  it('issues a new pair and revokes the presented token', async () => {
    store({})

    const result = await refresh()

    expect(result.accessToken).toBe(ACCESS_TOKEN)
    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)

    const [current, successor] = repository.tokens
    expect(current?.revokedAt).toEqual(NOW)
    expect(current?.replacedBy).toBe(successor?.id)
  })

  it('keeps the successor in the SAME family', async () => {
    // The family is the chain. A new family per rotation would make reuse
    // detection unable to revoke anything but the single stolen token.
    store({})

    await refresh()

    expect(repository.tokens[1]?.familyId).toBe(FAMILY_ID)
  })

  it('persists the digest of the new token, never the token itself', async () => {
    store({})

    const result = await refresh()

    expect(repository.tokens[1]?.tokenHash).toBe(digestOf(result.refreshToken))
  })
})

describe('RefreshTokenUseCase — refusals', () => {
  it('refuses a token it has never seen, revoking nothing', async () => {
    store({})

    await expect(
      useCase.execute({ refreshToken: UNKNOWN_TOKEN }),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError)

    expect(repository.tokens[0]?.revokedAt).toBeNull()
  })

  it('refuses an expired token WITHOUT revoking the family', async () => {
    // Expiry is not an attack: it is a client that was offline too long. Killing
    // the family here would log a user out for having a slow week.
    store({ expiresAt: at(-ONE_MILLISECOND) })

    await expect(refresh()).rejects.toBeInstanceOf(InvalidRefreshTokenError)
    expect(repository.tokens[0]?.revokedAt).toBeNull()
  })
})

describe('RefreshTokenUseCase — grace window', () => {
  it('accepts a rotated token inside the window and issues another pair', async () => {
    store({ revokedAt: NOW, replacedBy: 'successor-id' })
    clockReading = at(GRACE_WINDOW_MS)

    const result = await refresh()

    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)
    expect(repository.tokens[1]?.familyId).toBe(FAMILY_ID)
  })

  it('does NOT move revokedAt, so the window cannot slide', async () => {
    // Sliding would turn a client stuck in a retry loop into an eternal session
    // over a token that should already be dead.
    store({ revokedAt: NOW, replacedBy: 'successor-id' })
    clockReading = at(GRACE_WINDOW_MS)

    await refresh()

    expect(repository.tokens[0]?.revokedAt).toEqual(NOW)
    expect(repository.tokens[0]?.replacedBy).toBe('successor-id')
  })

  it('detects reuse past the window and revokes the whole family', async () => {
    store({ revokedAt: NOW, replacedBy: 'successor-id' })
    repository.tokens.push(
      RefreshToken.fromTrusted({
        id: 'successor-id',
        userId: USER_ID,
        tokenHash: digestOf('successor-token'),
        familyId: FAMILY_ID,
        expiresAt: at(TTL_SECONDS * 1000),
        revokedAt: null,
        replacedBy: null,
        createdAt: NOW,
      }),
    )
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    // The live successor dies too: that is the point. The thief and the victim
    // both lose the session, and the victim logs in again.
    expect(repository.tokens[1]?.revokedAt).toEqual(clockReading)
  })

  it('refuses a token revoked by LOGOUT even inside the window', async () => {
    // The guard of the whole slice. `replacedBy` is null after a logout, so this
    // must NOT be treated as a lost-response retry — otherwise logging out and
    // refreshing within 30 seconds would hand back a working session.
    store({ revokedAt: NOW, replacedBy: null })
    clockReading = at(ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
  })

  it('lets the grace window WIN over expiry', async () => {
    // The normative order. A client that rotates one second before expiry and
    // loses the response arrives with a token that is revoked AND expired;
    // checking expiry first would answer 401 and log it out — the exact random
    // logout the grace window exists to remove.
    store({
      revokedAt: NOW,
      replacedBy: 'successor-id',
      expiresAt: at(ONE_MILLISECOND),
    })
    clockReading = at(GRACE_WINDOW_MS)

    const result = await refresh()

    expect(result.refreshToken).not.toBe(CURRENT_TOKEN)
  })

  it('treats a rotated token that resurfaces after expiry as reuse', async () => {
    // The other side of the same order: whoever legitimately rotated this token
    // holds its successor and has no reason to present the ancestor again.
    store({
      revokedAt: NOW,
      replacedBy: 'successor-id',
      expiresAt: at(ONE_MILLISECOND),
    })
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
  })

  it('revokes only the presented family', async () => {
    store({ revokedAt: NOW, replacedBy: 'successor-id' })
    repository.tokens.push(
      RefreshToken.create({
        id: 'other-family-token',
        userId: USER_ID,
        tokenHash: digestOf('other-token'),
        familyId: OTHER_FAMILY_ID,
        now: NOW,
        ttlSeconds: TTL_SECONDS,
      }),
    )
    clockReading = at(GRACE_WINDOW_MS + ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    // Logging out of a stolen phone must not sign the tablet out.
    expect(repository.tokens[1]?.revokedAt).toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm test:unit -- refresh-token.spec`
Expected: FAIL — não resolve `#modules/auth/use-cases/refresh-token`.

- [ ] **Step 4: Escrever o use case**

Crie `src/modules/auth/use-cases/refresh-token.ts`:

```ts
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import { RefreshTokenReusedError } from '#modules/auth/errors/refresh-token-reused-error'
import type { ITokenSigner } from '#modules/auth/ports/token-signer'
import type { IRefreshTokensRepository } from '#modules/auth/repositories/refresh-tokens-repository'
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type {
  IssuedRefreshToken,
  RefreshTokenIssuer,
} from '#modules/auth/services/refresh-token-issuer'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface RefreshTokenCommand {
  refreshToken: string
}

export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
}

/**
 * Rotates a refresh token (decision 11): the presented token is spent, a
 * successor is issued in the same family, and a token presented after it was
 * already spent revokes the entire family.
 *
 * Receives the unit of work and NO repository directly — the rule of §9 of the
 * unit of work design, which neither the compiler nor the linter can enforce:
 * an injected singleton writes on an autocommit connection, so calling one
 * inside the callback compiles, passes its unit test against the passthrough
 * fake, and silently breaks atomicity in production.
 */
export class RefreshTokenUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly issuer: RefreshTokenIssuer,
    private readonly tokenSigner: ITokenSigner,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
    private readonly graceWindowMs: number,
  ) {}

  async execute(command: RefreshTokenCommand): Promise<RefreshTokenResult> {
    const tokenHash = this.tokenDigest.hash(command.refreshToken)
    // Read ONCE, outside the callback. The transaction runner re-executes the
    // callback on a deadlock retry, and a reading taken inside would give each
    // attempt a different instant — so the grace window would be measured
    // against whichever attempt happened to win.
    const now = this.clock.now()

    const issued = await this.uow(async ({ refreshTokens }) => {
      // The row lock is what makes reuse detection possible at all: without it
      // two simultaneous refreshes of the same token both read it as active,
      // both rotate, and nothing is ever detected.
      const current = await refreshTokens.findByHashForUpdate(tokenHash)

      if (current === null) throw new InvalidRefreshTokenError()

      // Revoked BEFORE expired, and the order is normative. A client that
      // rotates one second before `expiresAt` and loses the response arrives
      // with a token that is revoked AND expired; answering on expiry first
      // would log it out — the very random logout the grace window removes.
      if (current.isRevoked()) {
        if (!current.isWithinGraceWindow(now, this.graceWindowMs)) {
          await refreshTokens.revokeFamily(current.familyId, now)

          throw new RefreshTokenReusedError()
        }

        // Inside the window: a new pair in the same family, and `current` is
        // left untouched. Its `revokedAt` must not move, or a client stuck in a
        // retry loop would hold an eternal session; and `replacedBy` keeps
        // pointing at the FIRST successor, which is what tells a rotation from
        // a logout the next time this row is read.
        return this.#issueInto(refreshTokens, current.userId, current.familyId, now)
      }

      if (current.isExpired(now)) throw new InvalidRefreshTokenError()

      const next = await this.#issueInto(
        refreshTokens,
        current.userId,
        current.familyId,
        now,
      )
      await refreshTokens.markRotated(current.id, next.entity.id, now)

      return next
    })

    return {
      // Signed AFTER the commit: it depends on the user id, not on the
      // transaction, and everything that does not need the transaction stays
      // outside it.
      accessToken: await this.tokenSigner.sign({ sub: issued.entity.userId }),
      refreshToken: issued.token,
    }
  }

  /**
   * The token is generated INSIDE the transaction on purpose: the runner may
   * re-execute this callback, and generating outside would hand the client a
   * value produced before an attempt that rolled back. `randomBytes` costs
   * microseconds, so the "compute before" rule — which exists against argon2
   * and network I/O — does not reach it.
   */
  async #issueInto(
    refreshTokens: IRefreshTokensRepository,
    userId: string,
    familyId: string,
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const issued = this.issuer.issue(userId, familyId, now)
    await refreshTokens.save(issued.entity)

    return issued
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm test:unit -- refresh-token.spec`
Expected: PASS, 12 testes.

- [ ] **Step 6: FALSIFICAR a ordem normativa**

Mova o bloco `if (current.isExpired(now)) throw new InvalidRefreshTokenError()`
para **antes** do `if (current.isRevoked())`.

Run: `pnpm test:unit -- refresh-token.spec`
Expected: **FAIL** em `lets the grace window WIN over expiry` e em
`treats a rotated token that resurfaces after expiry as reuse`. Restaure a
ordem e confirme verde.

- [ ] **Step 7: Ligar ao container**

Em `src/modules/auth/container.ts`, acrescente ao objeto devolvido:

```ts
    refreshToken: new RefreshTokenUseCase(
      uow,
      refreshTokenIssuer,
      tokenSigner,
      tokenDigest,
      clock,
      config.REFRESH_TOKEN_GRACE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,
    ),
```

Extraia `const uow = createUnitOfWork(runner, authRepositories)` para uma
constante antes do `return` (hoje ele é construído inline) e declare
`const MILLISECONDS_PER_SECOND = 1000` no topo do arquivo. **Mantenha `uow` na
chave publicada** — `tests/integration/unit-of-work.spec.ts` o consome.

- [ ] **Step 8: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat: rotate the refresh token, and revoke the family that gets reused"
```

---

## Task 8: `POST /auth/refresh`

**Files:**
- Modify: `src/modules/auth/infra/http/constants.ts`
- Create: `src/modules/auth/infra/http/endpoints/refresh.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Test: `tests/integration/refresh-token.spec.ts`

**Interfaces:**
- Consumes: `container.refreshToken` (Task 7), `readRefreshCookie` /
  `setRefreshCookie` (Task 6).
- Produces:
  - `const NO_CONTENT_STATUS = 204`
  - `const SERVICE_UNAVAILABLE_STATUS = 503`
  - `export const refreshRoute: FastifyPluginAsync<{ container: AuthContainer }>`

**Contexto que o executor precisa.** **Este é o primeiro endpoint do projeto que
declara 503**, porque é o primeiro que usa o `uow` e portanto pode produzir
`TransactionConflictError`. E o body vence o cookie quando os dois vêm: o body é
explícito, o cookie é ambiente; a resposta segue o canal que foi usado.

- [ ] **Step 1: Acrescentar os status**

Em `src/modules/auth/infra/http/constants.ts`:

```ts
export const NO_CONTENT_STATUS = 204
```

```ts
/**
 * Produced by every endpoint that opens a transaction: a deadlock that survives
 * the runner's retries surfaces as `TransactionConflictError`, which the error
 * handler answers with 503 plus `Retry-After`.
 */
export const SERVICE_UNAVAILABLE_STATUS = 503
```

- [ ] **Step 2: Escrever o teste de integração que falha**

Crie `tests/integration/refresh-token.spec.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '#infra/config/env'
import { createDatabase, type Database } from '#infra/database/client'
import { buildApp } from '#main/app'
import { refreshTokens } from '#modules/auth/infra/drizzle/schema/refresh-tokens'
import { users } from '#modules/auth/infra/drizzle/schema/users'

// Spelled out rather than imported: these values ARE the wire contract.
const REGISTER_PATH = '/auth/register'
const LOGIN_PATH = '/auth/login'
const REFRESH_PATH = '/auth/refresh'
const POST_METHOD = 'POST'
const REFRESH_COOKIE_NAME = 'refresh_token'

const OK_STATUS_CODE = 200
const UNAUTHORIZED_STATUS_CODE = 401

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN'
const REFRESH_TOKEN_REUSED_CODE = 'REFRESH_TOKEN_REUSED'

const EMAIL = 'joao@example.com'
const PASSWORD = 'sup3r-s3cr3t!'
const UNKNOWN_TOKEN = 'a-token-that-was-never-issued'

let app: FastifyInstance
let db: Database
let pool: Pool

beforeAll(async () => {
  app = await buildApp(env)
  await app.ready()
  ;({ db, pool } = createDatabase(env))
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await db.delete(refreshTokens)
  await db.delete(users)
  await app.inject({
    method: POST_METHOD,
    url: REGISTER_PATH,
    payload: { email: EMAIL, password: PASSWORD },
  })
})

const login = async (payload: object = {}) => {
  const response = await app.inject({
    method: POST_METHOD,
    url: LOGIN_PATH,
    payload: { email: EMAIL, password: PASSWORD, ...payload },
  })

  return response
}

const refresh = (payload: object) =>
  app.inject({ method: POST_METHOD, url: REFRESH_PATH, payload })

const refreshWithCookie = (token: string) =>
  app.inject({
    method: POST_METHOD,
    url: REFRESH_PATH,
    payload: {},
    cookies: { [REFRESH_COOKIE_NAME]: token },
  })

describe('POST /auth/refresh', () => {
  it('rotates: the new pair works and the old token stops working', async () => {
    const { refreshToken } = (await login()).json()

    const rotated = await refresh({ refreshToken })

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)
    expect(rotated.json().refreshToken).not.toBe(refreshToken)

    const withSuccessor = await refresh({
      refreshToken: rotated.json().refreshToken,
    })
    expect(withSuccessor.statusCode).toBe(OK_STATUS_CODE)
  })

  it('accepts the old token once more inside the grace window', async () => {
    // The lost-response retry. Without this the app is logged out at random
    // every time a rotation response dies in a tunnel.
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    const retry = await refresh({ refreshToken })

    expect(retry.statusCode).toBe(OK_STATUS_CODE)
    expect(retry.json().refreshToken).toEqual(expect.any(String))
  })

  it('answers 401 for a token that was never issued', async () => {
    const response = await refresh({ refreshToken: UNKNOWN_TOKEN })

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('answers 401 when neither a body token nor a cookie is present', async () => {
    const response = await refresh({})

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('detects reuse past the window and revokes the whole family', async () => {
    const { refreshToken } = (await login()).json()
    const rotated = await refresh({ refreshToken })

    // Push the first token's revocation past the grace window, which is the one
    // thing a black-box HTTP test cannot do by waiting.
    await db.execute(
      sql`UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL`,
    )

    const reused = await refresh({ refreshToken })
    expect(reused.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)

    // The live successor died with the family: the thief and the victim both
    // lose the session, and the victim logs in again.
    const successor = await refresh({ refreshToken: rotated.json().refreshToken })
    expect(successor.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('serves two SIMULTANEOUS refreshes of the same token without a false reuse', async () => {
    // A product property, not a proof of the row lock — and the difference
    // matters. With the grace window on, the rotation branch and the grace
    // branch answer identically (200, new pair, same family), so this test stays
    // green with `.for('update')` removed. What defends the lock is the
    // two-transaction test in `drizzle-refresh-tokens-repository.spec.ts`.
    //
    // What this DOES prove is that a double-tap from a real client never comes
    // back as a spurious REFRESH_TOKEN_REUSED, which is the failure a user
    // would experience as being logged out at random.
    const { refreshToken } = (await login()).json()

    const [first, second] = await Promise.all([
      refresh({ refreshToken }),
      refresh({ refreshToken }),
    ])

    expect(first.statusCode).toBe(OK_STATUS_CODE)
    expect(second.statusCode).toBe(OK_STATUS_CODE)
    expect(first.json().refreshToken).not.toBe(second.json().refreshToken)

    const stored = await db.select().from(refreshTokens)
    const families = new Set(stored.map((row) => row.familyId))
    expect(families.size).toBe(1)
  })

  it('reads the token from the cookie when the body has none', async () => {
    const response = await login({ refreshTransport: 'cookie' })
    const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)

    const rotated = await refreshWithCookie(cookie?.value ?? '')

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)
    // Cookie in, cookie out: the response follows the channel that was used.
    expect(rotated.json().refreshToken).toBeUndefined()
    expect(
      rotated.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.value,
    ).toEqual(expect.any(String))
  })

  it('never puts the plaintext token in an error body', async () => {
    const response = await refresh({ refreshToken: UNKNOWN_TOKEN })

    expect(response.body).not.toContain(UNKNOWN_TOKEN)
  })
})
```

Importe `sql` de `drizzle-orm`.

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm test:integration -- refresh-token`
Expected: FAIL — `/auth/refresh` responde 404, porque a rota não existe.

- [ ] **Step 4: Escrever o endpoint**

Crie `src/modules/auth/infra/http/endpoints/refresh.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  OK_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  readRefreshCookie,
  setRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'

const REFRESH_PATH = '/refresh'
const REFRESH_SUMMARY = 'Rotate the refresh token'
const REFRESH_DESCRIPTION =
  'Exchanges a refresh token for a new access token and a new refresh token. ' +
  'The presented token is spent. Send it in the body, or let the browser send ' +
  'the cookie; the answer comes back on the channel it arrived on.'

/**
 * Optional, because the token may arrive in the cookie instead. A missing
 * credential is answered by the handler as 401, not by the schema as 400: a
 * credential that is absent is an authentication failure, exactly as it is for
 * a missing `Authorization` header.
 */
const bodySchema = z.object({ refreshToken: z.string().min(1).optional() })

const okSchema = z.object({
  accessToken: z.string(),
  /** Absent in cookie mode — see `login.ts` for why this is optional. */
  refreshToken: z.string().optional(),
})

export const refreshRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    REFRESH_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: REFRESH_SUMMARY,
        description: REFRESH_DESCRIPTION,
        body: bodySchema,
        response: {
          [OK_STATUS]: okSchema,
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          // The first 503 in the project. The rotation runs inside a
          // transaction, so a deadlock that survives the runner's retries
          // surfaces here as `TransactionConflictError`.
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const fromCookie = readRefreshCookie(request)
      // Body wins: it is the explicit channel, and the cookie is the ambient
      // one. The answer then follows whichever was actually used.
      const presented = request.body.refreshToken ?? fromCookie

      if (presented === undefined) throw new InvalidRefreshTokenError()

      const { accessToken, refreshToken } = await container.refreshToken.execute({
        refreshToken: presented,
      })

      if (request.body.refreshToken === undefined) {
        setRefreshCookie(reply, refreshToken, container.refreshTokenTtlSeconds)

        return reply.status(OK_STATUS).send({ accessToken })
      }

      return reply.status(OK_STATUS).send({ accessToken, refreshToken })
    },
  )
}
```

Em `src/modules/auth/infra/http/routes.ts`, importe `refreshRoute` e acrescente
`await app.register(refreshRoute, { container })`.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm test:integration -- refresh-token`
Expected: PASS, 8 testes.

- [ ] **Step 6: FALSIFICAR a detecção de reuso**

Em `refresh-token.ts`, troque `revokeFamily(current.familyId, now)` por um
no-op (`await Promise.resolve()`), mantendo o `throw`.

Run: `pnpm test:integration -- refresh-token`
Expected: **FAIL** em `detects reuse past the window and revokes the whole
family` — o pedido reusado ainda responde 401, mas o sucessor continua vivo, que
é o defeito de segurança. Restaure e confirme verde.

> **Não tente falsificar o `FOR UPDATE` aqui.** Com a janela de graça ligada,
> remover `.for('update')` mantém esta suíte **verde**: rotação e graça devolvem
> a mesma coisa pelo HTTP. Quem defende o lock é o teste de duas transações da
> Task 4, e é lá que a falsificação dele acontece.

- [ ] **Step 7: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat: expose the rotation, and declare the first 503 in the project"
```

---

## Task 9: `logout` e `logout-all`

**Files:**
- Create: `src/modules/auth/use-cases/logout.ts`
- Test: `src/modules/auth/use-cases/logout.spec.ts`
- Create: `src/modules/auth/use-cases/logout-all.ts`
- Test: `src/modules/auth/use-cases/logout-all.spec.ts`
- Create: `src/modules/auth/infra/http/endpoints/logout.ts`
- Create: `src/modules/auth/infra/http/endpoints/logout-all.ts`
- Modify: `src/modules/auth/infra/http/routes.ts`
- Modify: `src/modules/auth/container.ts`
- Test: `tests/integration/logout.spec.ts`

**Interfaces:**
- Consumes: `IAuthUnitOfWork`, `ITokenDigest`, `IClock`, `getPrincipal` e o
  `guard` que `routes.ts` já recebe.
- Produces:
  - `class LogoutUseCase` com `execute(command: { refreshToken: string }): Promise<void>`
  - `class LogoutAllUseCase` com `execute(userId: string): Promise<void>`
  - `container.logout`, `container.logoutAll`
  - `logoutRoute`, `logoutAllRoute`

**Contexto que o executor precisa.** Os dois recebem o `uow` **apesar de
escreverem num repositório só**, e isso contraria a leitura ingênua da decisão
22. A razão é o retry, não a atomicidade: a rotação trava a linha `A` e depois
atualiza a família inteira, enquanto o `logout` atualiza a família direto — são
conjuntos de linhas sobrepostos travados em ordens diferentes, um **AB-BA
clássico**, e `40P01` é alcançável. Fora do runner isso vira 500; dentro, vira
retry e, no pior caso, 503.

`logout-all` roda sob o `guard` — `getPrincipal(request).id`, nunca um id do
corpo.

- [ ] **Step 1: Escrever os specs que falham**

Crie `src/modules/auth/use-cases/logout.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { LogoutUseCase } from '#modules/auth/use-cases/logout'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const TOKEN = 'the-presented-token'
const SIBLING_TOKEN = 'a-sibling-in-the-same-family'
const UNKNOWN_TOKEN = 'never-issued'
const NOW = new Date('2026-08-31T12:00:00.000Z')
const TTL_SECONDS = 3600

const digestOf = (value: string) => `digest:${value}`

let repository: InMemoryRefreshTokensRepository
let useCase: LogoutUseCase

const makeUow = (repos: AuthRepos): IAuthUnitOfWork => (work) => work(repos)

const store = (id: string, token: string, familyId: string) =>
  repository.tokens.push(
    RefreshToken.create({
      id,
      userId: USER_ID,
      tokenHash: digestOf(token),
      familyId,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    }),
  )

beforeEach(() => {
  repository = new InMemoryRefreshTokensRepository()
  useCase = new LogoutUseCase(
    makeUow({
      users: {
        save: async () => {},
        findByEmail: async () => null,
        findById: async () => null,
      },
      refreshTokens: repository,
    }),
    { hash: digestOf },
    { now: () => NOW },
  )
})

describe('LogoutUseCase', () => {
  it('revokes the WHOLE family, not just the presented token', async () => {
    // Inside the grace window a family holds more than one live token. Revoking
    // only the presented row would leave the session standing after a logout.
    store('presented', TOKEN, FAMILY_ID)
    store('sibling', SIBLING_TOKEN, FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })

    expect(repository.tokens.every((token) => token.revokedAt !== null)).toBe(true)
  })

  it('leaves another family of the same user signed in', async () => {
    // Logging out on the phone must not sign the tablet out.
    store('presented', TOKEN, FAMILY_ID)
    store('other', SIBLING_TOKEN, OTHER_FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })

    expect(repository.tokens[1]?.revokedAt).toBeNull()
  })

  it('does not throw for a token it has never seen', async () => {
    // Saying "that token does not exist" is a free oracle, and logout has
    // nothing to protect beyond being idempotent.
    await expect(useCase.execute({ refreshToken: UNKNOWN_TOKEN })).resolves
      .toBeUndefined()
  })

  it('is idempotent', async () => {
    store('presented', TOKEN, FAMILY_ID)

    await useCase.execute({ refreshToken: TOKEN })
    await expect(useCase.execute({ refreshToken: TOKEN })).resolves.toBeUndefined()

    expect(repository.tokens[0]?.revokedAt).toEqual(NOW)
  })
})
```

Crie `src/modules/auth/use-cases/logout-all.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'
import type { AuthRepos, IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import { LogoutAllUseCase } from '#modules/auth/use-cases/logout-all'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const OTHER_USER_ID = '8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0'
const PHONE_FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const TABLET_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const STRANGER_FAMILY_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
const NOW = new Date('2026-08-31T12:00:00.000Z')
const TTL_SECONDS = 3600

let repository: InMemoryRefreshTokensRepository
let useCase: LogoutAllUseCase

const makeUow = (repos: AuthRepos): IAuthUnitOfWork => (work) => work(repos)

const store = (id: string, userId: string, familyId: string) =>
  repository.tokens.push(
    RefreshToken.create({
      id,
      userId,
      tokenHash: `digest:${id}`,
      familyId,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
    }),
  )

const revokedAtOf = (id: string) =>
  repository.tokens.find((token) => token.id === id)?.revokedAt

beforeEach(() => {
  repository = new InMemoryRefreshTokensRepository()
  useCase = new LogoutAllUseCase(
    makeUow({
      users: {
        save: async () => {},
        findByEmail: async () => null,
        findById: async () => null,
      },
      refreshTokens: repository,
    }),
    { now: () => NOW },
  )
})

describe('LogoutAllUseCase', () => {
  it('revokes every family of the user, across devices', async () => {
    store('phone', USER_ID, PHONE_FAMILY_ID)
    store('tablet', USER_ID, TABLET_FAMILY_ID)

    await useCase.execute(USER_ID)

    expect(revokedAtOf('phone')).toEqual(NOW)
    expect(revokedAtOf('tablet')).toEqual(NOW)
  })

  it('never touches another user session', async () => {
    // The id comes from a verified access token, but a scoping mistake here
    // would sign the whole install-base out, and no test above would notice.
    store('phone', USER_ID, PHONE_FAMILY_ID)
    store('stranger', OTHER_USER_ID, STRANGER_FAMILY_ID)

    await useCase.execute(USER_ID)

    expect(revokedAtOf('stranger')).toBeNull()
  })

  it('does not throw for a user with no tokens at all', async () => {
    await expect(useCase.execute(USER_ID)).resolves.toBeUndefined()
  })

  it('does not push an already-revoked token forward', async () => {
    store('phone', USER_ID, PHONE_FAMILY_ID)

    await useCase.execute(USER_ID)
    await useCase.execute(USER_ID)

    expect(revokedAtOf('phone')).toEqual(NOW)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falham**

Run: `pnpm test:unit -- logout`
Expected: FAIL — não resolve `#modules/auth/use-cases/logout`.

- [ ] **Step 3: Escrever os use cases**

Crie `src/modules/auth/use-cases/logout.ts`:

```ts
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IClock } from '#shared/ports/clock'
import type { ITokenDigest } from '#shared/ports/token-digest'

/** Raw, untrusted input. */
export interface LogoutCommand {
  refreshToken: string
}

/**
 * Ends one session by revoking the family of the presented token.
 *
 * Takes the unit of work even though it writes to a single repository, which
 * the guidance of decision 22 would not obviously require. The reason is the
 * RETRY, not atomicity: the rotation locks one row and then updates the whole
 * family, while this updates the family directly — overlapping row sets locked
 * in different orders, a plain AB-BA, so `40P01` is reachable. Outside the
 * runner that deadlock answers 500 for a request where nothing was wrong;
 * inside, it is retried and at worst becomes a 503.
 */
export class LogoutUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly tokenDigest: ITokenDigest,
    private readonly clock: IClock,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const tokenHash = this.tokenDigest.hash(command.refreshToken)
    const now = this.clock.now()

    await this.uow(async ({ refreshTokens }) => {
      const current = await refreshTokens.findByHashForUpdate(tokenHash)

      // An unknown token is not an error: reporting that it does not exist is a
      // free oracle, and "you are logged out" is already true.
      if (current === null) return

      // The whole family, not the single row: inside the grace window a family
      // legitimately holds more than one live token, and revoking one would
      // leave the session standing.
      await refreshTokens.revokeFamily(current.familyId, now)
    })
  }
}
```

Crie `src/modules/auth/use-cases/logout-all.ts`:

```ts
import type { IAuthUnitOfWork } from '#modules/auth/repositories/unit-of-work'
import type { IClock } from '#shared/ports/clock'

/**
 * Ends every session of one user, across every device.
 *
 * The id comes from the verified access token, never from client input — the
 * endpoint reads it with `getPrincipal`.
 *
 * Note what this does NOT do: an access token already issued stays valid until
 * it expires. That is the revocation latency decision 11 accepted when it kept
 * the database out of the authenticated path, and it is the TTL of the access
 * token — one hour by default.
 */
export class LogoutAllUseCase {
  constructor(
    private readonly uow: IAuthUnitOfWork,
    private readonly clock: IClock,
  ) {}

  async execute(userId: string): Promise<void> {
    const now = this.clock.now()

    await this.uow(({ refreshTokens }) => refreshTokens.revokeAllForUser(userId, now))
  }
}
```

- [ ] **Step 4: Escrever os endpoints**

Crie `src/modules/auth/infra/http/endpoints/logout.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import type { AuthContainer } from '#modules/auth/container'
import { InvalidRefreshTokenError } from '#modules/auth/errors/invalid-refresh-token-error'
import {
  AUTH_TAG,
  BAD_REQUEST_STATUS,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import {
  clearRefreshCookie,
  readRefreshCookie,
} from '#modules/auth/infra/http/refresh-cookie'

const LOGOUT_PATH = '/logout'
const LOGOUT_SUMMARY = 'End this session'
const LOGOUT_DESCRIPTION =
  'Revokes the whole family of the presented refresh token, ending this ' +
  'device session and leaving other devices signed in. Idempotent: any token ' +
  'that is presented answers 204, known or not.'

const bodySchema = z.object({ refreshToken: z.string().min(1).optional() })

export const logoutRoute: FastifyPluginAsync<{ container: AuthContainer }> = async (
  app,
  { container },
) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGOUT_PATH,
    {
      schema: {
        tags: [AUTH_TAG],
        summary: LOGOUT_SUMMARY,
        description: LOGOUT_DESCRIPTION,
        body: bodySchema,
        response: {
          // `z.null()` and not an omitted entry: with the Zod type provider a
          // handler may only answer a status the schema declares — verified,
          // it is a compile error otherwise. The generated document publishes
          // this as a response with no content, which is right for a 204.
          [NO_CONTENT_STATUS]: z.null(),
          [BAD_REQUEST_STATUS]: errorResponseSchema,
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const presented = request.body.refreshToken ?? readRefreshCookie(request)

      // No credential at all is 401, mirroring the auth guard. A token that IS
      // presented always answers 204 — valid, unknown, expired or already
      // revoked are indistinguishable, so there is no oracle.
      if (presented === undefined) throw new InvalidRefreshTokenError()

      await container.logout.execute({ refreshToken: presented })

      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}
```

Crie `src/modules/auth/infra/http/endpoints/logout-all.ts`:

```ts
import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPrincipal } from '#infra/http/auth-guard'
import { errorResponseSchema } from '#infra/http/errors/error-response'
import { BEARER_SECURITY_SCHEME } from '#infra/http/openapi'
import type { AuthContainer } from '#modules/auth/container'
import {
  AUTH_TAG,
  NO_CONTENT_STATUS,
  SERVICE_UNAVAILABLE_STATUS,
  UNAUTHORIZED_STATUS,
} from '#modules/auth/infra/http/constants'
import { clearRefreshCookie } from '#modules/auth/infra/http/refresh-cookie'

const LOGOUT_ALL_PATH = '/logout-all'
const LOGOUT_ALL_SUMMARY = 'End every session of this account'
const LOGOUT_ALL_DESCRIPTION =
  'Revokes every refresh token of the authenticated user, on every device. ' +
  'Access tokens already issued stay valid until they expire — decision 11 ' +
  'keeps the database out of the authenticated path, so revocation latency is ' +
  'the access token TTL.'

/**
 * No body schema, so no 400: this endpoint reads nothing from the request but
 * the verified token subject. The id NEVER comes from client input — taking a
 * `userId` from the body here would let any authenticated caller sign anyone
 * out.
 */
export const logoutAllRoute: FastifyPluginAsync<{
  container: AuthContainer
  guard: preHandlerHookHandler
}> = async (app, { container, guard }) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    LOGOUT_ALL_PATH,
    {
      preHandler: guard,
      schema: {
        tags: [AUTH_TAG],
        summary: LOGOUT_ALL_SUMMARY,
        description: LOGOUT_ALL_DESCRIPTION,
        security: [{ [BEARER_SECURITY_SCHEME]: [] }],
        response: {
          [NO_CONTENT_STATUS]: z.null(),
          [UNAUTHORIZED_STATUS]: errorResponseSchema,
          [SERVICE_UNAVAILABLE_STATUS]: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await container.logoutAll.execute(getPrincipal(request).id)

      // Sent unconditionally: if a cookie came with the request, it just died
      // in the database, and leaving it in the browser only produces a
      // confusing 401 on the next refresh.
      clearRefreshCookie(reply)

      return reply.status(NO_CONTENT_STATUS).send(null)
    },
  )
}
```

- [ ] **Step 5: Ligar container e rotas**

Em `container.ts`:

```ts
    logout: new LogoutUseCase(uow, tokenDigest, clock),
    logoutAll: new LogoutAllUseCase(uow, clock),
```

Em `routes.ts`:

```ts
  await app.register(logoutRoute, { container })
  await app.register(logoutAllRoute, { container, guard })
```

- [ ] **Step 6: Escrever o teste de integração**

Crie `tests/integration/logout.spec.ts`. Reuse a armação de `beforeAll` /
`afterAll` / `beforeEach` de `refresh-token.spec.ts` — mesmos imports, mesmo
`buildApp(env)`, mesma limpeza de `refreshTokens` antes de `users` — e
acrescente estes helpers e casos:

```ts
const LOGOUT_PATH = '/auth/logout'
const LOGOUT_ALL_PATH = '/auth/logout-all'
const NO_CONTENT_STATUS_CODE = 204

const OTHER_EMAIL = 'maria@example.com'

const logout = (payload: object, cookies?: Record<string, string>) =>
  app.inject({ method: POST_METHOD, url: LOGOUT_PATH, payload, cookies })

const logoutAll = (accessToken?: string) =>
  app.inject({
    method: POST_METHOD,
    url: LOGOUT_ALL_PATH,
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
  })

describe('POST /auth/logout', () => {
  it('answers 204 and kills the session', async () => {
    const { refreshToken } = (await login()).json()

    expect((await logout({ refreshToken })).statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect((await refresh({ refreshToken })).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('kills the sibling issued inside the grace window too', async () => {
    // The reason logout revokes the FAMILY and not the row: a grace-window
    // exchange leaves two live tokens, and revoking one would leave the session
    // standing after the user asked to leave.
    const { refreshToken } = (await login()).json()
    const rotated = await refresh({ refreshToken })
    const sibling = await refresh({ refreshToken })

    await logout({ refreshToken: rotated.json().refreshToken })

    expect(
      (await refresh({ refreshToken: sibling.json().refreshToken })).statusCode,
    ).toBe(UNAUTHORIZED_STATUS_CODE)
  })

  it('leaves a second login of the same user signed in', async () => {
    // Logging out on the phone must not sign the tablet out.
    const phone = (await login()).json()
    const tablet = (await login()).json()

    await logout({ refreshToken: phone.refreshToken })

    expect((await refresh({ refreshToken: tablet.refreshToken })).statusCode).toBe(
      OK_STATUS_CODE,
    )
  })

  it('answers 204 for a token it has never seen', async () => {
    // Indistinguishable from the valid case on purpose: a different answer here
    // would tell a caller whether a token exists.
    expect((await logout({ refreshToken: UNKNOWN_TOKEN })).statusCode).toBe(
      NO_CONTENT_STATUS_CODE,
    )
  })

  it('answers 401 when no credential is presented at all', async () => {
    const response = await logout({})

    expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(response.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)
  })

  it('logs out from the cookie, and expires it with the same attributes', async () => {
    const loggedIn = await login({ refreshTransport: 'cookie' })
    const value =
      loggedIn.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.value ?? ''

    const response = await logout({}, { [REFRESH_COOKIE_NAME]: value })
    const cleared = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)

    expect(response.statusCode).toBe(NO_CONTENT_STATUS_CODE)
    expect(cleared?.maxAge).toBe(0)
    expect(cleared?.path).toBe('/auth')
    // `clearCookie` does NOT inherit what `setCookie` used — verified. These two
    // assertions are what would catch a future call that passes only the path.
    expect(cleared?.httpOnly).toBe(true)
    expect(cleared?.secure).toBe(true)
  })
})

describe('POST /auth/logout-all', () => {
  it('kills every family of the caller', async () => {
    const phone = (await login()).json()
    const tablet = (await login()).json()

    expect((await logoutAll(phone.accessToken)).statusCode).toBe(
      NO_CONTENT_STATUS_CODE,
    )

    expect((await refresh({ refreshToken: phone.refreshToken })).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
    expect((await refresh({ refreshToken: tablet.refreshToken })).statusCode).toBe(
      UNAUTHORIZED_STATUS_CODE,
    )
  })

  it('never touches another account', async () => {
    await app.inject({
      method: POST_METHOD,
      url: REGISTER_PATH,
      payload: { email: OTHER_EMAIL, password: PASSWORD },
    })
    const stranger = (
      await app.inject({
        method: POST_METHOD,
        url: LOGIN_PATH,
        payload: { email: OTHER_EMAIL, password: PASSWORD },
      })
    ).json()
    const mine = (await login()).json()

    await logoutAll(mine.accessToken)

    expect((await refresh({ refreshToken: stranger.refreshToken })).statusCode).toBe(
      OK_STATUS_CODE,
    )
  })

  it('answers 401 without an Authorization header', async () => {
    expect((await logoutAll()).statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
  })
})
```

- [ ] **Step 7: Rodar e confirmar que passa**

Run: `pnpm test:unit -- logout` → PASS
Run: `pnpm test:integration -- logout` → PASS

- [ ] **Step 8: FALSIFICAR o escopo da revogação**

Em `logout.ts`, troque `revokeFamily(current.familyId, now)` por
`markRotated(current.id, current.id, now)` (revogando só a linha).

Run: `pnpm test:unit -- logout` e `pnpm test:integration -- logout`
Expected: **FAIL** em `revokes the WHOLE family` e no caso 2 da integração.
Restaure e confirme verde.

- [ ] **Step 9: Verificar e commitar**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat: end a session, and end all of them"
```

---

## Task 10: As emendas de documentação

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: tudo que as Tasks 1–9 construíram.
- Produces: nada em código.

**Contexto que o executor precisa.** Neste repositório a documentação é
autoridade, então emenda não é acessório: uma decisão que descreve um desenho
que o código não tem mais é pior que documentação nenhuma, porque será citada.

> ⚠️ **`docs/DECISIONS.md` NÃO é rastreado pelo git** — está no `.gitignore`
> (linha 146), junto de `OLD_ARCHITECTURE.md`, `STRUCTURE.md` e `TODO.md`, sob
> o cabeçalho "Local docs for reference". **Edite-o mesmo assim**: ele continua
> sendo a autoridade das decisões, e as fatias anteriores o emendaram. O que
> muda é só o `git add` do último passo, que leva **apenas** o
> `ARCHITECTURE.md`. Um `git add docs/DECISIONS.md` seria recusado pelo ignore.

- [ ] **Step 1: Emendar a decisão 11**

Acrescente um bloco `> **Emendada em 2026-08-31**` no topo da decisão 11,
registrando a mecânica que a implementação fechou:

- `replaced_by` é o discriminante entre *revogado por rotação* e *revogado por
  logout*, e é o que impede a janela de graça de virar bypass do logout;
- a ordem de checagem é **revogado antes de expirado**, e o motivo (o cliente
  que rotaciona um segundo antes de `expiresAt` e perde a resposta);
- a janela **não desliza**: `revoked_at` não é reescrito;
- dentro da janela a família pode ter **mais de um token ativo**, com o custo
  aceito.

- [ ] **Step 2: Emendar a decisão 12**

- `Path=/auth` no lugar de `Path=/auth/refresh`, porque o browser não manda o
  cookie para `/auth/logout` com o path estreito, e o logout por cookie seria
  impossível;
- o campo `refreshTransport` no login, com o registro honesto de que provedor de
  identidade nenhum tem isso — todos respondem no body e deixam o cookie para um
  BFF — e de que é a decisão 12 que o exige, ao servir os dois transportes de uma
  superfície só. Cite o precedente do ASP.NET Core Identity (`?useCookies=true`).

- [ ] **Step 3: Emendar as decisões 21 e 22**

- **21:** `ITokenGenerator` nasceu, sem o `uuid()` do sketch original, e ao lado
  dele nasceu `ITokenDigest` — pelo mesmo critério de "motivos de mudar
  diferentes" que já havia partido o port uma vez. Registre também que a
  separação é o que torna estrutural o aviso sobre argon2.
- **22:** segunda razão legítima para receber o UoW — o **retry de deadlock**,
  não só a atomicidade. `logout` e `logout-all` escrevem num repositório só e
  ainda assim o recebem, porque a rotação e eles travam conjuntos de linhas
  sobrepostos em ordens diferentes.

- [ ] **Step 4: Atualizar o `ARCHITECTURE.md`**

- **§7:** os primeiros endpoints que declaram **503**, e por quê. Acrescente os
  dois achados verificados: o type provider **impede em tempo de compilação**
  responder um status não declarado, e um 204 precisa de `z.null()` no schema e
  `.send(null)` no handler.
- **§2:** a árvore ganha `services/`, `refresh-cookie.ts`, os dois endpoints
  novos e os arquivos de refresh token.
- **§11 "Bibliotecas que falham em silêncio":** acrescente **três** armadilhas
  novas, que valem o mesmo que as três de lá. A seção já diz que o que une os
  casos "não é a biblioteca, é o modo de falha", então a terceira cabe mesmo
  sendo de browser e não de pacote:
  1. `SET LOCAL` não aceita parâmetro ligado — `42601 syntax error at or near
     "$1"`. Tem de ser `sql.raw`, e portanto nunca com valor vindo de request.
  2. `clearCookie` **não herda** os atributos de `setCookie`: só com `{ path }`
     sai `SameSite=Lax`, sem `HttpOnly` e sem `Secure`.
  3. **O Safari recusa cookie `Secure` em `http://localhost`; Chrome e Firefox
     aceitam.**
     Medido em 2026-09-01, macOS e iOS, contra um controle idêntico sem o
     `Secure` que foi guardado nos dois — então `SameSite=Strict`, `Path` e
     `HttpOnly` funcionam, e a recusa é do `Secure` sozinho. Consequência
     concreta: **o modo cookie não pode ser exercitado pelo `/docs` no Safari.**
     O que recusa não guarda e não avisa — nem erro, nem console —, e o refresh
     seguinte responde 401 como se nunca tivesse havido login. Diga o que fazer
     (browser Chromium, ou TLS na frente da API) e por que condicionar o
     `Secure` a `NODE_ENV` seria pior: essa variável tem `.default('development')`,
     então a "correção" mandaria cookie sem `Secure` em qualquer deploy que
     esquecesse de defini-la. Produção é HTTPS e mobile não usa cookie.
- **§13:** corrija o erro que **já existe** — a lista ainda diz que o Unit of
  Work não existe, e a fatia 4 o construiu. Remova também "refresh token" se
  estiver listado, e mantenha o resto.

- [ ] **Step 5: Verificar e commitar**

```bash
pnpm lint && pnpm typecheck && pnpm test
# DECISIONS.md is gitignored on purpose — edited, never committed.
git add ARCHITECTURE.md
git commit -m "docs: record what the refresh token slice amended"
```

---

## Verificação final da fatia

- [ ] `pnpm lint` limpo
- [ ] `pnpm typecheck` limpo
- [ ] `pnpm test` verde — a baseline eram **214** testes; esta fatia acrescenta
      cerca de **60**
- [ ] `pnpm build` passa, e **nenhum** arquivo de `in-memory/`, `fixtures/` ou
      `*.spec.ts` aparece em `dist/`
- [ ] `NODE_ENV=development pnpm dev` sobe, e `/docs` mostra `refresh`, `logout`
      e `logout-all` com **503** declarado e o 204 sem `content`
- [ ] Nenhuma linha de log contém um refresh token em claro — confira a saída dos
      testes de integração por uma amostra de token
