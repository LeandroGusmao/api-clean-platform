# Fatia 3 — `POST /auth/login` + guard + `GET /auth/me`

> **Status:** desenho aprovado em 2026-08-27, pronto para virar plano de implementação.
> **Fatia anterior:** [`2026-08-26-register-user-design.md`](2026-08-26-register-user-design.md)

## 1. Objetivo

Entregar autenticação: um usuário troca e-mail e senha por um access JWT, e uma
rota protegida prova que o token vale alguma coisa. É a primeira execução da
decisão 11 — a metade *stateless* dela.

Cinco decisões escritas há semanas estreiam aqui:

| Decisão | Enunciado | Situação antes desta fatia |
|---|---|---|
| 11 | Access JWT curto + refresh opaco rotativo | nenhum token existe |
| 12 | Bearer na API | nenhum transporte de credencial existe |
| 14 | Módulo declara env, boot valida tudo de uma vez | `auth` não tem `config.ts` |
| 21 | `ITokenSigner` no puro, adapter em `infra/providers/` | só `IHashProvider` com `hash()` |
| — | Guard compartilhado sem acoplamento entre módulos | decisão **em aberto** (§6 do `DECISIONS.md`) |

A última linha não é uma decisão numerada: é uma decisão **em aberto** que esta
fatia fecha. Ver §4.3.

## 2. Escopo

### Entra

- `POST /auth/login` — e-mail + senha, devolve `200 { accessToken }`.
- Guard de `Authorization: Bearer`, genérico e reutilizável por qualquer módulo.
- `GET /auth/me` — o perfil do usuário autenticado. Existe para dar propósito ao
  token: sem rota protegida, o guard só seria exercitado por teste.
- `modules/auth/config.ts` — `JWT_SECRET` e `ACCESS_TOKEN_TTL_SECONDS`.

### Não entra, e por quê

- **Refresh token** — tabela `refresh_tokens`, rotação, janela de graça de 30s,
  detecção de reuso, revogação de família, trava de linha, Unit of Work (decisão
  22) e cookie `httpOnly` (decisão 12). Fatia 4 inteira. Ver §3.
- **`POST /auth/logout`** — não há o que revogar sem estado no servidor. Nasce com
  a família de refresh que ele revoga.
- **Gate de e-mail verificado** — ver §14.1.
- **Rate limiting** — ver §14.3.

### A ordem das fatias, e a contradição que ela corrige

A spec do register diz, na linha 37, que verificação de e-mail é a "próxima
fatia". As linhas 51-54 da **mesma seção** dizem o contrário, e com o argumento
que venceu:

> marcar `email_verified_at` só tem efeito se alguém **recusar** quem não
> verificou, e quem recusa é o login. Construir a verificação antes do login
> entrega uma trava que não tranca porta nenhuma — uma feature de segurança
> inerte, que é pior que uma ausente porque parece proteção.

Esta fatia é o login. A linha 37 daquela spec é corrigida como parte desta fatia
(§16), para a contradição não sobreviver ao arquivo.

**O provedor de e-mail nunca foi impeditivo.** Quando a verificação chegar,
`IMailer` fica na camada pura do módulo e a implementação em `infra/providers/`,
como toda porta desde a decisão 21. Não é motivo para adiar nada.

## 3. O corte: por que o refresh não vem junto

Três cortes foram avaliados.

| Corte | Custo |
|---|---|
| login + guard + `/auth/me`, só access | **escolhido** |
| idem, já emitindo access + refresh | a tabela `refresh_tokens` nasceria **antes das regras que a governam**, e o login emitiria um refresh que não se troca por nada — inerte, exatamente o defeito que ordenou esta fatia antes da verificação |
| ciclo inteiro (login + refresh + logout) | a maior fatia do projeto; a própria decisão 11 avisa que *"errar a rotação é bug de segurança sutil"* |

**O que decidiu:** cada fatia precisa ser coerente sozinha, e nada pode nascer
inerte. O corte escolhido entrega um login que funciona fim a fim e um guard
exercitado por cliente real.

**Custo aceito:** o corpo da resposta do login ganha campos na fatia 4. É aditivo
e compatível — ver §4.2, que é onde esse custo foi transformado em critério.

## 4. Decisões tomadas neste brainstorming

### 4.1 — Guard: `preHandler` + `WeakMap`, nunca `declare module 'fastify'`

O byteflow decora `app.authenticate` e tipa `request.user` via
`declare module 'fastify'`. Aqui não, e o motivo é a decisão 23, que rejeitou
exatamente essa construção para o container: um tipo **global e ambiente** que
todo módulo enxerga, alcançado por **acesso a propriedade e não por import**, o
que nenhum lint de fronteira pega.

Aplicada ao principal, a consequência é pior do que alcançar o módulo errado:

```ts
// Com `declare module`, isto compila em QUALQUER handler de QUALQUER módulo:
request.user = { id: request.body.userIdQueOClienteMandou }
```

Um `preHandler` não devolve valor ao handler, então o principal precisa ser
anexado em algum lugar. A escolha é um `WeakMap` **não exportado**, dentro do
arquivo do guard:

```ts
// src/infra/http/auth-guard.ts
const principals = new WeakMap<FastifyRequest, Principal>()
//    ^ not exported: the guard is the only writer in the system

export function makeAuthGuard(verify: VerifyAccessToken): preHandlerHookHandler
export function getPrincipal(request: FastifyRequest): Principal
```

