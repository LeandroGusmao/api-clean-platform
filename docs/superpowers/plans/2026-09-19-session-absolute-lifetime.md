# Teto absoluto de sessão — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo refresh token novo vence em `min(agora + TTL, início da sessão + REFRESH_TOKEN_MAX_LIFETIME_SECONDS)`, com padrão de 90 dias, e a rotação recusa uma família cujo teto já passou.

**Architecture:** O teto entra por um único ponto, `RefreshTokenIssuer.issue`, que calcula `ceilingFor(início)` e o passa a `RefreshToken.create`, onde a regra `min` mora. O token que chega ao teto expira pelo caminho de expiração que já existe (401 `INVALID_REFRESH_TOKEN`, sem reuso, sem aviso). Sem coluna e sem migration: o início vem do `session_started_at` herdado a cada rotação.

**Tech Stack:** TypeScript, Zod (`authEnvSchema`), Vitest (projetos `unit` e `integration`), Drizzle/Postgres, Biome.

**Spec:** [`docs/superpowers/specs/2026-09-19-session-absolute-lifetime-design.md`](../specs/2026-09-19-session-absolute-lifetime-design.md)

## Global Constraints

- Todo código, string, log e comentário em **inglês**; só os `*.md` podem ser em português (`CLAUDE.md`).
- **Sem magic strings/numbers** inline: constantes nomeadas, `UPPER_SNAKE_CASE` (`CLAUDE.md`), inclusive nos testes, no estilo dos arquivos vizinhos.
- Comentários explicam o código, nunca o processo: nada de "fatia 25", "o plano diz". Ponteiros para a spec/decisão são permitidos (`CLAUDE.md`).
- Padrão do teto: `7_776_000` s (90 dias). Variável: `REFRESH_TOKEN_MAX_LIFETIME_SECONDS`.
- `lifetimeCeiling` é **obrigatório** em `RefreshToken.create` e `maxLifetimeSeconds` é obrigatório no construtor do emissor: um teto esquecido viraria uma sessão sem teto em silêncio, que é o defeito que esta fatia fecha.
- Não criar coluna, migration, código de erro nem ramo novo no refresh (spec §2).
- Rodar `pnpm` normalmente neste checkout. Se aparecer `ERR_PNPM_UNEXPECTED_STORE`, é o snap do VS Code: repetir com `--store-dir` apontando para o store antigo. Em um worktree com `node_modules` por symlink, **não** rodar `pnpm`: usar `node_modules/.bin/<ferramenta>` direto.
- Testes de integração precisam de Postgres e **`REDIS_URL`** definidos.
- Nunca canalizar um portão (`pnpm lint | tail`): rodar sozinho e ler o exit code.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/modules/auth/config.ts` | Variável e padrão do teto | Modificar |
| `src/modules/auth/config.spec.ts` | Padrão e rejeição de vazio | Modificar |
| `src/infra/config/fixtures/test-env.ts`, `src/infra/config/env.spec.ts` | Env completo de teste | Modificar |
| `.env.example` | Documenta a variável | Modificar |
| `src/modules/auth/entities/refresh-token.ts` (+ `.spec.ts`) | Regra `min(TTL, teto)` | Modificar |
| `src/modules/auth/services/refresh-token-issuer.ts` (+ `.spec.ts`) | `ceilingFor` e repasse do teto | Modificar |
| `src/modules/auth/container.ts` | Injeta o teto no emissor | Modificar |
| Specs que constroem `RefreshToken.create` / `new RefreshTokenIssuer` | Ripple do parâmetro obrigatório | Modificar |
| `src/modules/auth/use-cases/refresh-token.ts` (+ `.spec.ts`) | Recusa a rotação além do teto | Modificar |
| `tests/integration/refresh-token.spec.ts`, `tests/integration/drizzle-refresh-tokens-repository.spec.ts` | Prova no Postgres real; ripple | Modificar |
| `docs/DECISIONS.md`, `docs/TODO.md` | Decisão 42 e fila | Modificar |

---

### Task 1: A variável `REFRESH_TOKEN_MAX_LIFETIME_SECONDS`

**Files:**
- Modify: `src/modules/auth/config.ts:21-22` (constante) e `~:235` (schema)
- Modify: `src/infra/config/fixtures/test-env.ts:52,91`
- Modify: `src/infra/config/env.spec.ts:58,149`
- Modify: `.env.example:62-63`
- Test: `src/modules/auth/config.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS = 7_776_000` exportado de `#modules/auth/config`, e o campo `REFRESH_TOKEN_MAX_LIFETIME_SECONDS: number` em `authEnvSchema`/`AuthConfig`. As Tasks 2 e 3 dependem de ambos.

