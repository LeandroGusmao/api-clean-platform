# Fatia 14 — Login com Google (client-driven): design

> Escrito em 2026-09-08. Entrega o primeiro provedor de identidade federada. É a
> fatia que o [`DECISIONS.md §6`](../../DECISIONS.md) vinha adiando com três
> sub-perguntas já decididas em 2026-09-06; esta spec resolve o resto.
>
> Fecha os itens 1, 2 e 3 de "Login social / OAuth (Google primeiro)" da §6 do
> `DECISIONS.md` e precisa de uma **decisão 31** registrando o formato escolhido.

## 1. O que esta fatia entrega

Um endpoint novo, anônimo: **`POST /auth/google`**. O cliente (mobile ou web)
roda o SDK do Google, obtém um **ID token**, e o manda para a API. A API
**verifica a assinatura** do ID token contra o JWKS público do Google, resolve ou
cria a conta, e emite uma sessão — o mesmo `{ accessToken, refreshToken? }` do
`login`.

```
POST /auth/google
body: { idToken: string, password?: string, refreshTransport?: "body" | "cookie" }
```

**Não** entrega o fluxo de redirect / BFF (`GET /auth/google/start` +
`/callback`). Esse é o padrão dominante para um front web com backend próprio, mas
exige store de `state`+PKCE, uma chamada HTTP outbound de verdade e o
`GOOGLE_CLIENT_SECRET`. Ele é uma fatia futura que **reusa o núcleo de vínculo de
conta** desta aqui — não é retrabalho, é uma borda a mais para obter a identidade
Google. O formato client-driven foi escolhido porque é o que a maioria dos apps
mobile realmente faz, é a entrega menor e mais segura, casa com a decisão 12
(corpo, um processo para os dois clientes) e com a ressalva da decisão 13 (que já
previu *receber* um token).

### O que "verificação client-driven" custa e não custa

- **Não custa** `GOOGLE_CLIENT_SECRET` — a verificação de ID token é criptografia
  de chave pública (JWKS). Sem redirect, sem troca de código, sem segredo.
- **Não custa** store de `state` nem PKCE — não dirigimos o redirect, então não
  há `state` nosso para guardar.
- **Custa** a primeira dependência de rede outbound do projeto: o `jose` busca o
  JWKS do Google. É uma busca gerenciada pela biblioteca, com cache próprio, não
  um cliente HTTP nosso. Ver §10.

## 2. Decisões tomadas no brainstorming

| Ponto | Decisão |
|---|---|
| Formato do fluxo | **Client-driven POST.** O cliente entrega o ID token; a API só verifica assinatura. Redirect/BFF fica para fatia futura reusando este núcleo |
| Verificação | `jose` (`createRemoteJWKSet` + `jwtVerify`), **sem client secret**. `iss`, `aud`, `exp` e `email_verified` checados dentro do adapter |
| `email_verified: false` | **Recusa (401).** Sem `email_verified: true` o Google não provou o endereço, e os três cenários da §6 se apoiam nisso. Uma linha de guarda no verificador |
| Conta com senha já existe para o e-mail (§6 item 3) | **Sem merge silencioso.** `409 GOOGLE_LINK_REQUIRES_PASSWORD`; o cliente repete `POST /auth/google` com `{ idToken, password }` — a senha **do app**. Confere → vincula e emite sessão. Errada → `401 INVALID_CREDENTIALS`. Um passo, `password` opcional no mesmo request; **sem tabela de ticket** |
| Cadastro pendente não confirmado existe para o e-mail (§6 item 2) | **Google ganha.** Conta nasce verificada, sem senha; **todos** os pendentes do e-mail são apagados no mesmo `uow` |
| E-mail novo | Cria conta verificada sem senha + linha de identidade + primeiro refresh token, tudo em um `uow` |
| Já vinculado (`sub` casa em `federated_identities`) | Fast path: carrega o user, emite sessão. **Um write, sem `uow`** — igual ao `login` |
| `users.password_hash` | Passa a aceitar **`NULL`** — uma conta federada não tem senha. `User.createFederated` novo. Sentinela foi descartada (mentira gravada, frágil no `argon2.compare`) |
| `argon2` no ramo de vínculo | Roda **fora do `uow`** (§8 do Unit of Work). **Sem** hash-isca incondicional nos outros ramos: aqui os ramos já são públicos e distinguíveis por design (o `409` sem senha é a resposta esperada), então não há oráculo de timing a esconder — diferente do `confirm` |
| E-mail de aviso | `googleAccountLinkedEmail`, **best-effort**, só no ramo de vínculo sobre conta com senha. Mesma doutrina do `passwordChangedEmail` |
| `GOOGLE_CLIENT_ID` | **Obrigatório no boot** (`z.string().min(1)`, sem default), como `JWT_SECRET`. Placeholder no `.env.example` para quem não usa Google |
| `provider` na tabela | `text` + constante `GOOGLE_PROVIDER`, não `pgEnum` — o projeto favorece isso e migração de enum PG é cara |
| Token do Google em repouso | **Nada.** Não guardamos `access_token` nem `refresh_token` do Google; só a identidade |

## 3. Modelo de dados

### 3.1 — Nova tabela `federated_identities`

`src/modules/auth/infra/drizzle/schema/federated-identities.ts`, própria do módulo
`auth`, um arquivo por tabela nomeado pela tabela (decisão 24).

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | `uuid` PK | de `IIdGenerator` |
| `user_id` | `uuid` not null | **FK → `users.id` `ON DELETE CASCADE`** — dentro do módulo, permitido pela decisão 24. Cascade porque a identidade não faz sentido sem o usuário |
| `provider` | `text` not null | `'google'` é o único valor hoje; constante `GOOGLE_PROVIDER` |
| `provider_user_id` | `text` not null | o `sub` do Google — estável, único por conta Google, nunca reassociado a outra |
| `email_at_link` | `text` not null | auditoria: o e-mail que o Google afirmou **no momento do vínculo**. Nunca reescrito. Normalizado pelo VO `Email`, como `users.email` |
| `created_at` | `timestamptz` not null | de `IClock`; imutável; ordem de auditoria |