`getPrincipal` devolve `Principal` **não-opcional**. A invariante "rota atrás do
guard sempre tem principal" fica codificada em um lugar, em vez de virar um `?`
que toda rota do sistema carrega para sempre.

**Chamá-lo em rota não guardada é erro de programação, e o erro lançado diz isso.**
Não é `InvalidAccessTokenError`: um 401 ali responderia igual a um token expirado,
e quem esqueceu o `preHandler` iria caçar no cliente enquanto a linha some no
ruído de tráfego normal. É um `Error` simples, que cai no ramo genérico do
`error-handler.ts` — o tratamento que aquele arquivo já documenta para erro de
programação — e portanto **500, logado com `traceId`, sem vazar a mensagem**
(verificado, §13). Fecha fechado dos dois jeitos: o handler não roda em nenhum
dos casos, então a escolha é puramente de diagnóstico.

**Não é mais seguro contra atacante externo** — a superfície de fora é idêntica
nas duas opções, e nenhuma das duas impede registrar uma rota **sem** o guard. A
diferença é superfície de adulteração interna, e só ela.

**Custo aceito:** um `WeakMap` é um mecanismo a mais para explicar. Explicado
aqui, ele custa um parágrafo; o `request.user?` custaria uma checagem defensiva em
cada endpoint de cada módulo futuro.

### 4.2 — `POST /auth/login` devolve `{ accessToken }`, sem `user`

O byteflow devolve `{ accessToken, user }` para poupar um round-trip. Aqui não,
por três razões, e a terceira decide.

1. **O round-trip não bloqueia.** Depois do login o cliente renderiza uma home que
   busca os próprios dados; `/auth/me` sai em paralelo com essas chamadas, não à
   frente delas.
2. **O byteflow é produto; este repo é molde.** Um produto sabe o próprio modelo
   de usuário e otimiza a própria tela de login. Um boilerplate não sabe qual app
   será derivado dele, e embutir o modelo de usuário no corpo do login decide por
   N apps futuros uma questão que só eles têm informação para decidir.
3. **Reversibilidade.** Acrescentar `user` ao corpo depois é aditivo e compatível;
   remover é quebra de contrato em todo app já derivado. Entre duas opções
   defensáveis, começa-se pela que se desfaz.

**Ganho colateral que é o motivo de `/auth/me` existir nesta fatia.** Com `user`
no login, `/auth/me` seria decorativo — o cliente já teria o usuário e poderia
nunca chamar `/me`, deixando o guard exercitado só por teste. Sem, `/auth/me`
fica no caminho crítico de todo login de todo app derivado.

### 4.3 — O guard é infra global genérica, e isso fecha uma decisão em aberto

O `DECISIONS.md` §6 registra:

> **Superfície pública do módulo — subiu de prioridade.** `ensure-authenticated`
> é artefato do módulo `auth`, mas **todos os outros módulos consomem** […]
> enquanto isso não fecha, o único middleware compartilhado da base fica
> **formalmente proibido pela regra de fronteira**.

Com o verificador **injetado**, o problema não é resolvido — ele deixa de existir:

```
main/app.ts  (composition)
    │  makeAuthGuard(container.auth.verifyAccessToken)
    ▼
infra/http/auth-guard.ts   importa: fastify · #shared/errors/app-error
    │                      NÃO importa: nada de #modules/*
    ▼  preHandler
modules/auth/infra/http/endpoints/me.ts     module-infra ──▶ global-infra  ✓
```

Nenhum módulo importa `auth` para se proteger. A exceção declarada no lint que a
auditoria de 2026-08-20 previu deixa de ser necessária.

**Consequência sobre onde mora o erro do guard.** `InvalidAccessTokenError` fica
no arquivo do guard, em `src/infra/http/`, e não em `modules/auth/errors/`. Pô-lo
no módulo faria toda rota protegida de todo módulo futuro depender de `auth` —
reabrindo o acoplamento que o parágrafo acima acabou de desfazer.

Ele estende **`UnauthorizedError`**, não `AppError` direto. Isto não é detalhe de
estilo: o `error-handler.ts` ramifica pelas **seis categorias**, e trata um
`AppError` fora delas como erro de programação que cai no ramo genérico —
`extends AppError` produziria **500**, não 401.

### 4.4 — `verifyAccessToken` sai do container e não é use case

É `signer.verify` amarrado, publicado na fatia do container para o composition
root montar o guard. Não vira `VerifyAccessSessionUseCase` porque não haveria o
que orquestrar.

**É a divergência deliberada do byteflow.** Lá, `VerifyAccessSession` lê o usuário
a cada request protegida e compara `iat` contra `tokensValidAfter`, comprando
revogação instantânea. A decisão 11 já pesou e recusou esse trade-off:

> a rota autenticada não toca o banco […] a latência de revogação é o TTL do
> access (1h). B teria latência zero, mas ao custo de uma leitura por request.

Copiar o byteflow aqui reintroduziria, por dentro, a opção B que a decisão 11
descartou.

### 4.5 — Timing: o dummy hash é do provider, não do use case

O byteflow guarda um `DUMMY_PASSWORD_HASH` literal na camada pura. Aqui o
artefato argon2 nasce no adapter, com **os parâmetros do próprio adapter**:

```ts
// modules/auth/providers/hash-provider.ts        (PURO)
export interface IHashProvider {
  hash(plain: string): Promise<string>
  compare(plain: string, hashed: string): Promise<boolean>
  /**
   * A hash produced with THIS provider's own parameters, to compare against
   * when there is no user. Without it, a missing email returns before paying
   * the hashing cost and the response time answers "does this account exist?".
   */
  readonly dummyHash: string
}
```

**O defeito que isso evita:** com a constante no puro, mudar `m`/`t`/`p` no
adapter faz o custo deixar de equalizar, e **nada quebra** — nenhum teste percebe.
Com o artefato no adapter, ele reequaliza sozinho. Verificado: `hashSync` emite os
mesmos parâmetros que `hash` (§13).

### 4.6 — `User.fromTrusted`, pelo vocabulário que o repo já tem

`User.create` força `emailVerifiedAt: null` e `createdAt === updatedAt`;
rehidratar uma linha precisa dos seis campos. O nome segue o precedente vivo de
`Email.fromTrusted` — mesma semântica: *isto já foi validado quando foi escrito,
revalidar na leitura quebraria linhas que eram válidas.*

### 4.7 — Login não valida a política de senha, só presença

```ts
password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
```

Dois motivos, e o segundo é o que morde: um `400 VALIDATION_ERROR` é
**distinguível** de um `401`, então aplicar a política aqui contaria ao atacante
que o palpite falhou nas **regras**, não na senha — um oráculo de graça. E uma
conta criada sob política mais frouxa precisa continuar conseguindo entrar.

O `max` fica, por outro motivo: sem teto, um corpo de 10 MB vira argon2 sobre
10 MB.

### 4.8 — Claims mínimas: `sub`, `iat`, `exp`

Sem `jti`. Ele só serve para *denylist*, que a decisão 11 recusou, e o repo já tem
a regra — a mesma que fez `IHashProvider` nascer só com `hash()`: um contrato
nasce com o que tem consumidor.

**Sem `clockTolerance`** (default 0), decidido e não herdado: assinatura e
verificação acontecem no mesmo processo, então não há deriva a tolerar. Passa a
importar se réplicas divergirem por NTP — e aí é um campo de config, não uma
constante escondida.

### 4.9 — `algorithms: ['HS256']` é carga, não enfeite

Verificado (§13): sem o pin, um token assinado **HS512 com o mesmo segredo**
verifica normalmente. Com o pin, `JOSEAlgNotAllowed`.

### 4.10 — `jose`, pinado em `6.2.3`

Única dependência de produção nova da fatia, em versão exata e sem caret, como o
`ARCHITECTURE.md` §4 exige de toda dependência.

**Verificado:** `dependencies: {}` — zero dependências transitivas — e
`"type": "module"`, ESM nativo. Num repo com pnpm estrito e ESM, isso significa
nenhuma superfície nova de *phantom dependency* e nenhum wrapper de interop.

**Descartado — `@fastify/jwt`:** amarraria a emissão do token ao Fastify. A decisão
10 exige que o grafo seja montado **sem** framework HTTP, para que `worker.ts` e
`cron.ts` existam depois sem duplicar wiring; um `ITokenSigner` que precisa de uma
instância Fastify quebra isso na raiz. É desqualificação estrutural, não
preferência.

**Descartado — `jsonwebtoken`:** o adapter teria que embrulhar uma API de callback
e o pacote não é ESM nativo. Nenhum ganho compensa isso quando o contrato exposto é
`sign`/`verify`, que o `jose` já entrega com `Promise`.

### 4.11 — A fatia da config chega por tipagem estrutural

A decisão 23 pede que o módulo receba *"a fatia da config em vez do `Env`
global"*. Sai de graça:

```ts
export function makeAuthContainer(db: Database, config: AuthConfig) { … }

// main/container.ts passa o Env inteiro; o módulo só ENXERGA os campos dele.
export function makeContainer(db: Database, env: Env) {
  return { auth: makeAuthContainer(db, env) }
}
```

Nenhum código de recorte, e alcançar `env.DATABASE_URL` de dentro de `auth` é erro
de compilação.

## 5. Fluxo ponta a ponta

```
POST /auth/login  { email, password }
  │
  ├─ Zod: e-mail válido, senha presente e ≤ 128        falha → 400 VALIDATION_ERROR
  ▼
LoginUserUseCase
  ├─ Email.create(raw)              inalcançável por HTTP — ver nota abaixo
  ├─ usersRepository.findByEmail(email)  ──▶ User | null
  ├─ hashed = user?.passwordHash ?? hashProvider.dummyHash
  ├─ matches = await hashProvider.compare(password, hashed)   ← SEMPRE roda
  ├─ if (user === null || !matches) throw InvalidCredentialsError   → 401
  ▼
  tokenSigner.sign({ sub: user.id })  ──▶ 200 { accessToken }


GET /auth/me   Authorization: Bearer <jwt>
  │
  ├─ guard: header ausente / malformado / verify lança → 401 INVALID_ACCESS_TOKEN
  ├─ guard: principals.set(request, { id: payload.sub })
  ▼
GetUserProfileUseCase(getPrincipal(request).id)
  ├─ usersRepository.findById(id)                       null → 404 USER_NOT_FOUND
  ▼
  200 { id, email, emailVerifiedAt, createdAt }
```

**O `throw` único do login é estrutural, não disciplina.** `user === null` e
`!matches` compartilham uma linha porque ramos separados começam iguais e divergem
na primeira manutenção — um ganha log, outro ganha mensagem, e o oráculo volta.