- [ ] **Step 1: Write the failing tests**

Em `config.spec.ts`, acrescentar `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS` ao import (ordem alfabética: depois de `DEFAULT_PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS`, antes de `DEFAULT_REFRESH_TOKEN_PRUNE_RETENTION_SECONDS`) e, ao fim do `describe('authEnvSchema', …)`:

```ts
  it('defaults the refresh token lifetime ceiling to 90 days', () => {
    const config = authEnvSchema.parse(MINIMAL_ENV)

    expect(config.REFRESH_TOKEN_MAX_LIFETIME_SECONDS).toBe(
      DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,
    )
    expect(DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS).toBe(NINETY_DAYS_SECONDS)
  })

  it('rejects an empty lifetime ceiling instead of coercing it to zero', () => {
    // Zero would refuse every login: every token would be born past its ceiling.
    expect(() =>
      authEnvSchema.parse({ ...MINIMAL_ENV, REFRESH_TOKEN_MAX_LIFETIME_SECONDS: '' }),
    ).toThrow()
  })
```

com `const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60` junto das outras constantes do topo (o teste amarra o número à intenção "90 dias" em vez de repetir o literal da constante).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/config.spec.ts`
Expected: FAIL — import indefinido / `REFRESH_TOKEN_MAX_LIFETIME_SECONDS` ausente do schema.

- [ ] **Step 3: Write the implementation**

`config.ts`, depois de `DEFAULT_REFRESH_TOKEN_TTL_SECONDS`:

```ts
/**
 * 90 days. The ceiling on a session's whole life, counted from when the family
 * opened. The TTL above slides with every rotation and so is only an idle
 * timeout; this one does not slide. A ceiling below the TTL simply wins.
 */
export const DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS = 7_776_000
```

No schema, logo depois do campo `REFRESH_TOKEN_TTL_SECONDS`:

```ts
  // `.positive()` and not `.nonnegative()`: a ceiling of zero would refuse every
  // login, and rejecting zero is also what rejects an empty value.
  REFRESH_TOKEN_MAX_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS),