**Sem `updated_at`** — a linha é *insert-only*. Vincular é uma vez; desvincular
está fora de escopo, e quando entrar é um `DELETE`, não um `UPDATE`.

**Sem defaults de coluna** — mesma razão de `refresh-tokens.ts` /
`password-reset-tokens.ts`: `created_at` vem do `IClock`, e comparação de instante
exige os dois lados da mesma fonte. (Aqui não há comparação de instante hoje, mas
a consistência com as outras tabelas do módulo vale mais que a exceção.)

Índices:

```
unique (provider, provider_user_id)   -- o fast path (findByProviderUserId) E a
                                         garantia estrutural: uma conta Google -> um user
unique (user_id, provider)            -- um user tem no máximo uma identidade por provedor
index  (user_id)                      -- eficiência do cascade; "listar meus provedores" (futuro)
```

Os nomes dos índices ficam **inline** — o repositório **não** traduz o `23505` de
nenhum deles (ver §4.4). Se uma fatia futura precisar ler um desses nomes de
outro arquivo, ele vira constante exportada declarada no próprio schema, como
manda a exceção do `CLAUDE.md`.

### 3.2 — `users.password_hash` passa a aceitar `NULL`

`schema/users.ts`: `passwordHash: text('password_hash')` — cai o `.notNull()`.

Uma conta de identidade federada **não tem senha**. As alternativas e por que
`NULL` ganhou:

| | Prós | Contras |
|---|---|---|
| **`NULL`** (escolhido) | honesto — não há senha; `login` já trata via `user?.passwordHash ?? dummyHash` (o `??` pega `null` de graça) | toca schema, entidade, mapper; `change-password` ganha um guard |
| Sentinela (hash impraticável) | coluna intacta | mentira gravada; todo leitor precisa conhecer a sentinela; `argon2.compare` contra ela é frágil |

Migration: `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL` — aditivo,
sem backfill (linhas existentes já têm hash). Comentário da coluna atualizado.

### 3.3 — Nenhuma outra tabela muda

`refresh_tokens`, `pending_registrations`, `password_reset_tokens` intactas. A
poda do `cron.ts` (fatia 13) **não** ganha job novo — `federated_identities` não
expira.

## 4. Camada de domínio

### 4.1 — Nova entidade `entities/federated-identity.ts`

Espelha o estilo de `RefreshToken` / `PendingRegistration`:

- Estado em campos `#` privados: `id`, `userId`, `provider`, `providerUserId`,
  `emailAtLink: Email`, `createdAt`. `Object.freeze`, datas clonadas na entrada e
  na saída, `JSON.stringify` → `{}` — o `provider_user_id` é baixa-sensibilidade
  mas não é público; a consistência com as outras entidades vale a proteção.
- `static create({ id, userId, provider, providerUserId, emailAtLink, now })` —
  `createdAt = now`.
- `static fromTrusted(props)` — rehidrata uma linha; validação é papel do
  `create`, na entrada.
- **Sem método de comportamento.** Não expira, não tem `isUsable`, não tem
  `consume`. É um fato registrado.
- getters clonando datas.

### 4.2 — Novo port `ports/google-identity-verifier.ts`

```ts
export interface GoogleIdentity {
  /** Google's `sub` — stable, unique per Google account, never reassigned. */
  subject: string
  /** Already asserted as verified by Google; the adapter throws otherwise. */
  email: string
}

export interface IGoogleIdentityVerifier {
  /**
   * Throws `InvalidGoogleIdentityError` on any invalid, forged, expired,
   * wrong-audience, wrong-issuer, or unverified-email token.
   */
  verify(idToken: string): Promise<GoogleIdentity>
}
```

`email_verified` **não aparece no contrato** — se não for `true`, o adapter lança.
Nada a jusante decide sobre isso.

### 4.3 — Novo adapter `infra/providers/jose-google-identity-verifier.ts`

`GOOGLE_ISSUERS` é constante no arquivo — fato do Google, valor fechado, não muda
entre ambientes:

```
GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']  // os dois válidos
```

A **URI do JWKS entra no env** (`GOOGLE_JWKS_URI`) com **default de produção**,
exatamente como `MAIL_HOST` tem um default de desenvolvimento: é o endpoint de um
serviço externo, e o teste de integração precisa apontar o adapter para um JWKS
local. O construtor recebe a **fatia de config**, como `JwtTokenSigner` recebe
`Pick<AuthConfig, 'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS'>`:

```
constructor(config: Pick<AuthConfig, 'GOOGLE_CLIENT_ID' | 'GOOGLE_JWKS_URI'>)
  #clientId = config.GOOGLE_CLIENT_ID          // nenhum secret
  #jwks     = createRemoteJWKSet(new URL(config.GOOGLE_JWKS_URI))   // cache interno do jose

async verify(idToken):
  try:
    { payload } = await jwtVerify(idToken, this.#jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: this.#clientId,        // load-bearing: sem isso, token de OUTRO client_id passa
    })                                  // jwtVerify já cobre assinatura, iss, aud, exp, nbf
    if (payload.email_verified !== true) throw ...
    if (typeof payload.email !== 'string') throw ...
    if (typeof payload.sub !== 'string') throw ...
    return { subject: payload.sub, email: payload.email }
  catch:
    throw new InvalidGoogleIdentityError()   // UM erro para todo modo de falha
```