**`InvalidEmailError` não aparece no fluxo, e isso é a invariante já estabelecida.**
O arquivo do erro documenta que ele é *"unreachable over HTTP — the endpoint's Zod
schema refuses the same values first"*, e `Email.create` é deliberadamente **mais
frouxo** que o `z.email()` da fronteira. O login usa o mesmo schema de e-mail que o
register, então a invariante se mantém: `INVALID_EMAIL` continua existindo para os
entrypoints não-HTTP da decisão 10, e o endpoint não declara status por ele.

## 6. A árvore

Só o que muda. `+` é arquivo novo, `~` é arquivo alterado.

```text
src/
├── infra/
│   ├── config/
│   │   ~ env.ts                        merge do authEnvSchema
│   └── http/
│       + auth-guard.ts                 makeAuthGuard · getPrincipal · Principal
│       + auth-guard.spec.ts
│       ~ openapi.ts                     components.securitySchemes.bearerAuth
├── modules/auth/
│   + config.ts                          authEnvSchema · AuthConfig
│   + config.spec.ts
│   ~ container.ts                       recebe AuthConfig; expõe login/me/verify
│   ├── entities/
│   │   ~ user.ts                        + User.fromTrusted
│   ├── errors/
│   │   + invalid-credentials-error.ts   INVALID_CREDENTIALS → 401
│   │   + user-not-found-error.ts        USER_NOT_FOUND      → 404
│   ├── providers/
│   │   + token-signer.ts                ITokenSigner · AccessTokenPayload
│   │   ~ hash-provider.ts               + compare · + dummyHash
│   ├── repositories/
│   │   ~ users-repository.ts            + findByEmail · + findById
│   ├── use-cases/
│   │   + login-user.ts        + login-user.spec.ts
│   │   + get-user-profile.ts  + get-user-profile.spec.ts
│   └── infra/
│       ├── drizzle/
│       │   ~ user-mapper.ts                     + toDomainUser
│       │   ~ drizzle-users-repository.ts        + findByEmail · + findById
│       ├── in-memory/
│       │   ~ in-memory-users-repository.ts      idem
│       ├── providers/
│       │   + jwt-token-signer.ts    + jwt-token-signer.spec.ts
│       │   ~ argon2-hash-provider.ts            + compare · + dummyHash
│       └── http/
│           ~ routes.ts                          recebe o guard
│           + endpoints/login.ts
│           + endpoints/me.ts
└── main/
    ~ container.ts                       makeContainer(db, env)
    ~ app.ts                             monta o guard, passa às rotas

tests/integration/
  + login.spec.ts
  + me.spec.ts
  ~ drizzle-users-repository.spec.ts     findByEmail · findById · toDomainUser

  ~ .env.example  ~ vitest.config.ts  ~ .github/workflows/ci.yml     (JWT_SECRET)
  ~ package.json                       + "jose": "6.2.3"   (exato, sem caret)
```

## 7. Contratos, mapper e repositório

```ts
// modules/auth/providers/token-signer.ts               (PURO — decisão 21)
export interface AccessTokenPayload {
  /** Subject: the authenticated user's id. */
  sub: string
}

export interface ITokenSigner {
  sign(payload: AccessTokenPayload): Promise<string>
  /** Throws on any invalid, expired, forged or malformed token. */
  verify(token: string): Promise<AccessTokenPayload>
}
```

```ts
// modules/auth/repositories/users-repository.ts        (PURO)
export interface IUsersRepository {
  save(user: User): Promise<void>
  /** Matches case-insensitively, through the `lower(email)` unique index. */
  findByEmail(email: Email): Promise<User | null>
  findById(id: string): Promise<User | null>
}
```

```ts
// infra/http/auth-guard.ts                             (GLOBAL-INFRA — genérico)
export interface Principal {
  id: string
}

export type VerifyAccessToken = (token: string) => Promise<{ sub: string }>

export function makeAuthGuard(verify: VerifyAccessToken): preHandlerHookHandler
export function getPrincipal(request: FastifyRequest): Principal
```

```ts
// modules/auth/config.ts                               (PURO — decisão 14)
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600      // 1h, decisão 11
const MIN_JWT_SECRET_LENGTH = 32

export const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number().int().positive()
    .default(DEFAULT_ACCESS_TOKEN_TTL_SECONDS),
})

export type AuthConfig = z.infer<typeof authEnvSchema>
```

Duas divergências conscientes do esboço da decisão 14: o nome carrega a unidade
(`..._TTL_SECONDS`), como o `DEFAULT_TIMEOUT_MS` do `CLAUDE.md`; e `.int().positive()`
entra porque o `ARCHITECTURE.md` §4 lista `z.coerce.number()` cru como armadilha —
`ACCESS_TOKEN_TTL_SECONDS=` viraria `0` em silêncio, e um TTL de zero é todo token
nascendo expirado.

### O mapper ganha a volta

`user-mapper.ts` diz hoje, no próprio comentário, que `toDomainUser` *"arrives with
login, exercised by `findByEmail`"*. É esta fatia.

```ts
// modules/auth/infra/drizzle/user-mapper.ts
type UserRow = typeof users.$inferSelect

/**
 * Row to entity. Both sides rehydrate rather than validate: the row was
 * validated when it was written, and re-validating on read would let a future
 * stricter rule break the loading of rows that were valid at the time.
 */
export const toDomainUser = (row: UserRow): User =>
  User.fromTrusted({
    id: row.id,
    email: Email.fromTrusted(row.email),
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
```