```

`test-env.ts`: importar `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS` (mesmo bloco de imports dos outros `DEFAULT_…`) e adicionar `REFRESH_TOKEN_MAX_LIFETIME_SECONDS: DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,` logo após `REFRESH_TOKEN_TTL_SECONDS`. Mesma mudança em `env.spec.ts` (import + entrada no objeto esperado, depois de `REFRESH_TOKEN_TTL_SECONDS`).

`.env.example`, no bloco do refresh token:

```
# Refresh token (decision 11). Seconds, all three of them. The TTL slides with
# every rotation (an idle timeout); the max lifetime does not (the whole life of
# a session, counted from login).
REFRESH_TOKEN_TTL_SECONDS=5184000
REFRESH_TOKEN_MAX_LIFETIME_SECONDS=7776000
REFRESH_TOKEN_GRACE_WINDOW_SECONDS=30
```

(substituindo a linha de comentário "Refresh token (decision 11). Seconds, both of them.").

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit src/modules/auth/config.spec.ts src/infra/config` e `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/config.ts src/modules/auth/config.spec.ts src/infra/config .env.example
git commit -m "feat(auth): add REFRESH_TOKEN_MAX_LIFETIME_SECONDS

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: O teto entra na entidade e no emissor

**Files:**
- Modify: `src/modules/auth/entities/refresh-token.ts:25-33,96-114`
- Modify: `src/modules/auth/services/refresh-token-issuer.ts`
- Modify: `src/modules/auth/container.ts:110-115`
- Modify (ripple, só compilação): todo spec que chama `RefreshToken.create(` ou `new RefreshTokenIssuer(` — ver Step 3
- Test: `src/modules/auth/entities/refresh-token.spec.ts`, `src/modules/auth/services/refresh-token-issuer.spec.ts`

**Interfaces:**
- Consumes: `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS` e `config.REFRESH_TOKEN_MAX_LIFETIME_SECONDS` (Task 1).
- Produces:
  - `CreateRefreshTokenProps.lifetimeCeiling: Date` (obrigatório); `RefreshToken.create` grava `expiresAt = min(now + ttlSeconds, lifetimeCeiling)`.
  - `new RefreshTokenIssuer(tokenGenerator, tokenDigest, idGenerator, ttlSeconds, maxLifetimeSeconds)`.
  - `RefreshTokenIssuer.ceilingFor(sessionStartedAt: Date): Date` = `sessionStartedAt + maxLifetimeSeconds`. A Task 3 usa este método.

- [ ] **Step 1: Write the failing tests**

`refresh-token.spec.ts` (entidade): o helper `active()` e o teste do "contexto ausente" passam a receber `lifetimeCeiling` (ver Step 3). Constantes novas no topo: `const FAR_CEILING = new Date('2099-01-01T00:00:00.000Z')` (com o comentário `/** Far enough that it never binds. */`), `const ONE_HOUR_MS = 3_600_000`. Novo `describe`:

```ts
describe('RefreshToken lifetime ceiling', () => {
  const create = (lifetimeCeiling: Date) =>
    RefreshToken.create({
      id: TOKEN_ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      familyId: FAMILY_ID,
      now: NOW,
      ttlSeconds: TTL_SECONDS,
      lifetimeCeiling,
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: SESSION_STARTED_AT,
    })

  it('expires at now plus the TTL when the ceiling is farther away', () => {
    expect(create(FAR_CEILING).expiresAt).toEqual(at(TTL_MS))
  })

  it('expires at the ceiling when it is closer than the TTL', () => {
    const ceiling = at(TTL_MS - ONE_HOUR_MS)

    expect(create(ceiling).expiresAt).toEqual(ceiling)
  })

  it('gives the same instant when the ceiling equals now plus the TTL', () => {
    expect(create(at(TTL_MS)).expiresAt).toEqual(at(TTL_MS))
  })
})
```

Conferir que `TTL_SECONDS`/`TTL_MS` do arquivo dão mais de uma hora (senão ajustar `ONE_HOUR_MS` para uma fração do TTL, por exemplo `TTL_MS / 2`, e renomear `HALF_THE_TTL_MS`).

`refresh-token-issuer.spec.ts`: constante `const MAX_LIFETIME_SECONDS = 600` (maior que o `TTL_SECONDS = 60` do arquivo) e `makeIssuer` passa a receber `maxLifetimeSeconds = MAX_LIFETIME_SECONDS` como parâmetro opcional, repassado como quinto argumento do construtor. Testes novos:

```ts
  it('computes the ceiling as the session start plus the max lifetime', () => {
    expect(makeIssuer().ceilingFor(SESSION_STARTED_AT)).toEqual(
      new Date(SESSION_STARTED_AT.getTime() + MAX_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('lets a ceiling closer than the TTL cap the issued expiry', () => {
    // 30s of session left, TTL 60s: the ceiling wins.
    const startedAt = new Date(
      NOW.getTime() - (MAX_LIFETIME_SECONDS - HALF_TTL_SECONDS) * MILLISECONDS_PER_SECOND,
    )

    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: IP,
      deviceLabel: DEVICE_LABEL,
      sessionStartedAt: startedAt,
    })

    expect(entity.expiresAt).toEqual(
      new Date(NOW.getTime() + HALF_TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })

  it('counts a fresh family from now when the context carries no start', () => {
    const { entity } = makeIssuer().issue(USER_ID, FAMILY_ID, NOW, {
      ip: null,
      deviceLabel: null,
      sessionStartedAt: null,
    })

    // Ceiling is far beyond the TTL, so the TTL still decides.
    expect(entity.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL_SECONDS * MILLISECONDS_PER_SECOND),
    )
  })
```

com `const HALF_TTL_SECONDS = 30`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/entities/refresh-token.spec.ts src/modules/auth/services/refresh-token-issuer.spec.ts`
Expected: FAIL — `lifetimeCeiling` ignorado (o `expiresAt` continua `now + TTL`), `ceilingFor is not a function`. (`pnpm typecheck` também acusa o que é obrigatório e ainda não existe; isso é esperado até o Step 3.)

- [ ] **Step 3: Write the implementation**

`refresh-token.ts`, em `CreateRefreshTokenProps`, depois de `ttlSeconds`:

```ts
  /**
   * The instant past which no token of this family may be valid: the session
   * start plus the max lifetime. Required, not optional — a forgotten ceiling
   * would silently give the family no ceiling at all.
   */
  lifetimeCeiling: Date
```

e em `create`, trocar o `expiresAt`:

```ts
      // The TTL slides with every rotation; the ceiling does not. Whichever is
      // sooner wins. `new Date(millis)` is deterministic, so it is not the R7
      // hazard that `new Date()` with no argument is.
      expiresAt: new Date(
        Math.min(
          props.now.getTime() + props.ttlSeconds * MILLISECONDS_PER_SECOND,
          props.lifetimeCeiling.getTime(),
        ),
      ),
```

`refresh-token-issuer.ts`: construtor ganha `private readonly maxLifetimeSeconds: number,` depois de `ttlSeconds`; adicionar:

```ts
  /** The instant a session that opened at `sessionStartedAt` can no longer renew. */
  ceilingFor(sessionStartedAt: Date): Date {
    return new Date(
      sessionStartedAt.getTime() + this.maxLifetimeSeconds * MILLISECONDS_PER_SECOND,
    )
  }
```

com `const MILLISECONDS_PER_SECOND = 1000` no topo do arquivo, e em `issue`:

```ts
    // A row opened before the column carries no start; counting from `now` is the
    // same choice `inherit` makes for it, one level up.
    const sessionStartedAt = context.sessionStartedAt ?? now
    ...
        ttlSeconds: this.ttlSeconds,
        lifetimeCeiling: this.ceilingFor(sessionStartedAt),
        ...
        sessionStartedAt: context.sessionStartedAt,
```

(a coluna continua recebendo `context.sessionStartedAt` cru; só o teto usa o `?? now`.)

`container.ts`: no `new RefreshTokenIssuer(`, depois de `config.REFRESH_TOKEN_TTL_SECONDS,` acrescentar `config.REFRESH_TOKEN_MAX_LIFETIME_SECONDS,`.

**Ripple (mecânico, guiado pelo compilador).** Rodar `pnpm typecheck` e corrigir cada erro:
- Cada `RefreshToken.create({ … })` em specs (`list-active-sessions.spec.ts` ×2, `logout-all.spec.ts`, `logout.spec.ts`, `sign-in-with-google.spec.ts`, `refresh-token.spec.ts:~351`, `entities/refresh-token.spec.ts` ×2, `tests/integration/drizzle-refresh-tokens-repository.spec.ts` ×2) ganha `lifetimeCeiling: FAR_CEILING,` logo depois de `ttlSeconds: …,`, com `const FAR_CEILING = new Date('2099-01-01T00:00:00.000Z')` declarado uma vez por arquivo, precedido de `/** Far enough that it never binds. */`.
- Cada `new RefreshTokenIssuer(` em specs (`login-user.spec.ts`, `change-password.spec.ts` ×2, `refresh-token.spec.ts` ×2, `sign-in-with-google.spec.ts`, `confirm-email.spec.ts`) ganha `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS,` como último argumento, com `import { DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS } from '#modules/auth/config'`. Nenhum desses testes deve mudar de comportamento: com 90 dias o teto não pesa.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm typecheck` (deve zerar), depois `pnpm vitest run --project unit` e `pnpm vitest run --project integration tests/integration/drizzle-refresh-tokens-repository.spec.ts`
Expected: PASS em tudo; o total de testes de unidade sobe pelos seis novos.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(auth): cap a refresh token's expiry at the session lifetime ceiling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: A rotação recusa uma família cujo teto já passou

**Files:**
- Modify: `src/modules/auth/use-cases/refresh-token.ts` (`#issueInto`, ~linhas 213-228)
- Test: `src/modules/auth/use-cases/refresh-token.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenIssuer.ceilingFor(start: Date): Date` (Task 2); `IssuedSessionContext.sessionStartedAt`.
- Produces: `RefreshTokenUseCase` lança `InvalidRefreshTokenError` quando `ceilingFor(início) <= now`, antes de emitir.

- [ ] **Step 1: Write the failing tests**

No `refresh-token.spec.ts`, o `new RefreshTokenIssuer(` de `build()` já usa `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS` (Task 2). Constantes e helper novos, junto das outras:

```ts
const MAX_LIFETIME_MS = DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND
const THIRTY_MINUTES_MS = 30 * 60 * MILLISECONDS_PER_SECOND

/** A session start such that the family's ceiling lands `remainingMs` after `NOW`. */
const startedWithCeilingAt = (remainingMs: number) =>
  new Date(NOW.getTime() - MAX_LIFETIME_MS + remainingMs)
```

Novo `describe`, ao fim do arquivo:

```ts
describe('RefreshTokenUseCase — session lifetime ceiling', () => {
  it('caps the successor at the ceiling when it is closer than the TTL', async () => {
    const start = startedWithCeilingAt(THIRTY_MINUTES_MS)
    store({ sessionStartedAt: start })

    await refresh()

    const successor = repository.tokens[1]
    expect(successor?.expiresAt).toEqual(at(THIRTY_MINUTES_MS))
    // The ceiling is a fact about the FAMILY: rotation must not move it.
    expect(successor?.sessionStartedAt).toEqual(start)
  })

  it('refuses a family whose ceiling has arrived, writing nothing', async () => {
    store({ sessionStartedAt: startedWithCeilingAt(0) })

    await expect(refresh()).rejects.toBeInstanceOf(InvalidRefreshTokenError)

    expect(repository.tokens).toHaveLength(ONE_TOKEN)
    expect(repository.tokens[0]?.revokedAt).toBeNull()
    expect(outboxMessages.messages).toHaveLength(NO_MESSAGES)
  })

  it('refuses inside the grace window too', async () => {
    store({
      revokedAt: NOW,
      replacedBy: SUCCESSOR_ID,
      sessionStartedAt: startedWithCeilingAt(0),
    })
    storeSuccessor()
    clockReading = at(ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(InvalidRefreshTokenError)
  })

  it('counts the ceiling from createdAt for a row older than the column', async () => {
    // `inherit` adopts `createdAt` (NOW) as the start, so the ceiling is far away.
    store({ sessionStartedAt: null })

    await refresh()

    expect(repository.tokens[1]?.expiresAt).toEqual(at(TTL_MS))
  })
})
```

com `const ONE_TOKEN = 1` se ainda não existir, e o import de `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/refresh-token.spec.ts`
Expected: FAIL — "refuses a family whose ceiling has arrived" resolve em vez de lançar, e a variante da janela de graça idem. O de "caps the successor" já passa (a Task 2 cobriu), e tudo bem: ele guarda o comportamento.

- [ ] **Step 3: Write the implementation**

Em `#issueInto`, no início do método:

```ts
    // The family's ceiling can already be behind us even though this token is
    // still alive — the max lifetime was lowered after it was issued. Issuing
    // would mint a successor that is born expired, so the rotation is refused
    // instead, before anything is written.
    const sessionStartedAt = context.sessionStartedAt ?? now
    if (this.issuer.ceilingFor(sessionStartedAt).getTime() <= now.getTime()) {
      throw new InvalidRefreshTokenError()
    }
```

Nada mais muda. `inherit` já entrega um início não nulo; o `?? now` só satisfaz o tipo de `IssuedSessionContext`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit src/modules/auth` e `pnpm typecheck` e `pnpm lint`
Expected: PASS em tudo.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/use-cases/refresh-token.ts src/modules/auth/use-cases/refresh-token.spec.ts
git commit -m "feat(auth): refuse to rotate a family past its lifetime ceiling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: A prova ponta a ponta no Postgres real

**Files:**
- Modify: `tests/integration/refresh-token.spec.ts`

**Interfaces:**
- Consumes: o comportamento das Tasks 1–3 pela rota real; a coluna `sessionStartedAt` de `refresh_tokens`.
- Produces: nada além dos testes.

- [ ] **Step 1: Write the tests**

Constantes novas: `import { DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS } from '#modules/auth/config'`, mais `const MILLISECONDS_PER_SECOND = 1000`, `const ONE_DAY_MS = 86_400_000`, `const MAX_LIFETIME_MS = DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND`. Helper:

```ts
/** Moves the family's start so that its ceiling lands `remainingMs` from now. */
const startSessionWithCeilingIn = (remainingMs: number) =>
  db
    .update(refreshTokens)
    .set({ sessionStartedAt: new Date(Date.now() - MAX_LIFETIME_MS + remainingMs) })
```

(`Date.now()` é aceitável em teste de integração: o Postgres e o processo de teste compartilham o relógio, e a folga de um dia absorve qualquer desvio.) Novos casos, depois do teste `'warns the owner ONCE …'` da fatia 24:

```ts
  it('refuses to renew a session past its ceiling, without treating it as reuse', async () => {
    const { refreshToken } = (await login()).json()
    await startSessionWithCeilingIn(-ONE_DAY_MS)

    const refused = await refresh({ refreshToken })

    expect(refused.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
    expect(refused.json().error.code).toBe(INVALID_REFRESH_TOKEN_CODE)

    // Not reuse: the family is left alone and no notice is queued.
    const [row] = await db.select().from(refreshTokens)
    expect(row?.revokedAt).toBeNull()
    expect(await db.select().from(outboxMessages)).toHaveLength(NO_NOTICES)
  })

  it('renews a session before its ceiling and stamps the ceiling as the expiry', async () => {
    const { refreshToken } = (await login()).json()
    await startSessionWithCeilingIn(ONE_DAY_MS)

    const rotated = await refresh({ refreshToken })

    expect(rotated.statusCode).toBe(OK_STATUS_CODE)

    const successor = (await db.select().from(refreshTokens)).find(
      (row) => row.revokedAt === null,
    )
    expect(successor?.expiresAt).toEqual(
      new Date((successor?.sessionStartedAt?.getTime() ?? 0) + MAX_LIFETIME_MS),
    )
  })
```

com `const NO_NOTICES = 0`. O `startSessionWithCeilingIn` roda depois do `login()` e antes do `refresh()`, então `WHERE` não é necessário: há uma única linha viva no teste (o `beforeEach` limpa a tabela).

- [ ] **Step 2: Run tests and prove the first one bites**

Run: `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts`
Expected: PASS (11 anteriores + 2 novos).

Prova do problema: em `refresh-token.ts`, trocar temporariamente `<= now.getTime()` por `< 0` na guarda do `#issueInto`, rodar `-t "refuses to renew a session past its ceiling"` e ver **FAIL** com status 200 em vez de 401; **reverter** (`git diff src` deve voltar limpo).

- [ ] **Step 3: Run the whole integration file and commit**

Run: `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts`
Expected: PASS.

```bash
git add tests/integration/refresh-token.spec.ts
git commit -m "test(auth): prove a session past its ceiling cannot renew

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentação (§9 da spec)

**Files:**
- Modify: `docs/DECISIONS.md` (decisão 42, depois da 41 e antes do `---` da seção 7)
- Modify: `docs/TODO.md` (cabeçalho, linha #4, "Próxima fatia", nota da auditoria)

**Interfaces:** nenhuma.

- [ ] **Step 1: Decisão 42 no `DECISIONS.md`**

Inserir depois do "Spec: …" da decisão 41:

```markdown
### 42 — Teto absoluto de sessão

Fecha o item #4 de "Pendências do boilerplate". Os 60 dias do refresh token são
deslizantes: cada rotação emite um token novo que vale mais 60 dias. Quem renova
ao menos uma vez a cada 60 dias nunca reautentica, e uma sessão roubada e nunca
detectada (malware que lê o token e renova em segredo, sem replay de token
gasto) vive para sempre. A detecção de reuso só pega o roubo quando os dois lados
usam a mesma cadeia.

**O idle timeout já existia.** O TODO pedia "`max_lifetime` por família, com idle
timeout junto", mas o TTL deslizante é exatamente um idle timeout: token sem uso
por 60 dias morre. Faltava só o teto absoluto.

**O desenho.** Todo token novo vence em `min(agora + TTL, início da sessão +
REFRESH_TOKEN_MAX_LIFETIME_SECONDS)`, com padrão de 90 dias. O início é o
`session_started_at` que a decisão 38 já grava e que cada rotação herda, então
não há coluna nem migration. A regra mora em `RefreshToken.create`; o
`RefreshTokenIssuer` calcula o teto a partir do contexto da sessão.

**Sem ramo novo e sem código de erro novo.** O token que chega ao teto expira pelo
caminho de expiração que já existe: 401 `INVALID_REFRESH_TOKEN`, sem passar pela
detecção de reuso, sem revogar a família e sem gerar o aviso da decisão 41.

**Reduzir o teto derruba sessões vivas.** Um token ainda vivo pode ter o teto da
família no passado se a variável for reduzida depois. Emitir o sucessor o faria
nascer expirado, então `#issueInto` recusa com `InvalidRefreshTokenError` antes
de escrever. As duas ramificações de emissão da rotação passam por ali.

**Recusado.** *Código de erro próprio para "sessão encerrada por teto":* exigiria
um ramo que não é reuso nem expiração comum, e o cliente age do mesmo jeito em
todo 401. *Coluna `max_lifetime` por família:* o teto é global e o valor é
decisão de cada app derivado, por variável de ambiente.

**Custos aceitos.**

1. O cliente não distingue "teto de sessão" de qualquer outro 401, e o usuário é
   deslogado sem aviso prévio.
2. O cookie de refresh mantém `maxAge` de 60 dias a cada rotação, então perto do
   teto o cookie sobrevive ao token: o navegador manda um token expirado e toma o
   401 normal.
3. Sessões anteriores à decisão 38 ganham uma prorrogação única: o início nulo
   adota o `createdAt` da linha viva, e o teto conta dali.
4. Reduzir o teto derruba as sessões vivas na próxima rotação delas.

Spec: [`specs/2026-09-19-session-absolute-lifetime-design.md`](superpowers/specs/2026-09-19-session-absolute-lifetime-design.md).

```

- [ ] **Step 2: `TODO.md`**

(a) Antes do parágrafo "**Fatia 24 …", dentro do bloco `>` do cabeçalho:

```markdown
> **Fatia 25 (2026-09-19) entregou o teto absoluto de sessão** (decisão 42).
> Fecha o item #4 de "Pendências do boilerplate". Todo refresh token novo vence
> no menor entre o TTL deslizante e o início da sessão mais 90 dias
> (`REFRESH_TOKEN_MAX_LIFETIME_SECONDS`), sem coluna nova: o início é o
> `session_started_at` da decisão 38. O "idle timeout junto" que o item pedia já
> existia, era o próprio TTL deslizante.
>
```

(b) A linha #4 da tabela vira:

```markdown
| 4 | ~~Sessão sem teto absoluto~~ | — | **fechado pela fatia 25.** Todo token novo vence em `min(agora + TTL, início da sessão + teto)`, com padrão de 90 dias; o idle timeout já era o TTL deslizante. Decisão 42 |
```

(c) Em "Próxima fatia": depois da linha do "~~Notificar o dono …~~", trocar "O próximo é o #4, **sessão sem teto absoluto**, que depende de uma decisão de produto ainda não tomada." por "~~Sessão sem teto absoluto~~ — **fechado pela fatia 25** (decisão 42). Restam o #5 (checagem de senha vazada, que espera a escolha entre API externa e lista embarcada), o #6 (trilha de auditoria, só o mecanismo) e o #7 (`kid` no JWT)." Na frase da ordem da auditoria, "(5) trilha de auditoria e teto absoluto de sessão" vira "(5) trilha de auditoria e ~~teto absoluto de sessão~~, fechado pela fatia 25".

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint` (sozinho, ler o exit code) e `pnpm typecheck`.
Expected: PASS.

```bash
git add docs
git commit -m "docs(auth): record decision 42 and close the session ceiling item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Verificação final

- [ ] **Step 1:** `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` — cada um sozinho, exit 0; anotar a contagem de testes.
- [ ] **Step 2:** `pnpm test:integration` (Postgres, Redis e `REDIS_URL` de pé) — tudo verde.
- [ ] **Step 3:** `node .claude/skills/architecture-audit/scripts/audit-scan.mjs --base <HEAD antes da fatia>` e a leitura do passo 3 da skill `architecture-audit`: **0 achados** bloqueantes.
- [ ] **Step 4:** Chamar `superpowers:finishing-a-development-branch`; pelo `CLAUDE.md` global, logo após ela confirmar os testes, invocar `finish-with-review-pr`.