O teste de integração assina um ID token com `iss: 'https://accounts.google.com'`
(um dos valores de `GOOGLE_ISSUERS`), então não precisa sobrepor os issuers —
só a `GOOGLE_JWKS_URI`, via override de env no `buildApp`, como
`verify-email.spec.ts` já faz com os tetos de rate limit.

**Um `throw` só** para assinatura, `iss`, `aud`, `exp`, `email_verified` false,
`email`/`sub` ausente — mesma doutrina do `throw` único do `login-user.ts`: ramos
que reportassem diferente virariam oráculo.

O pin de `audience` é *load-bearing*, coberto por teste de regressão — igual ao
pin `algorithms: [ALGORITHM]` do `jwt-token-signer.ts`.

### 4.4 — Novo repositório `repositories/federated-identities-repository.ts`

`IFederatedIdentitiesRepository`:

- `save(identity: FederatedIdentity): Promise<void>` — insert simples. Uma
  violação de `unique (provider, provider_user_id)` ou `unique (user_id,
  provider)` **borbulha** como falha de persistência genérica (→ 500 via
  `toPersistenceError`). Não traduzimos: a corrida de vínculo duplo é rara, e uma
  re-execução do sign-in cai no fast path (§5, passo 4).
- `findByProviderUserId(provider: string, providerUserId: string):
  Promise<FederatedIdentity | null>` — o fast path. `null` quando não há vínculo.

`findByUserId` (listar provedores) é YAGNI aqui — entra com a fatia da tela de
settings.

### 4.5 — `IPendingRegistrationsRepository` ganha `deleteAllByEmail`

`deleteAllByEmail(email: Email): Promise<void>` — `DELETE WHERE lower(email) = ?`,
**sem** filtro de expiry ou `consumed_at`. Apaga todos os pendentes do endereço,
vivos ou não, quando o Google leva o endereço (§6 item 2 do `DECISIONS.md`). Um
`confirm` concorrente que ia consumir um deles vê `consume` retornar `false` →
`EmailVerificationFailedError`. É o resultado pretendido.

Diferente de `deleteExpiredByEmail` (fatia 11, poda oportunista, nunca toca linha
viva) — este é intencional e total.

### 4.6 — `AuthRepos` e o Unit of Work

`AuthRepos` (em `repositories/unit-of-work.ts`) ganha
`federatedIdentities: IFederatedIdentitiesRepository`. Comentário de doutrina
atualizado: o sign-in do Google cria o usuário, a linha de identidade e o
primeiro refresh token **numa transação** — um fato, ou os quatro landam
(incluindo o `deleteAllByEmail` dos pendentes) ou nenhum.

### 4.7 — `User` — mudanças

- `TrustedUserProps.passwordHash: string | null`.
- `CreateUserProps` **intacto** (`{ id, email, passwordHash, now }`) — continua
  servindo o `ConfirmEmailUseCase`.
- **Novo** `static createFederated({ id, email, now }): User` — `passwordHash:
  null`, `emailVerifiedAt: now`, nasce verificada. Docstring: "o terceiro caminho
  provado — depois de `confirm`, o IdP prova o endereço (§6 item 2 do
  `DECISIONS.md`)".
- `get passwordHash(): string | null`.
- `user-mapper.ts`: `null` nos dois sentidos.

### 4.8 — `entities/user.spec.ts` e os dois use cases vizinhos

- **`login-user.ts`**: `user?.passwordHash ?? this.hashProvider.dummyHash` já
  resolve `null` (o `??` pega). Entra só um comentário local: "um usuário
  só-federado tem `passwordHash` null e cai aqui no decoy → `InvalidCredentialsError`".
- **`change-password.ts`**: guard novo antes do compare — se `user.passwordHash
  === null`, roda `hashProvider.compare(command.currentPassword,
  hashProvider.dummyHash)` (decoy, tempo plano) e lança `InvalidCurrentPasswordError`.
  Uma conta só-Google não troca senha porque não tem senha atual; "definir a
  primeira senha" é fatia futura.

## 5. Fluxo — `use-cases/sign-in-with-google.ts`

**Command:** `{ idToken: string; password?: string }` (o `refreshTransport` é
tratado no endpoint).
**Result:** `{ accessToken: string; refreshToken: string }` — mesmo shape do
`login` / `confirm`.

**Construtor** (espelha o `confirm`): `googleVerifier`, `usersRepository`
(`Pick<…, 'findById' | 'findByEmail'>`), `federatedIdentities` (`Pick<…,
'findByProviderUserId'>`), `uow`, `refreshTokenIssuer`, `tokenSigner`,
`hashProvider`, `idGenerator`, `clock`, `bestEffortEmailSender`.

`save` / `deleteAllByEmail` das linhas transacionais vêm do callback do `uow`, não
do `Pick` injetado — como no `confirm`.

### Passo a passo