### `findByEmail` precisa casar o índice funcional

O índice de unicidade é `uniqueIndex(...).on(sql\`lower(${table.email})\`)`, e o
comentário de `email.ts` já enuncia a consequência: *"every lookup must query
`lower(email) = $1` to hit that index"*. Um `WHERE email = $1` compila, passa nos
testes com dados ASCII e faz **sequential scan** — medido em §13, e o defeito só
aparece em volume.

```ts
// R1: core API only, never db.query.*
const [row] = await this.db
  .select()
  .from(users)
  .where(sql`lower(${users.email}) = ${email.value}`)
  .limit(1)

return row === undefined ? null : toDomainUser(row)
```

`email.value` já vem em minúsculas — `Email.create` normaliza com
`trim().toLowerCase()` — então o `lower()` do lado esquerdo é o que alinha a
expressão com a do índice, não uma correção do parâmetro.

## 8. O adapter do token

```ts
// modules/auth/infra/providers/jwt-token-signer.ts     (INFRA — jose 6.2.3)
const ALGORITHM = 'HS256'
const MILLISECONDS_PER_SECOND = 1000
const MISSING_SUBJECT_MESSAGE = 'Access token is missing a subject'

export class JwtTokenSigner implements ITokenSigner {
  readonly #secret: Uint8Array
  readonly #ttlSeconds: number
  readonly #clock: IClock

  constructor(config: AuthConfig, clock: IClock) {
    this.#secret = new TextEncoder().encode(config.JWT_SECRET)
    this.#ttlSeconds = config.ACCESS_TOKEN_TTL_SECONDS
    this.#clock = clock
  }

  async sign(payload: AccessTokenPayload): Promise<string> {
    const issuedAt = Math.floor(this.#clock.now().getTime() / MILLISECONDS_PER_SECOND)

    return new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(payload.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.#ttlSeconds)
      .sign(this.#secret)
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    // Pinning `algorithms` is load-bearing, not decoration: verified that a
    // token signed HS512 with this same secret verifies WITHOUT the pin.
    const { payload } = await jwtVerify(token, this.#secret, {
      algorithms: [ALGORITHM],
    })

    if (typeof payload.sub !== 'string') throw new Error(MISSING_SUBJECT_MESSAGE)

    return { sub: payload.sub }
  }
}
```

**Por que o `IClock` entra num adapter.** Não é a R7 — ela rege a camada pura. É
o que torna o spec da expiração determinístico: o relógio fake avança `TTL + 1s` e
o token vence, sem `setTimeout`. O relógio já existe no container; custa um
argumento.

## 9. O guard

```ts
// src/infra/http/auth-guard.ts
const BEARER_PREFIX = 'Bearer '
const INVALID_ACCESS_TOKEN_CODE = 'INVALID_ACCESS_TOKEN'
const INVALID_ACCESS_TOKEN_MESSAGE = 'Invalid or expired access token'

/**
 * Extends `UnauthorizedError`, not `AppError`: the error handler branches on the
 * six categories and treats an `AppError` outside them as a programming mistake,
 * answering 500. Verified end to end — a throwing preHandler yields 401 in the
 * project envelope, with the traceId, across an `await` boundary.
 */
export class InvalidAccessTokenError extends UnauthorizedError {
  readonly code = INVALID_ACCESS_TOKEN_CODE
  constructor() {
    super(INVALID_ACCESS_TOKEN_MESSAGE)
  }
}

/**
 * The guard is the only writer in the system. Not exported, so forging a
 * principal would require importing something that does not exist — unlike
 * `declare module 'fastify'`, which would let any handler of any module assign
 * `request.user` from client input and still compile.
 */
const principals = new WeakMap<FastifyRequest, Principal>()

export function makeAuthGuard(verify: VerifyAccessToken): preHandlerHookHandler {
  return async (request) => {
    const header = request.headers.authorization

    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw new InvalidAccessTokenError()
    }

    let sub: string
    try {
      ;({ sub } = await verify(header.slice(BEARER_PREFIX.length)))
    } catch {
      // Swallowed on purpose: jose's message must not reach the client, and a
      // missing header, a forged token and an expired one are one state to a
      // client that knows what it sent.
      throw new InvalidAccessTokenError()
    }

    principals.set(request, { id: sub })
  }
}

const UNGUARDED_ROUTE_MESSAGE =
  'getPrincipal called on a route registered without the auth guard'

/**
 * Only reachable when a route was registered without the guard — a wiring
 * mistake, not a credential failure. A plain `Error` on purpose: it lands in the
 * error handler's generic branch, so the mistake is LOGGED as a 500 with its
 * traceId instead of answering 401 and reading like ordinary expired-token
 * traffic. The client still sees only the generic body.
 */
export function getPrincipal(request: FastifyRequest): Principal {
  const principal = principals.get(request)
  if (principal === undefined) throw new Error(UNGUARDED_ROUTE_MESSAGE)
  return principal
}
```

## 10. Erros

