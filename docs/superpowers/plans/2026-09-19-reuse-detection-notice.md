# Aviso de reuso detectado — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando a detecção de reuso de refresh token revoga uma família viva, gravar no outbox, na mesma transação, um aviso ao dono nomeando o aparelho, o início da sessão e o endereço de quem apresentou o token gasto.

**Architecture:** `revokeFamily` passa a devolver quantas linhas revogou; o ramo de reuso do `RefreshTokenUseCase` só grava o aviso quando essa contagem é maior que zero (um aviso por família comprometida, sem estado novo). O aviso é um `OutboxMessage` como os três existentes, montado por uma função pura nova em `notifications/emails.ts`.

**Tech Stack:** TypeScript, Vitest (projetos `unit` e `integration`), Drizzle/Postgres, Biome.

**Spec:** [`docs/superpowers/specs/2026-09-19-reuse-detection-notice-design.md`](../specs/2026-09-19-reuse-detection-notice-design.md)

## Global Constraints

- Todo código, string, log e comentário em **inglês**; só os `*.md` podem ser em português (`CLAUDE.md`).
- **Sem magic strings/numbers** inline: constantes nomeadas, `UPPER_SNAKE_CASE` (`CLAUDE.md`). Vale para testes também, no estilo dos arquivos vizinhos.
- Comentários explicam o código, nunca o processo: nada de "fatia 24", "a revisão achou", "o plano diz". Ponteiros para a spec/decisão são permitidos (`CLAUDE.md`).
- `REUSE_DETECTED` continua **retornado**, nunca lançado dentro da transação (spec D3).
- O texto do e-mail diz "suspicious"/"uso suspeito", **nunca** "stolen"/"theft" (spec D4).
- Sem coluna, sem migration, sem variável de ambiente nova.
- Rodar `pnpm` normalmente neste checkout. Se aparecer `ERR_PNPM_UNEXPECTED_STORE`, é o snap do VS Code: repetir com `--store-dir` apontando para o store antigo. Em um worktree com `node_modules` por symlink, **não** rodar `pnpm`: usar `node_modules/.bin/<ferramenta>` direto.
- Testes de integração precisam de Postgres e **`REDIS_URL`** definidos, como em qualquer ambiente novo.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/modules/auth/repositories/refresh-tokens-repository.ts` | Contrato: `revokeFamily` devolve a contagem | Modificar |
| `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts` | Fake: mesma contagem | Modificar |
| `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.spec.ts` | Teste do fake | Criar |
| `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts` | Adapter real: `.returning` e contagem | Modificar |
| `src/modules/auth/repositories/noop-auth-repos.ts` | Double: devolve 0 | Modificar |
| `tests/integration/drizzle-refresh-tokens-repository.spec.ts` | Contagem no Postgres real | Modificar |
| `src/modules/auth/notifications/emails.ts` (+ `.spec.ts`) | `reuseDetectedEmail` | Modificar |
| `src/modules/auth/use-cases/refresh-token.ts` (+ `.spec.ts`) | Regra de transição e gravação do aviso | Modificar |
| `src/modules/auth/container.ts` | Injeta `idGenerator` | Modificar |
| `tests/integration/refresh-token.spec.ts` | Dois replays, um aviso | Modificar |
| `docs/DECISIONS.md`, `docs/TODO.md`, specs e comentários | Emendas (§10 da spec) | Modificar |

---

### Task 1: `revokeFamily` devolve a contagem

**Files:**
- Modify: `src/modules/auth/repositories/refresh-tokens-repository.ts:35-36`
- Modify: `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.ts:32-36,62-`
- Modify: `src/modules/auth/infra/drizzle/drizzle-refresh-tokens-repository.ts:144-152`
- Modify: `src/modules/auth/repositories/noop-auth-repos.ts:22`
- Create: `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.spec.ts`
- Test: `tests/integration/drizzle-refresh-tokens-repository.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `IRefreshTokensRepository.revokeFamily(familyId: string, revokedAt: Date): Promise<number>` — o número de tokens que **esta chamada** revogou (0 quando a família já estava toda revogada ou não existe). Task 3 depende disso.