```
1.  identity = await googleVerifier.verify(command.idToken)      // lança InvalidGoogleIdentityError -> 401
2.  email    = Email.create(identity.email)                       // VO; normaliza lowercase
3.  now      = clock.now()                                        // UMA vez (R7) — carimba user, identity,
                                                                  //   email_verified_at e o 1o refresh token

4.  linked = await federatedIdentities.findByProviderUserId(GOOGLE_PROVIDER, identity.subject)
    if (linked !== null):
        user   = await usersRepository.findById(linked.userId)    // sempre existe (FK + cascade)
        issued = refreshTokenIssuer.issue(user.id, refreshTokenIssuer.newFamilyId(), now)
        await refreshTokensRepository.save(issued.entity)         // 1 write, SEM uow (igual login)
        return session(user.id, issued)

5.  existing = await usersRepository.findByEmail(email)

6.  existing === null  ->  CRIAR CONTA:
        user        = User.createFederated({ id: idGenerator.generate(), email, now })
        identityRow = FederatedIdentity.create({ id: idGenerator.generate(), userId: user.id,
                        provider: GOOGLE_PROVIDER, providerUserId: identity.subject,
                        emailAtLink: email, now })
        issued      = refreshTokenIssuer.issue(user.id, refreshTokenIssuer.newFamilyId(), now)
        await uow(async ({ users, pendingRegistrations, federatedIdentities, refreshTokens }) => {
            await users.save(user)                                 // corrida perdida no índice único de email
                                                                  //   -> EmailAlreadyInUseError sai do uow (rollback),
                                                                  //      mapeia para 409 EMAIL_ALREADY_IN_USE. Sem
                                                                  //      remapeamento: o Google já provou o e-mail,
                                                                  //      então o 409 específico não vaza nada novo.
            await pendingRegistrations.deleteAllByEmail(email)     // §6 item 2 — Google levou o endereço
            await federatedIdentities.save(identityRow)
            await refreshTokens.save(issued.entity)
        })
        return session(user.id, issued)

7.  existing.passwordHash === null  ->  throw new GoogleSignInConflictError()   // 409, genérico
        // Edge raro: já existe conta SÓ-FEDERADA para este e-mail e o sub NÃO casou
        // (Workspace deletou+recriou a conta Google, ou dois subs para o mesmo endereço
        // ao longo do tempo). Não há senha para exigir e não há merge seguro. Ver §10.

8.  existing.passwordHash !== null  ->  VÍNCULO COM SENHA:
        if (command.password === undefined):
            throw new GoogleLinkRequiresPasswordError()           // 409 — recusa específica (decisão §6)
        matches = await hashProvider.compare(command.password, existing.passwordHash)   // FORA da uow (§8)
        if (!matches):
            throw new InvalidCredentialsError()                   // 401 — MESMO code do login
        identityRow = FederatedIdentity.create({ id: idGenerator.generate(), userId: existing.id,
                        provider: GOOGLE_PROVIDER, providerUserId: identity.subject,
                        emailAtLink: email, now })
        issued = refreshTokenIssuer.issue(existing.id, refreshTokenIssuer.newFamilyId(), now)
        await uow(async ({ federatedIdentities, refreshTokens }) => {
            await federatedIdentities.save(identityRow)
            await refreshTokens.save(issued.entity)
        })
        await bestEffortEmailSender.send(googleAccountLinkedEmail(existing.email))   // best-effort, DEPOIS do commit
        return session(existing.id, issued)
```

`session(userId, issued)` = `{ accessToken: await tokenSigner.sign({ sub: userId
}), refreshToken: issued.token }`.

### Pontos de doutrina

- **`argon2` só no passo 8, e sempre fora do `uow`** (§8 do Unit of Work: um hash
  de ~7 ms com a transação aberta é uma conexão do pool parada).
- **Sem hash-isca incondicional** nos passos 4 e 6. No `confirm`, o timing
  separava "código válido" de "inválido" e o decoy escondia isso. Aqui os ramos
  são públicos por design: o `409 GOOGLE_LINK_REQUIRES_PASSWORD` é a resposta
  esperada, não um sinal a esconder. Um decoy nos ramos 4/6 seria custo sem
  meaning.
- **`now` lido uma vez** — quatro colunas em quatro tabelas que o `uow` do passo 6
  torna atômicas.
- **Fast path (passo 4) sem transação** — um único write, como o `login`.
- **E-mail de aviso depois do commit** — se o `send` falhar, a transação já
  fechou; `bestEffortEmailSender` engole a falha e loga. O estado não pode
  reverter por causa de um e-mail.

## 6. Camada HTTP

### 6.1 — Endpoint `infra/http/endpoints/sign-in-with-google.ts`

```
POST /auth/google

body  z.object({
        idToken:          z.string().min(1).max(MAX_ID_TOKEN_LENGTH),  // JWT ~1-2 KB; teto p/ não
                                                                        //   pagar cripto sobre corpo de 10 MB
        password:         z.string().min(MIN_SUBMITTED_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).optional(),
        refreshTransport: refreshTransportSchema,                       // reusa refresh-cookie.ts
      }).strict()                                                       // campo desconhecido -> 400, como o register

config { rateLimit: container.googleSignInRateLimit }

response
  200  sessionTokensSchema      // { accessToken, refreshToken? }
  400  errorResponseSchema      // corpo malformado / campo extra
  401  errorResponseSchema      // INVALID_GOOGLE_IDENTITY | INVALID_CREDENTIALS
  409  errorResponseSchema      // GOOGLE_LINK_REQUIRES_PASSWORD | GOOGLE_SIGN_IN_CONFLICT | EMAIL_ALREADY_IN_USE
  429  errorResponseSchema      // rate limit
  503  errorResponseSchema      // deadlock que sobrevive às retentativas (abre uow)
```

Handler: chama `container.signInWithGoogle.execute(request.body)`, depois o
**mesmo** branch de `refreshTransport` do `login` — cookie mode:
`setRefreshCookie` + `send({ accessToken })`; body mode: `send({ accessToken,
refreshToken })`.

- `password` é **"presença, não política"** (igual ao `login`): `min(1).max(...)`,
  **sem** `PASSWORD_POLICY_PATTERN`. Uma conta criada sob política antiga tem que
  poder ser vinculada.
- `MAX_ID_TOKEN_LENGTH` — constante nova no arquivo do endpoint. Proposta:
  `4096`.
- `MIN_SUBMITTED_PASSWORD_LENGTH` — reusa a constante do `login.ts` (ou uma cópia
  local com o mesmo comentário, seguindo o que o `login` fez).
- Descrição OpenAPI: explica o `409 GOOGLE_LINK_REQUIRES_PASSWORD` e o retry com
  `password`.