| Use case / peça | Situação | Erro | Categoria | Status |
|---|---|---|---|---|
| `login-user` | e-mail não existe | `InvalidCredentialsError` | `UnauthorizedError` | 401 |
| `login-user` | senha errada | `InvalidCredentialsError` | `UnauthorizedError` | 401 |
| guard | header ausente / malformado | `InvalidAccessTokenError` | `UnauthorizedError` | 401 |
| guard | token inválido / expirado / forjado | `InvalidAccessTokenError` | `UnauthorizedError` | 401 |
| `get-user-profile` | `sub` válido sem linha | `UserNotFoundError` | `NotFoundError` | 404 |
| `getPrincipal` | rota registrada **sem** o guard | `Error` simples | — fora da taxonomia | 500 |

A última linha é a única do sistema que sai da taxonomia de propósito. Não é falha
do cliente: é o desenvolvedor que montou a rota sem `preHandler`, e o ramo genérico
do handler existe exatamente para isso — 500, logado, corpo genérico.

**`USER_NOT_FOUND` nunca sai do login.** Ele só existe no `/auth/me`, onde quem
pergunta já provou ter o token. Devolvê-lo no login diria que o e-mail não existe
— enumeração direta, sem nem precisar de cronômetro.

`USER_NOT_FOUND` é, aliás, o código que o `ARCHITECTURE.md` §8 já usa como exemplo
do envelope. Ele deixa de ser hipotético aqui.

## 11. HTTP

### `POST /auth/login`

```ts
const bodySchema = z.object({
  email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
})

const okSchema = z.object({ accessToken: z.string() })

response: {
  [OK_STATUS]: okSchema,                        // 200
  [BAD_REQUEST_STATUS]: errorResponseSchema,    // 400 — Zod
  [UNAUTHORIZED_STATUS]: errorResponseSchema,   // 401 — InvalidCredentialsError
}
```

### `GET /auth/me`

```ts
const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  emailVerifiedAt: z.iso.datetime().nullable(),   // assento reservado, sempre null hoje
  createdAt: z.iso.datetime(),
})

preHandler: guard,
schema: {
  security: [{ bearerAuth: [] }],
  response: {
    [OK_STATUS]: userSchema,                      // 200
    [UNAUTHORIZED_STATUS]: errorResponseSchema,   // 401 — o guard
    [NOT_FOUND_STATUS]: errorResponseSchema,      // 404 — UserNotFoundError
  },
}
```

`passwordHash` e `updatedAt` ficam de fora: o primeiro por motivo óbvio, o segundo
por não ter consumidor. A entidade já protege por construção — `#passwordHash` é
campo privado não-enumerável, então nem um `reply.send(user)` distraído vazaria.

### `openapi.ts` ganha o esquema de segurança

`security: [{ bearerAuth: [] }]` referenciando um esquema inexistente gera
documento inválido:

```ts
openapi: {
  info: { … },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
}
```

## 12. `JWT_SECRET` em quatro lugares

Esquecer cada um quebra num momento diferente, e um deles não quebra como teste.

| Arquivo | Quebra se faltar |
|---|---|
| `.env.example` | ninguém que clona o repo consegue subir |
| `.env` | `pnpm dev` morre no boot, com a lista do Zod |
| `vitest.config.ts` (bloco `env`) | **toda** a suíte de integração morre no import de `env.ts` |
| `.github/workflows/ci.yml` (passo de smoke) | CI verde até o `node dist/main/http.js`, que sai 1 |

O `vitest.config.ts` é o menos óbvio: `env.ts` roda `process.exit(1)` no import,
então a falha não aparece como teste vermelho e sim como a suíte não subindo.

**O que o compilador pega sozinho:** `JWT_SECRET` vira campo obrigatório de `Env`,
então todo fixture tipado como `Env` (`env.spec.ts`, `server.spec.ts`,
`error-handler.spec.ts`) falha na compilação. Os dois arquivos que **não** são
TypeScript são justamente os dois que ninguém vê falhar.

## 13. Achados empíricos

Verificados antes de escrever, com sondas descartadas depois.

### `jose` 6.2.3 — o pin de `algorithms` é carga

```
segredo errado, algorithms fixado      THROW  JWSSignatureVerificationFailed
alg:none, SEM fixar algorithms         THROW  TypeError
HS512 com o MESMO segredo, SEM fixar   OK  ← sub=attacker
HS512 com o MESMO segredo, fixado      THROW  JOSEAlgNotAllowed
exp vencido há 1s,  clockTolerance 5s  OK
exp vencido há 60s, clockTolerance 5s  THROW  JWTExpired
iat 30s no futuro, sem tolerância      OK  ← jose não valida `iat` contra o relógio
```

### `jose` não impõe tamanho mínimo de segredo

Assinar com um segredo de **5 bytes** é aceito sem aviso. O `z.string().min(32)`
do `authEnvSchema` é, portanto, a **única** coisa no sistema que garante entropia
do `JWT_SECRET` — não uma redundância sobre uma checagem da biblioteca.

### `preHandler` que lança produz o envelope do projeto

```
preHandler que lança (síncrono)   401  {"error":{"code":"INVALID_ACCESS_TOKEN",…,"traceId":"bb54ce02-…"}}
preHandler que lança após await   401  {"error":{"code":"INVALID_ACCESS_TOKEN",…,"traceId":"e452988f-…"}}
preHandler que passa              200  {"principal":{"id":"user-1"}}
```

O segundo caso prova que o `AsyncLocalStorage` do `traceId` sobrevive à fronteira
assíncrona; o terceiro, que o `WeakMap` chaveado pelo `request` atravessa
`preHandler → handler`.