- [ ] **Step 1: Write the failing tests**

Criar `src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RefreshToken } from '#modules/auth/entities/refresh-token'
import { InMemoryRefreshTokensRepository } from '#modules/auth/infra/in-memory/in-memory-refresh-tokens-repository'

const USER_ID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'
const FAMILY_ID = '11112222-3333-4444-8555-666677778888'
const OTHER_FAMILY_ID = '99990000-1111-4222-8333-444455556666'
const NOW = new Date('2026-08-31T12:00:00.000Z')
const LATER = new Date('2026-08-31T12:00:05.000Z')
const EXPIRES_AT = new Date('2026-09-30T12:00:00.000Z')
const NO_TOKENS = 0
const TWO_TOKENS = 2

const token = (id: string, familyId: string, revokedAt: Date | null) =>
  RefreshToken.fromTrusted({
    id,
    userId: USER_ID,
    tokenHash: `digest:${id}`,
    familyId,
    expiresAt: EXPIRES_AT,
    revokedAt,
    replacedBy: null,
    createdAt: NOW,
    ip: null,
    deviceLabel: null,
    sessionStartedAt: null,
  })

describe('InMemoryRefreshTokensRepository.revokeFamily', () => {
  it('returns how many tokens it revoked, leaving another family alone', async () => {
    const repository = new InMemoryRefreshTokensRepository()
    repository.tokens.push(
      token('a', FAMILY_ID, null),
      token('b', FAMILY_ID, null),
      token('c', OTHER_FAMILY_ID, null),
    )

    const revoked = await repository.revokeFamily(FAMILY_ID, LATER)

    expect(revoked).toBe(TWO_TOKENS)
    expect(repository.tokens[2]?.revokedAt).toBeNull()
  })

  it('returns zero once the family is already revoked', async () => {
    const repository = new InMemoryRefreshTokensRepository()
    repository.tokens.push(token('a', FAMILY_ID, NOW))

    expect(await repository.revokeFamily(FAMILY_ID, LATER)).toBe(NO_TOKENS)
    expect(repository.tokens[0]?.revokedAt).toEqual(NOW)
  })

  it('returns zero for a family that does not exist', async () => {
    const repository = new InMemoryRefreshTokensRepository()

    expect(await repository.revokeFamily(FAMILY_ID, LATER)).toBe(NO_TOKENS)
  })
})
```

Em `tests/integration/drizzle-refresh-tokens-repository.spec.ts`, logo depois do teste `'revokeFamily does NOT push an already-revoked token forward'` (termina em `expect(stored?.revokedAt).toEqual(NOW)` / `})`), acrescentar:

```ts
  it('revokeFamily returns how many rows it revoked, and zero the second time', async () => {
    const counts: number[] = []

    await uow(async ({ refreshTokens: repo }) => {
      await repo.save(token(FAMILY_A, HASH_A))
      await repo.save(token(FAMILY_A, HASH_B))
      await repo.save(token(FAMILY_B, HASH_C))
      counts.push(await repo.revokeFamily(FAMILY_A, NOW))
      counts.push(await repo.revokeFamily(FAMILY_A, LATER))
    })

    expect(counts).toEqual([TWO_ROWS, NO_ROWS])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/infra/in-memory/in-memory-refresh-tokens-repository.spec.ts`
Expected: FAIL — `revokeFamily` resolve `undefined`, os `toBe` não batem.

Run: `pnpm vitest run --project integration tests/integration/drizzle-refresh-tokens-repository.spec.ts -t "revokeFamily returns"`
Expected: FAIL — `counts` é `[undefined, undefined]`.

- [ ] **Step 3: Write the implementation**

`refresh-tokens-repository.ts`, trocar o método e seu comentário:

```ts
  /**
   * Revokes every still-active token of one chain and returns how many it
   * revoked. Zero means the chain was already dead — that is what lets a caller
   * tell the revocation that just happened from a replay that found nothing
   * left to revoke.
   */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number>
```

`in-memory-refresh-tokens-repository.ts`:

```ts
  async revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    return this.#replace(
      (token) => token.familyId === familyId && token.revokedAt === null,
      { revokedAt },
    )
  }
```

e `#replace` passa a devolver o número de linhas trocadas (os outros chamadores ignoram o valor). Mudar a assinatura para `): number {`, declarar `let replaced = 0` antes do `forEach`, fazer `replaced += 1` logo depois do `if (!matches(token)) return` e terminar o método com `return replaced`. O corpo da reconstrução com `RefreshToken.fromTrusted` fica idêntico.

`drizzle-refresh-tokens-repository.ts`:

```ts
  async revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt })
      // `isNull` is not decoration: without it an already-revoked token would
      // have its `revokedAt` pushed forward, sliding the grace window of a
      // token that should already be dead. It is also what makes the count mean
      // "revoked by THIS call".
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id })

    return revoked.length
  }
```

`noop-auth-repos.ts`: trocar `revokeFamily: async () => {},` por `revokeFamily: async () => 0,`. Se o Biome reclamar do literal, extrair `const NO_TOKENS_REVOKED = 0` no topo do arquivo, como `deleteExpiredBefore: async () => 0` já é escrito ali — seguir o que o arquivo já faz.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit src/modules/auth` e `pnpm vitest run --project integration tests/integration/drizzle-refresh-tokens-repository.spec.ts`
Expected: PASS. Rodar também `pnpm typecheck` — `logout.ts` ignora o retorno e deve continuar compilando.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/repositories src/modules/auth/infra tests/integration/drizzle-refresh-tokens-repository.spec.ts
git commit -m "feat(auth): make revokeFamily report how many tokens it revoked

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `reuseDetectedEmail`

**Files:**
- Modify: `src/modules/auth/notifications/emails.ts`
- Test: `src/modules/auth/notifications/emails.spec.ts`

**Interfaces:**
- Consumes: `Email` (`#modules/auth/value-objects/email`), `EmailMessage` (`#shared/ports/email-sender`).
- Produces: `interface ReuseDetectedSession { deviceLabel: string | null; sessionStartedAt: Date; ip: string | null }` e `reuseDetectedEmail(to: Email, session: ReuseDetectedSession): EmailMessage`. `sessionStartedAt` é não-nulo: o use case já adota o `createdAt` da linha quando a coluna é nula (mesma regra de `inherit`), então um ramo "início desconhecido" seria código morto.

- [ ] **Step 1: Write the failing tests**

Em `emails.spec.ts`, acrescentar `reuseDetectedEmail` ao import e, ao fim do arquivo:

```ts
const REUSE_DEVICE = 'Chrome on Android'
const REUSE_STARTED_AT = new Date('2026-08-01T09:00:00.000Z')
const REUSE_IP = '198.51.100.42'
const UNKNOWN_DEVICE_TEXT = 'an unknown device'
const UNKNOWN_ADDRESS_TEXT = 'an unrecognized address'
const FORBIDDEN_CLAIMS = ['stolen', 'theft', 'null', 'undefined']

describe('reuseDetectedEmail', () => {
  it('addresses the owner and names the session and the address of the attempt', () => {
    const message = reuseDetectedEmail(TO, {
      deviceLabel: REUSE_DEVICE,
      sessionStartedAt: REUSE_STARTED_AT,
      ip: REUSE_IP,
    })

    expect(message.to).toBe(TO.value)
    expect(message.text).toContain(REUSE_DEVICE)
    expect(message.text).toContain(REUSE_STARTED_AT.toISOString())
    expect(message.text).toContain(REUSE_IP)
  })

  it('tells the owner what to do in both cases: not recognised, and it was them', () => {
    const text = reuseDetectedEmail(TO, {
      deviceLabel: REUSE_DEVICE,
      sessionStartedAt: REUSE_STARTED_AT,
      ip: REUSE_IP,
    }).text.toLowerCase()

    expect(text).toContain('reset your password')
    expect(text).toContain('sign in again')
  })

  it('says suspicious, never that anything was stolen', () => {
    const text = reuseDetectedEmail(TO, {
      deviceLabel: REUSE_DEVICE,
      sessionStartedAt: REUSE_STARTED_AT,
      ip: REUSE_IP,
    }).text.toLowerCase()

    expect(text).toContain('suspicious')
    for (const claim of FORBIDDEN_CLAIMS) expect(text).not.toContain(claim)
  })

  it('falls back to neutral wording for a missing label or address', () => {
    const message = reuseDetectedEmail(TO, {
      deviceLabel: null,
      sessionStartedAt: REUSE_STARTED_AT,
      ip: null,
    })

    expect(message.text).toContain(UNKNOWN_DEVICE_TEXT)
    expect(message.text).toContain(UNKNOWN_ADDRESS_TEXT)
    for (const claim of FORBIDDEN_CLAIMS) {
      expect(message.text.toLowerCase()).not.toContain(claim)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: FAIL — `reuseDetectedEmail is not a function` (ou erro de import).

- [ ] **Step 3: Write the implementation**

Em `emails.ts`, junto das outras constantes de assunto:

```ts
const REUSE_DETECTED_SUBJECT = 'A session on your account was signed out'
const UNKNOWN_DEVICE = 'an unknown device'
const UNRECOGNIZED_ADDRESS = 'an unrecognized address'
```

e, depois de `googleAccountLinkedEmail` (mesmo bloco de avisos):

```ts
export interface ReuseDetectedSession {
  deviceLabel: string | null
  sessionStartedAt: Date
  /** Who PRESENTED the spent token — possibly the owner's own client. */
  ip: string | null
}