`routes.ts`: uma linha — `await app.register(signInWithGoogleRoute, {
container })`. Sem `guard` (rota anônima).

### 6.2 — Erros — zero categoria nova na taxonomia (decisão 13)

| Erro | Categoria | Status | `code` | Onde nasce |
|---|---|---|---|---|
| `InvalidGoogleIdentityError` | `UnauthorizedError` | 401 | `INVALID_GOOGLE_IDENTITY` | o verificador — **um erro para todo modo de falha** de identidade |
| `GoogleLinkRequiresPasswordError` | `ConflictError` | 409 | `GOOGLE_LINK_REQUIRES_PASSWORD` | passo 8, sem `password`. **A recusa deliberadamente específica** que a decisão §6 abençoa — o IdP já provou que quem está ali é dono do e-mail. Comentário local cita a decisão |
| `GoogleSignInConflictError` | `ConflictError` | 409 | `GOOGLE_SIGN_IN_CONFLICT` | passo 7, o edge do `sub` reassociado. Genérico de propósito — não há ação do cliente que resolva |
| `InvalidCredentialsError` (reusado) | `UnauthorizedError` | 401 | `INVALID_CREDENTIALS` | passo 8, senha errada. Mesmo `code` do `login` — nenhum oráculo novo |
| `EmailAlreadyInUseError` (reusado) | `ConflictError` | 409 | `EMAIL_ALREADY_IN_USE` | passo 6, corrida perdida no índice único de `users`. Borbulha sem remapeamento |

**`securityEvent`** (decisão 15 emendada): `false` em todos. Nenhum é "o mecanismo
forte disparando" como o `RefreshTokenReusedError`; `GoogleLinkRequiresPasswordError`
é fluxo normal esperado.

### 6.3 — E-mail de aviso — `googleAccountLinkedEmail`

Nova função pura em `notifications/emails.ts`:

```
subject: "A Google sign-in was connected to your account"
text:    "Sign in with Google was just connected to your account.\n\n
          If this was not you, reset your password immediately — whoever
          connected it can then sign in without your password."
```

- Enviado **best-effort** (`bestEffortEmailSender`, já no container) só no **passo
  8** (vínculo sobre conta com senha) — o estado mudou e um envio falho não pode
  derrubar o request. Mesma doutrina do `passwordChangedEmail`.
- **Não** enviado no passo 6 (conta nova): não há nada a avisar.

## 7. Config, migration, DI

### 7.1 — Config (`src/modules/auth/config.ts`)

```ts
/**
 * The OAuth client id issued by Google Cloud Console. Public, not a secret:
 * ID-token verification is public-key crypto (JWKS). The redirect flow that
 * needs a secret is a future slice. Required, no default — like JWT_SECRET;
 * ship a placeholder in .env.example for setups that do not use Google.
 */
GOOGLE_CLIENT_ID: z.string().min(1),

/**
 * Where `jose` fetches Google's signing keys. A default of the real endpoint,
 * like MAIL_HOST defaults to the dev Mailpit: it is a service endpoint, and the
 * integration test overrides it to a local JWKS server the same way
 * verify-email.spec.ts overrides the rate-limit ceilings.
 */
GOOGLE_JWKS_URI: z.url().default(DEFAULT_GOOGLE_JWKS_URI),   // https://www.googleapis.com/oauth2/v3/certs

/**
 * A request on the link path carries a password guess. Same shape and reasoning
 * as login: counts requests, not failures, far above human retry and far below
 * anything useful to an attacker. Its own pair, not login's — a field named for
 * one route used by another is a comment that lies.
 */
GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS:   z.coerce.number().int().positive().default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS),   // 10
GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(DEFAULT_GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS),  // 60
```

- `GOOGLE_ISSUERS` **não** entra no env — constante no adapter, valor fechado
  (§4.3).
- `.env.example` e `docs/local.md` ganham `GOOGLE_CLIENT_ID` com um valor
  placeholder e um comentário; `GOOGLE_JWKS_URI` fica de fora (o default serve
  produção e desenvolvimento).
- `src/infra/config/fixtures/test-env.ts` ganha `GOOGLE_CLIENT_ID`,
  `GOOGLE_JWKS_URI` (o default) e o par de rate limit — o fixture é exaustivo, e
  `env.ts` mata o processo num env inválido.
- `vitest.config.ts` (`test.env`) ganha `GOOGLE_CLIENT_ID` — o projeto de
  integração usa `parseEnv`, que morre sem ele.

### 7.2 — Migration

`drizzle-kit@1.0.0-rc.4` (pasta autocontida, sem `_journal.json`):

1. Novo `schema/federated-identities.ts`; `schema/users.ts` perde o `.notNull()`
   do `password_hash`.
2. `pnpm db:generate` → diff contra o snapshot da última pasta
   (`…_create_password_reset_tokens_table`) → emite **uma pasta** com `CREATE
   TABLE federated_identities` + os três índices + `ALTER TABLE users ALTER COLUMN
   password_hash DROP NOT NULL`.
3. `pnpm db:migrate` local. História final: `users` → `refresh_tokens` →
   `pending_registrations` → `password_reset_tokens` → `federated_identities`.

Sem exceção a R4 — nada apagado, só um `ALTER` aditivo e uma tabela nova.

### 7.3 — DI

- `authRepositories(db)` passa a devolver também `federatedIdentities: new
  DrizzleFederatedIdentitiesRepository(db)`.