### `Error` simples: 500 genérico ao cliente, mensagem completa no log

O que decidiu o `getPrincipal` do §4.1:

```
status: 500
body  : {"error":{"code":"INTERNAL_SERVER_ERROR","message":"Internal server error","traceId":"3076a50e-…"}}
logged: YES — a mensagem chega ao log
leaks : no  — o cliente vê corpo genérico
```

As duas metades importam. Se a mensagem não chegasse ao log, um `Error` simples
seria pior que o 401 — falha muda. Se chegasse ao corpo, seria vazamento.

### O dummy hash equaliza, e `hashSync` casa com `hash`

```
dummy : $argon2id$v=19$m=19456,t=2,p=1$cjzNio0quk…
real  : $argon2id$v=19$m=19456,t=2,p=1$QD8qniPJao…
mesmos parâmetros: true

verify contra hash real, senha errada   7,4 ms
verify contra dummy                     7,3 ms
```

### `WHERE email = $1` não usa o índice; `lower(email) = $1` usa

`EXPLAIN` contra o banco de teste com a migration aplicada:

```
EXPLAIN SELECT * FROM users WHERE email = '…';
  Seq Scan on users  (cost=0.00..17.62 rows=3 width=104)
    Filter: (email = '…'::text)

EXPLAIN SELECT * FROM users WHERE lower(email) = '…';
  Index Scan using users_email_lower_unique on users  (cost=0.15..8.17 rows=1 width=104)
    Index Cond: (lower(email) = '…'::text)
```

A tabela só tem dois índices — a PK e o funcional sobre `lower(email)` — então a
forma sem `lower()` não tem índice a usar. As duas devolvem a mesma linha com dados
ASCII, e é por isso que o erro passa em teste.

### `timestamptz`: a assimetria da decisão 11 não atinge esta fatia

```
--- app supplied (IClock) — o que o register já faz ---
JS escreveu   2026-08-28T00:38:13.576Z
no postgres   2026-08-28 00:38:13.576+00
lido em JS    2026-08-28T00:38:13.576Z        LOSSLESS: true
instanceof Date: true

--- database supplied (defaultNow) ---
no postgres   2026-08-28 00:38:13.593114+00   ← microssegundos
lido em JS    2026-08-28T00:38:13.593Z        ← truncado
```

Enquanto o `IClock` for a fonte, o round-trip é exato e `pg` devolve `Date`. A
truncagem só aparece em linha escrita por `defaultNow()` — seed, psql, migration
de dados. É a regra que a decisão 11 enunciou, agora medida.

## 14. Custos aceitos

Escritos aqui para não virarem descoberta em incidente.

### 14.1 — O login não recusa e-mail não verificado

É a contrapartida direta do argumento que ordenou as fatias. A spec do register
construiu login antes de verificação porque *"quem recusa é o login"*. Esta fatia
constrói o login e **não** põe o gate, porque nada consegue verificar ainda: com
`email_verified_at` sempre `null`, o gate trancaria todo mundo para fora.

O gate nasce na fatia 4, **na mesma fatia** que o caminho de verificação — que é
exatamente a forma que o argumento original pedia. Não é esquecimento.

### 14.2 — Enumeração via `POST /auth/register`

O `409 EMAIL_ALREADY_IN_USE` diz se a conta existe, sem cronômetro. Esta fatia não
piora nada — o login já sai equalizado — mas também não corrige.

Não é corrigível agora: a saída que preserva UX é responder `202` sempre e avisar
por e-mail, o que exige o provedor da fatia 4. **Fechar junto com o `202`.**

Por que importa num boilerplate: você não sabe qual app será derivado. Saber que
alguém tem conta é irrelevante num app de notas e é o próprio dado sensível num de
saúde. Deixar embutido decide por N apps futuros.

### 14.3 — Rate limiting fora de escopo

Continua a decisão em aberto do `DECISIONS.md` §6, que a auditoria classificou
como *"branco arquitetural, não wishlist"*. Política proposta para a fatia
dedicada resolver:

| | |
|---|---|
| escopo | o par **IP + e-mail** — só IP pune NAT corporativo, só e-mail permite ataque distribuído |
| resposta | `429` no envelope do projeto |
| store | memória agora; Redis quando existir, sem mexer em call site |

**Freio já presente e medido:** argon2 a 7,3 ms e 19 MB por tentativa. Não
substitui throttle — ataque distribuído ignora, e o custo é ele próprio vetor de
DoS — mas o endpoint não nasce nu.

### 14.4 — Revogação tem latência de 1h, e não há `logout`

É a decisão 11 executada, não omissão: sem estado no servidor não há o que
revogar, e "logout" nesta fatia é o cliente descartar o token da memória. O
endpoint nasce na fatia 4, junto com a família de refresh que ele revoga.

### 14.5 — O corpo do login ganha campos na fatia 4

`refreshToken` para mobile, `Set-Cookie` para web (decisão 12). Aditivo e
compatível — foi o critério que escolheu `{ accessToken }` sozinho (§4.2).

### 14.6 — R7 e a fronteira continuam sem dente no lint

Esta fatia adiciona dois use cases, quatro portas e uma config à camada pura. A
dívida que o `ARCHITECTURE.md` §4 registra cresce proporcionalmente, e o guard
genérico do §4.3 só existe porque alguém leu a tabela de fronteira à mão.