/**
 * Sent when a spent refresh token is presented again and the family it belonged
 * to is revoked. The address is the one that presented the token, which can be
 * an attacker or the owner's own client retrying outside the grace window, so
 * the text says "suspicious" and covers both readings.
 */
export function reuseDetectedEmail(
  to: Email,
  session: ReuseDetectedSession,
): EmailMessage {
  const device = session.deviceLabel ?? UNKNOWN_DEVICE
  const address = session.ip ?? UNRECOGNIZED_ADDRESS

  return {
    to: to.value,
    subject: REUSE_DETECTED_SUBJECT,
    text:
      'A sign-in credential from one of your sessions was used a second time, ' +
      'which is suspicious. We signed that session out: it was on ' +
      `${device} and started at ${session.sessionStartedAt.toISOString()}.\n\n` +
      `The attempt came from ${address}.\n\n` +
      'If you do not recognise this, reset your password immediately. If it ' +
      'was you, for instance an app that misbehaved, sign in again and no ' +
      'further action is needed.',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit src/modules/auth/notifications/emails.spec.ts`
Expected: PASS (todos os `describe` do arquivo).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/notifications
git commit -m "feat(auth): add the reuse detected notice e-mail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: O ramo de reuso grava o aviso na transição

**Files:**
- Modify: `src/modules/auth/use-cases/refresh-token.ts`
- Modify: `src/modules/auth/container.ts:246-253`
- Test: `src/modules/auth/use-cases/refresh-token.spec.ts`

**Interfaces:**
- Consumes: `revokeFamily(...): Promise<number>` (Task 1); `reuseDetectedEmail(to, { deviceLabel, sessionStartedAt, ip })` (Task 2); `OutboxMessage.create({ id, message, now })`; `IIdGenerator.generate(): string`; `AuthRepos.users.findById`, `AuthRepos.outboxMessages.save`.
- Produces: construtor `RefreshTokenUseCase(uow, issuer, tokenSigner, tokenDigest, clock, idGenerator: IIdGenerator, graceWindowMs)` — `idGenerator` entra **antes** de `graceWindowMs`, para os primitivos ficarem por último.

- [ ] **Step 1: Write the failing tests**

Em `refresh-token.spec.ts`:

1. Imports novos: `User` (`#modules/auth/entities/user`), `InMemoryOutboxMessagesRepository`, `InMemoryUsersRepository` (`#modules/auth/infra/in-memory/...`), `Email` (`#modules/auth/value-objects/email`).
2. Constantes novas junto das outras:

```ts
const OWNER_EMAIL = 'joao@example.com'
const NEW_GENERATED_ID_PREFIX = 'notice-'
const NO_MESSAGES = 0
const ONE_MESSAGE = 1
```

3. Variáveis e `build()`:

```ts
let usersRepository: InMemoryUsersRepository
let outboxMessages: InMemoryOutboxMessagesRepository
```

Em `build()`, criar `usersRepository = new InMemoryUsersRepository()` e `outboxMessages = new InMemoryOutboxMessagesRepository()`, trocar o `makeUow` por `makeUow({ ...noopAuthRepos(), refreshTokens: repository, users: usersRepository, outboxMessages })` e passar o gerador antes da janela:

```ts
    { now: () => clockReading },
    { generate: () => `${NEW_GENERATED_ID_PREFIX}${nextValue()}` },
    GRACE_WINDOW_MS,
```

4. No teste `'COMMITS the family revocation…'`, o `new RefreshTokenUseCase(` também ganha `{ generate: () => 'id-notice' },` antes de `GRACE_WINDOW_MS`.
5. `store` ganha `deviceLabel?: string | null` (em `props`) e usa `props.deviceLabel === undefined ? DEVICE_LABEL : props.deviceLabel`, como já faz com `sessionStartedAt`.
6. Helper e testes novos, no fim do arquivo:

```ts
const storeOwner = () =>
  usersRepository.users.push(
    User.fromTrusted({
      id: USER_ID,
      email: Email.fromTrusted(OWNER_EMAIL),
      passwordHash: 'irrelevant-hash',
      emailVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )

const PAST_GRACE = GRACE_WINDOW_MS + ONE_MILLISECOND

describe('RefreshTokenUseCase — reuse notice', () => {
  it('queues ONE notice for the owner naming the session and the request address', async () => {
    storeOwner()
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(PAST_GRACE)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(outboxMessages.messages).toHaveLength(ONE_MESSAGE)
    const [notice] = outboxMessages.messages
    expect(notice?.to).toBe(OWNER_EMAIL)
    expect(notice?.text).toContain(DEVICE_LABEL)
    expect(notice?.text).toContain(SESSION_STARTED_AT.toISOString())
    // The address that PRESENTED the token, not the one stored on the row.
    expect(notice?.text).toContain(ROTATION_IP)
    expect(notice?.text).not.toContain(ORIGINAL_IP)
  })

  it('queues nothing when the same spent token is replayed against a dead family', async () => {
    storeOwner()
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(PAST_GRACE)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)
    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(outboxMessages.messages).toHaveLength(ONE_MESSAGE)
  })

  it('queues nothing for a token revoked by logout, where nothing was left to revoke', async () => {
    storeOwner()
    store({ revokedAt: NOW })
    clockReading = at(ONE_MILLISECOND)

    await expect(refresh()).rejects.toBeInstanceOf(RefreshTokenReusedError)

    expect(outboxMessages.messages).toHaveLength(NO_MESSAGES)
  })

  it('queues nothing inside the grace window, where the family is not revoked', async () => {
    storeOwner()
    store({ revokedAt: NOW, replacedBy: SUCCESSOR_ID })
    storeSuccessor()
    clockReading = at(ONE_MILLISECOND)

    await refresh()

    expect(outboxMessages.messages).toHaveLength(NO_MESSAGES)
  })

  it('adopts the row createdAt for a start that predates the column, and copes with no label or address', async () => {
    storeOwner()
    store({
      revokedAt: NOW,
      replacedBy: SUCCESSOR_ID,
      sessionStartedAt: null,
      deviceLabel: null,
    })
    storeSuccessor()
    clockReading = at(PAST_GRACE)

    await expect(
      useCase.execute({ refreshToken: CURRENT_TOKEN, ip: null }),
    ).rejects.toBeInstanceOf(RefreshTokenReusedError)

    const [notice] = outboxMessages.messages
    expect(notice?.text).toContain(NOW.toISOString())
    expect(notice?.text).toContain('an unknown device')
    expect(notice?.text).toContain('an unrecognized address')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/modules/auth/use-cases/refresh-token.spec.ts`
Expected: FAIL — o primeiro teste novo vê `0` mensagens (nada é gravado ainda) e o argumento extra do construtor desalinha `graceWindowMs` (o `typecheck` também falha). O de "logout" e o de "graça" passam por acidente, e tudo bem: eles guardam o comportamento depois da mudança.

- [ ] **Step 3: Write the implementation**

`refresh-token.ts`:

1. Imports: `OutboxMessage` (`#modules/auth/entities/outbox-message`), `reuseDetectedEmail` (`#modules/auth/notifications/emails`), `IIdGenerator` (`#shared/ports/id-generator`).
2. Construtor: acrescentar `private readonly idGenerator: IIdGenerator,` entre `clock` e `graceWindowMs`.
3. O callback passa a desestruturar `{ refreshTokens, users, outboxMessages }`.
4. Substituir, dentro de `if (!withinGrace) {`, a chamada `await refreshTokens.revokeFamily(current.familyId, now)` e manter o comentário do `RETURNED, not thrown`. O bloco fica:

```ts
        if (!withinGrace) {
          const revoked = await refreshTokens.revokeFamily(current.familyId, now)

          // Only the call that actually killed the family warns the owner. The
          // spent token stays spent forever, so every replay lands in this
          // branch and finds nothing left to revoke: warning on those would let
          // whoever holds an old token flood the owner's inbox.
          if (revoked > 0) {
            const owner = await users.findById(current.userId)

            // A row in `refresh_tokens` always has an owner (the cascade removes
            // the tokens with the account), so `null` is a type guard, not a
            // case. It must not throw: that would roll back the revocation.
            if (owner !== null) {
              await outboxMessages.save(
                OutboxMessage.create({
                  id: this.idGenerator.generate(),
                  message: reuseDetectedEmail(owner.email, {
                    deviceLabel: current.deviceLabel,
                    sessionStartedAt: current.sessionStartedAt ?? current.createdAt,
                    ip: command.ip,
                  }),
                  now,
                }),
              )
            }
          }

          // RETURNED, not thrown, and this is the whole point: … (comentário existente, intacto)
          return REUSE_DETECTED
        }
```

5. No docstring da classe, acrescentar uma frase: "The notice to the owner is written in the same transaction as the revocation (decision 41)."
6. `container.ts`: dentro de `new RefreshTokenUseCase(`, inserir `idGenerator,` entre `clock,` e `config.REFRESH_TOKEN_GRACE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit src/modules/auth` e `pnpm typecheck` e `pnpm lint`
Expected: PASS em tudo. Se o Biome reformatar, `pnpm lint:fix` e reconferir o diff.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth
git commit -m "feat(auth): warn the owner when reuse detection revokes a live family

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: A prova ponta a ponta — dois replays, um aviso

**Files:**
- Modify: `tests/integration/refresh-token.spec.ts`

**Interfaces:**
- Consumes: o comportamento das Tasks 1–3, pela rota real.
- Produces: nada além do teste.

- [ ] **Step 1: Write the failing test**

Imports: `import { outboxMessages } from '#modules/auth/infra/drizzle/schema/outbox-messages'`. Constantes: `const REUSE_NOTICE_SUBJECT = 'A session on your account was signed out'` e `const ONE_NOTICE = 1` (o assunto é o contrato de fio, escrito por extenso como os outros). No `beforeEach`, antes do `arrangeAccount`, `await db.delete(outboxMessages)`. Depois do teste `'detects reuse past the window and revokes the whole family'`:

```ts
  it('warns the owner ONCE however many times the spent token is replayed', async () => {
    const { refreshToken } = (await login()).json()
    await refresh({ refreshToken })

    await ageOutTheGraceWindow()

    // Three replays of the same spent token: the first kills the family, the
    // other two find nothing left to revoke and must not queue another notice.
    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      const reused = await refresh({ refreshToken })
      expect(reused.json().error.code).toBe(REFRESH_TOKEN_REUSED_CODE)
    }

    const notices = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.subject, REUSE_NOTICE_SUBJECT))

    expect(notices).toHaveLength(ONE_NOTICE)
    expect(notices[0]?.to).toBe(EMAIL)
  })
```

com `const REPLAY_ATTEMPTS = 3`, e `import { eq } from 'drizzle-orm'` junto do `sql` já importado.

- [ ] **Step 2: Run test to verify it… passes, then prove it would fail**

Run: `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts -t "warns the owner ONCE"`
Expected: PASS.

Prova do problema (o teste só vale se falhar sem a regra): trocar temporariamente `if (revoked > 0) {` por `if (true) {` em `refresh-token.ts`, rodar o mesmo comando e ver **FAIL** com `expected length 1, got 3`; **reverter** a troca (`git diff src` deve voltar limpo).

- [ ] **Step 3: Run the whole integration file**

Run: `pnpm vitest run --project integration tests/integration/refresh-token.spec.ts`
Expected: PASS — o `db.delete(outboxMessages)` no `beforeEach` não afeta os outros testes.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/refresh-token.spec.ts
git commit -m "test(auth): prove repeated replays of a spent token queue a single notice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentação (§10 da spec)

**Files:**
- Modify: `docs/DECISIONS.md` (nova decisão 41, depois da 40 e antes do `---` que precede a seção 7)
- Modify: `docs/TODO.md` (cabeçalho, linha #3 da tabela, "Próxima fatia")
- Modify: `docs/superpowers/specs/2026-09-19-reuse-detection-notice-design.md` (§5.2)
- Modify: `docs/superpowers/specs/2026-09-15-transactional-outbox-design.md:52`
- Modify: `src/modules/auth/repositories/unit-of-work.ts:26`, `src/modules/auth/entities/outbox-message.ts:40`

**Interfaces:** nenhuma.

- [ ] **Step 1: Decisão 41 no `DECISIONS.md`**

Inserir após o "Spec: …" da decisão 40:

```markdown
### 41 — Aviso ao dono quando a detecção de reuso dispara

Fecha o item #3 de "Pendências do boilerplate". A detecção de reuso revogava a
família e respondia 401, e o único rastro era uma linha de log: o dono só
descobria pelo app mandando-o para o login. Troca e recuperação de senha e o
vínculo do Google já avisam; o roubo de sessão detectado, que é a única defesa
que sobra quando o atacante já tem a sessão, não avisava.

**O aviso sai só na transição.** O token gasto continua gasto para sempre, então
cada reapresentação cai no mesmo ramo. Um aviso gravado ali sem condição vira um
e-mail por tentativa, e quem tem um token velho passaria a encher a caixa do
dono. `revokeFamily` passou a devolver quantas linhas revogou; só maior que zero
grava o aviso. Um replay contra a família já morta revoga zero e não grava.
`logout`, `logout-all` e as trocas de senha ficam sem aviso pelo mesmo caminho:
foi o dono quem revogou, ou ele já foi avisado por outro e-mail.

**Pelo outbox, na mesma transação da revogação**, pela razão da decisão 33: uma
queda entre a revogação e o envio não perde o aviso, e o SMTP não prende a
requisição. `REUSE_DETECTED` continua retornado e não lançado, senão o rollback
desfaria a revogação e o aviso.

**O texto diz "suspeito", nunca "roubo".** O endereço é o de quem apresentou o
token gasto, que pode ser o ladrão ou o cliente do próprio dono num retry fora da
janela de graça. O e-mail nomeia o aparelho e o início da sessão derrubada (da
linha do token) e esse endereço, e cobre os dois casos.

**Recusado.** *Cooldown com "último aviso enviado":* exige estado novo e não
compra segurança, porque a família já está morta.

**Custos aceitos.**

1. Um segundo ataque à mesma família não avisa de novo.
2. O endereço do aviso pode ser o do próprio dono.
3. O e-mail leva um IP a um endereço cadastrado: o mesmo dado que
   `GET /auth/sessions` já devolve ao dono (decisão 38).
4. Uma família cujo último token expirou sem ser revogado ainda conta 1 na
   primeira reapresentação e avisa, uma vez.
5. O aviso herda as garantias do outbox: pode chegar atrasado, e uma queda entre
   o `send` e o registro pode repeti-lo (decisão 40).

Spec: [`specs/2026-09-19-reuse-detection-notice-design.md`](superpowers/specs/2026-09-19-reuse-detection-notice-design.md).
```

- [ ] **Step 2: `TODO.md`**

(a) Antes do parágrafo "**Fatia 23 …", dentro do bloco `>` do cabeçalho, inserir:

```markdown
> **Fatia 24 (2026-09-19) entregou o aviso ao dono quando a detecção de reuso
> dispara** (decisão 41). Fecha o item #3 de "Pendências do boilerplate". A
> revogação da família e o aviso vão na mesma transação, pelo outbox, e o aviso
> só sai na transição: um replay contra a família já morta revoga zero linhas e
> não grava nada, então um token velho não serve para encher a caixa do dono. O
> texto diz "suspeito", nunca "roubo", porque o endereço pode ser o do próprio
> cliente do dono.
>
```

(b) Linha #3 da tabela vira:

```markdown
| 3 | ~~Notificar o dono quando a detecção de reuso dispara~~ | — | **fechado pela fatia 24.** `revokeFamily` devolve a contagem e só a chamada que matou a família grava o aviso, pelo outbox, na mesma transação. Decisão 41 |
```

(c) Em "Próxima fatia" (por volta da linha 294), depois de "~~Dispatch do outbox sem trava~~ — …", trocar "O próximo é o #3, **notificar o dono quando a detecção de reuso dispara**, o primeiro consumidor natural de um aviso que precisa sair uma vez só." por: "~~Notificar o dono quando a detecção de reuso dispara~~ — **fechado pela fatia 24** (decisão 41). O próximo é o #4, **sessão sem teto absoluto**, que depende de uma decisão de produto ainda não tomada." E na frase da ordem da auditoria (linha ~301) trocar "e notificação de reuso, que é o #3 da fila do boilerplate" por "e ~~notificação de reuso~~, fechada pela fatia 24".

- [ ] **Step 3: Emendas nas specs e nos comentários**

- Spec da fatia, §5.2: trocar `sessionStartedAt: Date | null` por `sessionStartedAt: Date` e a frase dos nulos por "Nulos de rótulo e de endereço viram 'an unknown device' e 'an unrecognized address'; o início nulo já foi resolvido pelo use case, que adota o `createdAt` da linha, como `inherit`". Na §3.4, na linha do `sessionStartedAt`, acrescentar "(o use case resolve o nulo antes de chamar o template)" e ajustar "Os três podem ser `null`" para "O rótulo e o endereço podem ser `null`".
- `2026-09-15-transactional-outbox-design.md`, logo depois do item 1 do §52: acrescentar a emenda "**Emenda (fatia 24):** um quarto aviso, `reuseDetectedEmail`, passou a usar o outbox — decisão 41."
- `unit-of-work.ts:26`: "the three post-commit notices (password changed, password reset completed, Google account linked)" → "the four post-commit notices (password changed, password reset completed, Google account linked, refresh token reuse detected)".
- `outbox-message.ts:40`: "the three e-mails it exists for (`passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail`) are notices" → "the four e-mails it exists for (`passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail`, `reuseDetectedEmail`) are notices".

- [ ] **Step 4: Verify and commit**

Run: `pnpm lint && pnpm typecheck` (docs não passam pelo lint, mas os `.ts` sim).
Expected: PASS.

```bash
git add docs src
git commit -m "docs(auth): record decision 41 and close the reuse notice item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Verificação final

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test:unit` — tudo verde; anotar a contagem de testes.
- [ ] **Step 2:** `pnpm test:integration` (Postgres, Redis e `REDIS_URL` de pé) — tudo verde.
- [ ] **Step 3:** Rodar o scanner de arquitetura do repositório (skill `architecture-audit`): **0 achados**. O `refresh-token.ts` agora importa `notifications/emails`; conferir que isso não fere a fronteira do use-case (o `change-password.ts` já importa o mesmo módulo, então é o precedente).
- [ ] **Step 4:** Chamar `superpowers:finishing-a-development-branch`; pelo `CLAUDE.md` global, logo após ela confirmar os testes, invocar `finish-with-review-pr`.