- `AuthRepos` ganha `federatedIdentities`; comentário de doutrina atualizado.
- `makeAuthContainer`: `const googleIdentityVerifier = new
  JoseGoogleIdentityVerifier(config)` — a fatia `Pick<AuthConfig,
  'GOOGLE_CLIENT_ID' | 'GOOGLE_JWKS_URI'>` sai do `config` que já chega. Sem
  parâmetro novo: o e2e do §9.2 troca a `GOOGLE_JWKS_URI` via override de env no
  `buildApp`, não por injeção.
  - `signInWithGoogle: new SignInWithGoogleUseCase(googleIdentityVerifier,
    usersRepository, federatedIdentitiesRepository, uow, refreshTokenIssuer,
    tokenSigner, hashProvider, idGenerator, clock, bestEffortEmailSender)`.
  - `googleSignInRateLimit: { max: config.GOOGLE_SIGN_IN_RATE_LIMIT_MAX_REQUESTS,
    timeWindow: config.GOOGLE_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS *
    MILLISECONDS_PER_SECOND }`.
- `InMemoryFederatedIdentitiesRepository` para os testes unitários.
- Nenhum job novo no `cron.ts`.

## 8. Arquivos tocados

**Novos:**

- `src/modules/auth/entities/federated-identity.ts` + `.spec.ts`
- `src/modules/auth/ports/google-identity-verifier.ts`
- `src/modules/auth/infra/providers/jose-google-identity-verifier.ts` (spec em `tests/integration/`, ver §9.2)
- `src/modules/auth/repositories/federated-identities-repository.ts`
- `src/modules/auth/infra/drizzle/schema/federated-identities.ts`
- `src/modules/auth/infra/drizzle/federated-identity-mapper.ts`
- `src/modules/auth/infra/drizzle/drizzle-federated-identities-repository.ts`
- `src/modules/auth/infra/in-memory/in-memory-federated-identities-repository.ts`
- `src/modules/auth/errors/invalid-google-identity-error.ts`
- `src/modules/auth/errors/google-link-requires-password-error.ts`
- `src/modules/auth/errors/google-sign-in-conflict-error.ts`
- `src/modules/auth/use-cases/sign-in-with-google.ts` + `.spec.ts`
- `src/modules/auth/infra/http/endpoints/sign-in-with-google.ts`
- `tests/integration/setup/google-jwks.ts` (helper: par RS256 + servidor JWKS efêmero + assinatura de ID token de teste)
- `tests/integration/drizzle-federated-identities-repository.spec.ts`
- `tests/integration/federated-identities-schema.spec.ts`
- `tests/integration/jose-google-identity-verifier.spec.ts`
- `tests/integration/sign-in-with-google.spec.ts`
- `drizzle/<timestamp>_…/` (migration gerada)

**Modificados:**

- `src/modules/auth/entities/user.ts` + `.spec.ts` — `createFederated`, `passwordHash` nulável
- `src/modules/auth/infra/drizzle/schema/users.ts` — `password_hash` sem `.notNull()`
- `src/modules/auth/infra/drizzle/user-mapper.ts` — `null` nos dois sentidos
- `src/modules/auth/repositories/pending-registrations-repository.ts` — `deleteAllByEmail`
- `src/modules/auth/infra/drizzle/drizzle-pending-registrations-repository.ts` + in-memory + `.spec.ts` de integração
- `src/modules/auth/repositories/unit-of-work.ts` — `AuthRepos.federatedIdentities` + comentário
- `src/modules/auth/infra/drizzle/auth-repositories.ts` — monta o repo novo
- `src/modules/auth/config.ts` — `GOOGLE_CLIENT_ID`, `GOOGLE_JWKS_URI`, `GOOGLE_SIGN_IN_RATE_LIMIT_*` + os `DEFAULT_*`
- `src/infra/config/env.ts` — nada (merge automático pelo `.extend(authEnvSchema.shape)`)
- `src/infra/config/fixtures/test-env.ts` — `GOOGLE_CLIENT_ID`, `GOOGLE_JWKS_URI`, `GOOGLE_SIGN_IN_RATE_LIMIT_*`
- `vitest.config.ts` — `test.env.GOOGLE_CLIENT_ID` (o projeto de integração roda `parseEnv`)
- `src/modules/auth/container.ts` — `new JoseGoogleIdentityVerifier(config)`, o use case, o rate limit, o repo. Sem parâmetro novo na assinatura
- `src/modules/auth/infra/http/routes.ts` — uma linha
- `src/modules/auth/infra/http/constants.ts` — se algum status novo faltar (409 já existe)
- `src/modules/auth/use-cases/login-user.ts` — comentário do ramo `null`
- `src/modules/auth/use-cases/change-password.ts` + `.spec.ts` — guard de `passwordHash === null`
- `src/modules/auth/notifications/emails.ts` + `.spec.ts` — `googleAccountLinkedEmail`
- `src/modules/auth/README.md` — endpoint, fluxo, garantias
- `tests/integration/users-schema.spec.ts` — `password_hash` nulável
- `.env.example`, `docs/local.md` — `GOOGLE_CLIENT_ID`
- `docs/DECISIONS.md` — **decisão 31**; marcar itens 1–3 de "Login social" da §6 como resolvidos
- `docs/TODO.md` — mover "Login social / OAuth (Google)" para entregue; anotar o que fica (redirect/BFF, desvincular, primeira senha, listar provedores, `hd`)

## 9. Testes

### 9.1 — Unitários (`pnpm vitest run --project unit <arquivo>`)

- **Novo** `entities/federated-identity.spec.ts` — `create`/`fromTrusted`,
  `Object.freeze`, `JSON.stringify` → `{}`, clonagem de datas.