## 15. Testes

### Unitários — colocados, sem I/O

| Arquivo | O que prova |
|---|---|
| `use-cases/login-user.spec.ts` | sucesso; senha errada e e-mail inexistente produzem **o mesmo** erro; e que `compare` **é chamado com o `dummyHash`** quando o usuário não existe (§15.1) |
| `use-cases/get-user-profile.spec.ts` | achado; `UserNotFoundError` quando o `sub` não tem linha |
| `infra/providers/jwt-token-signer.spec.ts` | ida e volta; expirado (relógio fake avança `TTL + 1s`); segredo errado; HS512 recusado; token sem `sub` |
| `infra/providers/argon2-hash-provider.spec.ts` | `compare` true/false; `dummyHash` é argon2id válido e perde a comparação |
| `infra/http/auth-guard.spec.ts` | sem header · `Basic x` · `Bearer` vazio · `verify` que lança → todos `401 INVALID_ACCESS_TOKEN` no envelope; sucesso injeta o principal; `getPrincipal` em rota **sem** o guard → `500` genérico **e a mensagem no log** (§15.2) |
| `entities/user.spec.ts` | `fromTrusted` preserva os seis campos e clona as datas |
| `config.spec.ts` | `JWT_SECRET` de 31 caracteres é recusado; `ACCESS_TOKEN_TTL_SECONDS=` não vira `0` |

Portas seguem a convenção da fatia 2: **objeto literal dentro do `.spec.ts`**, sem
arquivo de fake, porque `tsconfig.build.json` só exclui `*.spec.ts` e um arquivo de
fake iria para o `dist/`.

`auth-guard.spec.ts` sobe um servidor e usa `inject`, seguindo o padrão que
`error-handler.spec.ts` e `server.spec.ts` já usam — sem I/O, portanto unitário.

### 15.1 — O teste que protege a equalização de timing

Não basta assertar que o erro é o mesmo nos dois modos de falha: isso continua
passando se alguém introduzir um `if (user === null) throw …` **antes** do
`compare`. O erro seria idêntico e o tempo, não — a equalização teria sumido sem
um único teste vermelho.

O que fecha é assertar a **chamada**, não só o resultado:

```ts
// The assertion is that argon2 ran at all. A future `if (!user) throw` before
// the compare keeps every other assertion in this file green while silently
// restoring the timing oracle.
expect(compareSpy).toHaveBeenCalledWith(PASSWORD, hashProvider.dummyHash)
```

### 15.2 — O teste que documenta a rota sem guard

Uma rota registrada **sem** `preHandler` cujo handler chama `getPrincipal`
responde `500` com corpo genérico, e a mensagem aparece **no log**. As duas
metades são a asserção: o corpo prova que nada vaza, e o log prova que a falha é
diagnosticável — que é a única razão de não ser um 401.

O spec captura o log pelo `logStream` de `BuildServerOptions`, como
`register.spec.ts` já faz.

### Integração — Postgres real

`login.spec.ts` e `me.spec.ts`, um por endpoint, como `register.spec.ts`. Mais
`drizzle-users-repository.spec.ts` estendido: `findByEmail` casando por
`lower(email)` (o índice funcional), `findById`, e `toDomainUser` rehidratando os
seis campos.

**O teste que amarra a fatia inteira não decodifica o JWT.** Ele registra, loga, e
usa o token retornado em `GET /auth/me`, assertando que o `id` devolvido é o do
register. Exercita assinatura, guard, verificação, `WeakMap`, `findById` e mapper
num caminho só — e não acopla o teste ao formato do token, que não é contrato.

O 404 do `/auth/me` sai de: registrar → logar → `DELETE` da linha → chamar com o
token ainda válido.

Constantes de rota e código de erro são **escritas à mão** nos specs de
integração, nunca importadas do endpoint: elas *são* o contrato de fio, e importar
tornaria a asserção tautológica.

## 16. Emendas de documentação

- **`ARCHITECTURE.md`** — a árvore do §2; o exemplo de container (ganha `AuthConfig`
  e `verifyAccessToken`); o §7 (esquema de segurança no OpenAPI); e o §13, de onde
  saem *"login"* e *"`config.ts` de módulo"*.
- **`docs/DECISIONS.md`** §6 — a decisão em aberto *"superfície pública do módulo /
  `ensure-authenticated`"* **fecha**: com o verificador injetado, nenhum módulo
  importa `auth` para se proteger, e a exceção declarada no lint deixa de ser
  necessária. Registrar como resolvida pelo §4.3 desta spec.
- **`2026-08-26-register-user-design.md` linha 37** — trocar *"Verificação de
  e-mail — próxima fatia"* por login, notando que o argumento das linhas 51-54 da
  própria seção é o que decidiu. A spec se contradizia; a correção é parte desta
  fatia.

`DECISIONS.md`, `STRUCTURE.md`, `TODO.md` e `OLD_ARCHITECTURE.md` são gitignored:
editar no disco, nunca commitar, nunca `git add -f`.

## 17. Próxima fatia

Verificação de e-mail **e** refresh token disputam a fatia 4. A decisão 11 inteira
(rotação, janela de graça de 30s, detecção de reuso, revogação de família, trava de
linha, Unit of Work) é a maior peça restante do projeto; a verificação traz
`IMailer` e destrava o gate do §14.1 e o `202` do §14.2 de uma vez.

Não decidido aqui.