- **Novo** `use-cases/sign-in-with-google.spec.ts` — os cinco ramos:
  - já vinculado → sessão, **sem `uow`**, `findById` chamado;
  - e-mail novo → `User.createFederated` (hash null, verificada) + identity +
    `deleteAllByEmail` + primeiro refresh token + sessão, **tudo em um `uow`**;
  - conta com senha, sem `password` → `GoogleLinkRequiresPasswordError`, nada
    escrito;
  - conta com senha, senha errada → `InvalidCredentialsError`, **`argon2` rodou,
    fora do `uow`**, nada escrito;
  - conta com senha, senha certa → identity + refresh token em um `uow` +
    `googleAccountLinkedEmail` best-effort **depois do commit** + sessão;
  - `emailVerified:false` / token ruim (verifier lança) → `InvalidGoogleIdentityError`;
  - conta só-federada + `sub` não casa → `GoogleSignInConflictError`;
  - corrida no `users.save` (`EmailAlreadyInUseError`) → borbulha;
  - `now` lido uma vez.
  - Falsificação: `toEqual` no log de chamadas inteiro.
  O verificador é um fake do port; o `jwtVerify` real é o teste de integração do
  adapter (§9.2).
- **Atualizado** `entities/user.spec.ts` — `createFederated` → `passwordHash`
  null, nasce verificada; `fromTrusted` aceita `passwordHash` null.
- **Atualizado** `use-cases/login-user.spec.ts` — usuário só-federado
  (`passwordHash` null) + qualquer senha → `InvalidCredentialsError` pelo decoy.
- **Atualizado** `use-cases/change-password.spec.ts` — usuário só-federado →
  `InvalidCurrentPasswordError`, **decoy rodou** (tempo plano), nada escrito.
- **Atualizado** `notifications/emails.spec.ts` — `googleAccountLinkedEmail` tem
  `to`, `subject`, `text`.

### 9.2 — Integração (`tests/integration/`, limpa as próprias tabelas no `beforeEach`)

- **Novo** `drizzle-federated-identities-repository.spec.ts` — `save`;
  `findByProviderUserId` (match e `null`, case do `provider`); `unique (provider,
  provider_user_id)` viola em duplicata; `unique (user_id, provider)` viola no
  segundo vínculo do mesmo provedor; FK `ON DELETE CASCADE` ao deletar o `users`.
- **Novo** `federated-identities-schema.spec.ts` — colunas, os três índices, sem
  defaults de coluna, FK `ON DELETE CASCADE`.
- **Novo** `jose-google-identity-verifier.spec.ts` — o adapter **real**, com o
  helper `setup/google-jwks.ts` (par RS256 + servidor HTTP efêmero servindo o JWK
  Set). Constrói `new JoseGoogleIdentityVerifier({ GOOGLE_CLIENT_ID: <fixo>,
  GOOGLE_JWKS_URI: <uri local do helper> })` e assina os ID tokens com a chave
  privada. É integração e não unit porque `createRemoteJWKSet` busca o JWKS por
  HTTP. Casos: token válido (`iss` = um de `GOOGLE_ISSUERS`) → `{ subject, email }`;
  `aud` errado → `InvalidGoogleIdentityError`; `iss` errado → idem; expirado →
  idem; assinatura de outra chave → idem; `email_verified:false` → idem;
  `email`/`sub` ausente → idem. **Regressão do pin de `audience`**: um token com
  `aud` de outro client passa se o pin for removido.
- **Novo** `sign-in-with-google.spec.ts` (ponta a ponta) — o `JoseGoogleIdentityVerifier`
  **real**, com `buildApp({ ...env, GOOGLE_JWKS_URI: <servidor local> })`. O
  `beforeAll` sobe o helper `tests/integration/setup/google-jwks.ts` (par RS256 +
  servidor HTTP efêmero servindo o JWK Set) e assina os ID tokens com a chave
  privada, `iss: 'https://accounts.google.com'`, `aud: env.GOOGLE_CLIENT_ID`.
  Exercita o caminho real de `jwtVerify` sem tocar a rede do Google e sem fake.
  Casos:
  - e-mail novo → `200` + sessão + linha em `users` (hash null) + linha em
    `federated_identities`;
  - segundo sign-in com o mesmo `sub` → `200` pelo fast path (nenhuma linha nova
    de identidade);
  - e-mail com conta-senha, sem `password` → `409 GOOGLE_LINK_REQUIRES_PASSWORD`;
  - e-mail com conta-senha, com `password` certa → `200` + linha de identidade +
    e-mail no Mailpit;
  - e-mail com conta-senha, `password` errada → `401`;
  - e-mail com cadastro pendente → `200` + conta verificada + **pendentes
    apagados**;
  - `refreshTransport: "cookie"` → `Set-Cookie` com os atributos de
    `refresh-cookie.ts`;
  - `.strict()` rejeita campo extra → `400`.
- **Atualizado** `users-schema.spec.ts` — `password_hash` aceita `NULL`.
- **Atualizado** `drizzle-pending-registrations-repository.spec.ts` —
  `deleteAllByEmail` apaga linhas vivas E consumidas do endereço.

## 10. Custos aceitos

- **Primeira dependência de rede outbound do app.** O sign-in do Google passa a
  depender de `www.googleapis.com` alcançável. Mitigado pelo cache de JWKS do
  `jose` (respeita `Cache-Control`, serve a chave em cache dentro do cooldown).
  Falha de fetch do JWKS → `InvalidGoogleIdentityError` ou 500 → "entrar com
  Google" fora do ar; **login por senha intacto**.
- **`users.password_hash` nulável.** Todo leitor precisa tratar `null`. `login` já
  trata (via `??`); `change-password` ganha guard; `/me` nunca expôs a coluna.
  Registrado para a `architecture-audit`.
- **Conta só-federada não tem senha nem como definir uma no fluxo.** Google-only
  até a fatia de "primeira senha". Perdeu o acesso ao Google, perdeu a entrada — a
  recuperação de senha não alcança (não há senha para "recuperar"). Dito em voz
  alta.
- **`409 GOOGLE_LINK_REQUIRES_PASSWORD` é um oráculo de existência de conta** —
  *para quem já passou pela verificação do Google naquele e-mail*. Abençoado pela
  decisão §6; restado aqui.
- **Replay de ID token roubado** dentro da janela `exp` (~1 h) → o atacante ganha
  sessão daquele usuário. **Não checamos `nonce`** — não dirigimos o redirect,
  não emitimos nonce. Mesmo modelo de confiança de qualquer bearer assertion;
  mitigado por TLS, `exp` curto, e o token só ser exposto ao cliente que o pediu.
  O fluxo redirect/BFF futuro fecha isto com `state`+`nonce`.
- **`sub` do Google reassociado** (Workspace deleta+recria uma conta) → uma
  segunda identidade Google para um e-mail já de um usuário só-federado cai no
  `409 GOOGLE_SIGN_IN_CONFLICT`. Raro; aceito.
- **Sem `azp` / multi-cliente.** Só validamos `aud === GOOGLE_CLIENT_ID`. Um
  segundo client id (ex.: um app iOS e um Android com ids distintos) exigiria
  aceitar uma lista de `aud` e/ou tratar `azp`.
- **`InvalidGoogleIdentityError` sem log** (`securityEvent: false`) — um martelo
  de tokens forjados não deixa rastro além do rate-limit de borda. Consistente
  com o resto do `auth` (decisão 15); reabrir junto com a trilha de auditoria da
  auditoria de 2026-09-07.
- **`GOOGLE_CLIENT_ID` obrigatório no boot** — quem forka o boilerplate e não usa
  Google precisa de um placeholder no `.env`. Resolvido com `.env.example`; segue
  a decisão 14 ("todo env validado no boot, uma lista só de problemas").

## 11. Fora de escopo

- **Fluxo redirect / BFF** (`GET /auth/google/start` + `/callback`) — reusa este
  núcleo de vínculo; precisa de store de `state`+PKCE, HTTP outbound de verdade e
  `GOOGLE_CLIENT_SECRET`. Fecha o replay de ID token com `state`+`nonce`.
- **Desvincular um provedor** — como deleção de conta, fatia própria (é um
  `DELETE` na linha, mais a regra "não desvincule o último meio de entrada").
- **Definir a primeira senha** numa conta só-Google — fatia própria.
- **Listar provedores vinculados no `GET /me`** — adicionar quando uma tela de
  settings pedir; `findByUserId` no repo entra junto.
- **Restrição de domínio (`hd` / Google Workspace)** — vira config quando um
  produto Workspace-only precisar.
- **Outros provedores (Apple, GitHub)** — a tabela é genérica (`provider`), mas só
  `google` é ligado.
- **Merge de duas linhas `users` distintas** — não acontece neste design:
  vinculamos à linha existente, nunca fundimos linhas.
- **Invalidar sessões + notificar o dono na verificação/vínculo** — defesa em
  profundidade da auditoria de 2026-09-07; não bloqueia esta fatia (o e-mail de
  aviso do §6.3 já é um primeiro passo).

## 12. Decisões registradas

### 12.1 — Client-driven sobre redirect/BFF

O redirect/BFF é o padrão para um front web com backend próprio, mas o
client-driven POST é o que a maioria dos apps mobile faz, é a entrega menor, não
precisa de `state` store nem `GOOGLE_CLIENT_SECRET`, e casa com a decisão 12
(corpo, um processo para os dois clientes) e a decisão 13 (que já previu receber
um token). O redirect vira fatia futura **reusando o núcleo de vínculo desta** —
os passos 4–8 do §5 não mudam; só a borda de "como a identidade Google chega".

### 12.2 — `409 GOOGLE_LINK_REQUIRES_PASSWORD` específico, e por que não vaza

A decisão §6 item 3 já registra: a recusa pode ser **específica** — "este e-mail
já tem conta com senha" — sem virar oráculo de enumeração, porque no ponto em que
ela acontece o IdP **já provou** que quem está ali é dono do endereço. É a única
porta do `auth` onde contar a verdade não vaza nada, e destoa de propósito do
`202` genérico do `register` e do erro único do `confirm`.

### 12.3 — Sem hash-isca nos ramos sem senha

O `confirm` roda `argon2` incondicionalmente porque lá o timing separava "código
válido" de "inválido". Aqui não há esse sinal a esconder: o `409` sem senha é a
resposta pública esperada, e os ramos "já vinculado" / "conta nova" / "conta com
senha" divergem por dados que o cliente já conhece (ele sabe se mandou senha).
Rodar um decoy nos passos 4 e 6 seria custo de CPU sem propriedade de segurança.

### 12.4 — `password_hash` nulável em vez de sentinela

Uma sentinela (um hash que nunca casa) mantém a coluna `NOT NULL` mas grava uma
mentira, obriga todo leitor a conhecê-la, e é frágil no `argon2.compare`. `NULL`
é o estado honesto — não há senha — e o `login` já o absorve pelo `?? dummyHash`.

### 12.5 — Fecha os itens 1–3 de "Login social" da §6 do `DECISIONS.md`

- **Item 1** (não haverá troca de e-mail) — respeitado: o sign-in casa por `sub`,
  nunca reescreve `users.email`, e `email_at_link` registra o que o Google
  afirmou no vínculo sem virar autoridade sobre o endereço.
- **Item 2** (Google sobre cadastro pendente: Google ganha, conta nasce
  verificada, pendentes descartados) — passo 6 do §5 + `deleteAllByEmail`.
- **Item 3** (Google sobre conta verificada com senha: sem merge silencioso,
  exige a senha, então vincula) — passo 8 do §5.

Precisa de uma **decisão 31** no `DECISIONS.md` registrando o formato
client-driven, a tabela `federated_identities`, `password_hash` nulável, e a
marcação dos itens 1–3 como resolvidos.
