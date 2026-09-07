# Fatia 12 — Recuperação de senha: design

> Escrito em 2026-09-07, ao fim da fatia 11. Contexto de entrada:
> [`2026-09-07-handoff-password-recovery.md`](../2026-09-07-handoff-password-recovery.md).
> Fecha o último endpoint ausente do fluxo de `auth`.

## 1. O que esta fatia entrega

Os dois endpoints que faltam para o fluxo de `auth` ficar completo como
boilerplate v1:

- **`POST /auth/password/forgot`** — corpo `{ email }`, responde `202` sempre,
  sem corpo. Se o endereço tem conta, um token de reset vai para a caixa dele.
  Se não tem, **nada acontece** — mesma resposta, mesma razão do `register`
  (§6.1 da spec de verificação): ninguém enumera contas por aqui.
- **`POST /auth/password/reset`** — corpo `{ token, newPassword }`, troca a
  senha, **revoga todas as sessões** da conta, responde `204` sem corpo. Token
  inexistente / errado / expirado / gasto → um erro só, genérico
  (`422 PASSWORD_RESET_FAILED`).

O token é um **valor opaco de 256 bits** — a mesma infraestrutura do refresh
token —, não um código de seis dígitos. Depois desta fatia o `auth` tem
cadastro, verificação, login, sessão com rotação, troca de senha **e**
recuperação. O próximo grande bloco é o login social.

## 2. O buraco que fecha

Hoje uma conta com senha esquecida — ou tomada por qualquer via — **não tem
caminho de volta**: `POST /auth/password` (fatia 9) exige a senha atual. Não há
endpoint que troque a senha provando só controle da caixa de e-mail.

A fatia estava travada atrás do pre-hijacking (fatia 11) por um motivo concreto:
construir recuperação sobre um desenho de cadastro vulnerável amplia a
superfície. Com a fatia 11 fechada, está desbloqueada.

A infra já foi paga: a fatia 10 entregou o provedor de e-mail e o thunk que
mantém o envio fora da transação; a fatia 11 deixou o molde de tabela com
hash / expiração / uso único, o `consume` atômico, o helper de teste
`arrangeAccount` e a conta que **sempre** nasce verificada — então "reset só
para conta verificada" é trivialmente sempre verdade e não precisa de checagem.

## 3. Decisões tomadas no brainstorming

As cinco perguntas da seção 4 do handoff, e as sub-decisões que elas abriram.

### 3.1 — Token: valor opaco de 256 bits, não código de seis dígitos

`ITokenGenerator.opaque()` (32 bytes, base64url) + digest sha256 + lookup por
índice único. É a metade "refresh token" do módulo, não a metade "código de
verificação".

**Por quê:** o `reset` é grau-de-takeover — quem resgata um token válido troca a
senha de uma conta que já tem dono e sessões. Um código de seis dígitos (~20
bits) atrás desse endpoint só é seguro com TTL curto **e** teto de tentativas
apertado, e uma botnet distribuída contra 10^6 com só o rate limit por IP é
exatamente a exposição que o `DECISIONS.md` §6 já registra como "nada no
servidor vai notar". 256 bits tiram a força bruta de cena por construção: sem
coluna `attempts`, sem `maxAttempts`, sem `registerFailedAttempt`, TTL pode ser
mais longo.

**Custo:** destoa da forma do `confirm` — o corpo do `reset` carrega `token`, não
`code` —, mas casa com o refresh token, que já usa `opaque()` + `ITokenDigest` +
índice único. Ver §12.1.

### 3.2 — Um token vivo por conta, sobrescrito a cada `forgot`

O pre-hijacking exigiu pendentes coexistentes **porque o pendente carregava
senha**. O token de reset não carrega nada além de prova de controle da caixa
para uma conta **que já existe** — então **um token vivo por conta**, com o
anterior invalidado a cada `forgot`, é seguro e mais simples. O cooldown do
`forgot` segura o flood.

Consequência de modelo: índice `unique (user_id)` na tabela, e o `forgot` é um
**upsert** (`INSERT … ON CONFLICT (user_id) DO UPDATE`), não um
`find`-então-`insert`-ou-`update`. Ver §12.2.

### 3.3 — O `reset` responde `204`, sem tokens

**Parte já resolvida (não foi brainstorming):** o `reset` revoga **todas** as
sessões da conta — a pessoa esqueceu a senha, assume-se comprometimento.

**Parte decidida:** a resposta **não** carrega par de tokens. `reset` responde
`204`, sem corpo, sem `refreshTransport`, sem cookie. O cliente vai para a tela
de login e entra com a senha nova — o que **prova** a senha recém-definida.

**Por quê:** quem chega ao `reset` está **não autenticado**, provou só controle
da caixa. Auto-logar seria o `reset` cunhar sessão a partir de prova-de-caixa
apenas. O `change-password` escolheu auto-login porque o chamador **já** segurava
um access token válido; aqui não. O atrito de um login em seguida é irrisório.
Ver §12.3.

### 3.4 — Silêncio total para endereço sem conta

`forgot` responde `202` sempre. Para um endereço **com** conta, manda o token.
Para um endereço **sem** conta: nada é enviado.

**Por quê:** o §6.1 da spec de verificação manda o e-mail "você já tem conta" no
`register` para não deixar quem esqueceu num limbo. O caso do `forgot` é o
oposto — endereço sem conta nenhuma, não há limbo a evitar —, e mandar e-mail
para um endereço que não pediu nada é ruído disparável por anônimo. O §12.9 da
spec de verificação já mostra o custo de manter e-mails sem cooldown por
endereço.

### 3.5 — O `reset` roda argon2 só no ramo de token válido

O handoff escreveu esta pergunta supondo que o token *podia* ser código de seis
dígitos. Com token opaco de 256 bits o cálculo muda.

`Password.create(newPassword)` roda primeiro (política do VO → `400` barato).
Depois: digest do token → lookup → token inexistente / expirado / gasto → `throw
PasswordResetFailedError()` **sem argon2**. `hashProvider.hash()` só roda no ramo
de token válido.

**Por quê:** o oráculo de tempo "esse token era válido" só serve para quem
consegue **enumerar tokens**. Com 256 bits, não consegue — o sinal de latência
não vale nada. Evita pagar ~7 ms / 19 MB de argon2 em cada request de
token-lixo. Diverge do `confirm` de propósito: o `confirm` protege um código
adivinhável; aqui o segredo é inadivinhável. Ver §12.4.

## 4. Modelo de dados

### 4.1 — Nova tabela `password_reset_tokens`

`src/modules/auth/infra/drizzle/schema/password-reset-tokens.ts` — uma tabela,
um arquivo, nomeado pela tabela. É a **4ª** migration:
`users → refresh_tokens → pending_registrations → password_reset_tokens`.

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | `uuid` PK | de `IIdGenerator` |
| `user_id` | `uuid` NOT NULL → `users(id)` `ON DELETE CASCADE` | FK legal: mesmo módulo (decisão 24). Cascade fecha o "usuário deletado entre `forgot` e `reset`" — ver §6.2 |
| `token_hash` | `text` NOT NULL | sha256 (hex) do token opaco. **Nunca** o token |
| `issued_at` | `timestamptz` NOT NULL | anda a cada `forgot`; o cooldown lê isto |
| `expires_at` | `timestamptz` NOT NULL | `issued_at` + TTL, aritmética de `IClock` no use case |
| `consumed_at` | `timestamptz` NULL | `NULL` = vivo. Setado por um `reset` bem-sucedido |
| `created_at` | `timestamptz` NOT NULL | imutável; ordem de poda e auditoria |

**Sem defaults de coluna**, como `refresh_tokens.ts` e `pending_registrations.ts`:
Postgres guarda `timestamptz` em microssegundos e um `Date` de JS tem
milissegundos, e `isUsable` compara instantes — todo timestamp vem do `IClock` e
os dois lados de toda comparação partilham a fonte.

Índices:

- `unique (user_id)` — **um token vivo por conta** (§3.2). É o alvo do `ON
  CONFLICT` do upsert. Nome inline: aparece exatamente uma vez, a exceção de
  arquivo de schema do `CLAUDE.md` se aplica.
- `unique (token_hash)` — o caminho de lookup do `reset`. **Nome exportado como
  constante `PASSWORD_RESET_TOKENS_TOKEN_HASH_UNIQUE_INDEX`**, no próprio arquivo
  de schema, espelhando `REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX`: um `23505`
  aqui não é erro de banco, é alarme de "o gerador de token regrediu para algo
  de baixa entropia" — 32 bytes de `randomBytes` não colidem. O repositório lê o
  nome de volta para reconhecer o alarme, então o nome deixa de aparecer uma vez
  só e vira constante (a ressalva do `CLAUDE.md`).

**Sem coluna `attempts`** e sem índice sobre `token_hash` parcial: 256 bits não
precisam de teto de tentativas (§3.1).

### 4.2 — `issued_at` separado de `created_at`

Mesma razão da fatia 11: `issued_at` move a cada `forgot` (o upsert reescreve a
linha do usuário), `created_at` é imutável e só serve para ordem de poda e
auditoria. `consumed_at` marca **só** "resgatado por um reset" — um `forgot`
dentro do TTL não consome o token anterior, ele o **sobrescreve** (o
`token_hash` antigo deixa de existir na linha, então o link antigo morre).

## 5. Camada de domínio

### 5.1 — Nova entidade `entities/password-reset-token.ts`

Espelha `PendingRegistration` menos `attempts` e `matches`.

- Campos `#` privados, não-enumeráveis em runtime: `JSON.stringify(token)` dá
  `{}`, o digest não escapa por um `reply.send(token)` ou um `log.info({ token
  })` acidental.
- `create({ id, userId, tokenHash, now, ttlSeconds })` — nasce não-consumido.
  `expiresAt = now + ttlSeconds * 1000`, derivado do clock injetado, não de
  default de coluna.
- `fromTrusted(props)` — rehidrata uma linha. Validação é trabalho do `create`.
- `isUsable(now)` — `consumedAt === null && expiresAt.getTime() > now.getTime()`.
  Inclusivo na fronteira de expiração, como `PendingRegistration.isUsable`: um
  instante que chegou está gasto. **Sem** parâmetro `maxAttempts`.
- **Sem `matches(codeHash)`**: `pending_registrations` precisa porque busca todas
  as linhas de um e-mail (códigos de seis dígitos colidem) e filtra em memória;
  aqui `findByHash` devolve exatamente a linha ou `null`, então o lookup por
  digest **é** o match.
- Getters: `id`, `userId`, `tokenHash`, `issuedAt`, `expiresAt`, `consumedAt`,
  `createdAt` — o getter de `tokenHash` fica, como `PendingRegistration.codeHash`:
  o adapter in-memory precisa dele para o `findByHash`, e o campo `#` + `freeze`
  já barram serialização acidental (`JSON.stringify` dá `{}`).

### 5.2 — Novo contrato `repositories/password-reset-tokens-repository.ts`

`IPasswordResetTokensRepository` — três métodos.

```
/**
 * One statement: insert the user's first reset token, or refresh the existing
 * row IN PLACE — but only when the previous issue is older than the cooldown.
 * `INSERT ... ON CONFLICT (user_id) DO UPDATE SET token_hash = ?, issued_at = ?,
 * expires_at = ?, consumed_at = NULL WHERE password_reset_tokens.issued_at <= ?`
 * (the cooldown cutoff). Returns whether a row was written: false means the
 * caller is inside the cooldown and sends nothing.
 *
 * The cooldown lives in the DO UPDATE's WHERE, not in a prior read, so two
 * concurrent `forgot` for one account cannot both mint — Postgres serializes
 * the upsert on the `user_id` unique index.
 */
issueOrRefresh(params: {
  id: string            // used only on the INSERT path
  userId: string
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  cooldownCutoff: Date  // issued_at must be <= this for the refresh to fire
}): Promise<boolean>

/**
 * The `reset` lookup, by the `token_hash` unique index. Returns null for a
 * digest that matches no row — the caller turns that into the one generic
 * failure. Does NOT filter expiry or `consumed_at`: usability is the entity's
 * judgement against the injected clock (same doctrine as
 * `findUnconsumedByEmail`).
 */
findByHash(tokenHash: string): Promise<PasswordResetToken | null>

/**
 * Burns the token: `UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at
 * IS NULL`. Returns whether THIS call is the one that burned it — of two
 * concurrent resets redeeming the same token, one loses the conditional update
 * and the caller turns that into the same generic failure. Verbatim from
 * `pending_registrations`.
 */
consume(id: string, at: Date): Promise<boolean>
```

**Sem `registerFailedAttempt`** (§3.1). **Sem `deleteExpiredByEmail`**: o
`issueOrRefresh` já reescreve a linha daquele usuário a cada `forgot`; linhas
órfãs de quem nunca volta são trabalho do cron futuro (handoff §8), não deste
fluxo.

O adapter Drizzle é `infra/drizzle/drizzle-password-reset-tokens-repository.ts`,
com `password-reset-token-mapper.ts` (`toDomain` / `toPersistence`) espelhando
`pending-registration-mapper.ts`. O `save` de `issueOrRefresh` nunca vaza o erro
cru do driver (a Drizzle cola todo parâmetro bound na mensagem, e este bind
carrega o digest): `toPersistenceError`, como o repo de pendentes.

O adapter in-memory é
`infra/in-memory/in-memory-password-reset-tokens-repository.ts`, para os testes
unitários dos use cases (decisão 09). Ele modela **nenhum** row lock e nenhuma
corrida de update condicional — a atomicidade de `issueOrRefresh` e `consume` é
provada contra Postgres real na integração.

### 5.3 — `AuthRepos` e o Unit of Work

`AuthRepos` ganha `passwordResetTokens: IPasswordResetTokensRepository`.
`authRepositories(db)` constrói `DrizzlePasswordResetTokensRepository(db)`. A
transação do `reset` toca `users` + `refresh_tokens` + `password_reset_tokens` —
três tabelas, um átomo (senha trocada, sessões revogadas, token consumido: ou
tudo acontece ou nada), exatamente o caso do `AuthRepos` + uow.

### 5.4 — Novo serviço `services/password-reset-issuer.ts`

`PasswordResetIssuer` — espelha `EmailVerificationIssuer`.

```
export type DeliverPasswordReset = () => Promise<void>

export class PasswordResetIssuer {
  constructor(
    private readonly emailSender: IEmailSender,
    private readonly tokenGenerator: ITokenGenerator,
    private readonly tokenDigest: ITokenDigest,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * Mints a fresh 256-bit opaque token, returns its digest for the caller to
   * persist and the deferred send. Nothing here persists or sends.
   */
  issue(email: Email): { tokenHash: string; deliver: DeliverPasswordReset } {
    const token = this.tokenGenerator.opaque()
    return {
      tokenHash: this.tokenDigest.hash(token),
      deliver: () => this.emailSender.send(passwordResetEmail(email, token, this.ttlSeconds)),
    }
  }
}
```

Mesma disciplina "devolve o envio diferido, o caller persiste, o caller envia
depois" (§8 do Unit of Work) — mas na variante `register`: o `forgot` não abre
transação, então é write-then-send sem rollback a temer.

### 5.5 — Templates de e-mail e a renomeação de `verification-email.ts`

O arquivo `notifications/verification-email.ts` é, de propósito, o único lugar
onde mora o texto de **toda** mensagem que o sistema envia. Ele já carrega
`verificationEmail`, `accountAlreadyExistsEmail` e `passwordChangedEmail` — o
nome ficou estreito. **Renomear para `notifications/emails.ts`** (`git mv` +
ajustar os imports em `register-user.ts`, `change-password.ts` e os novos), e
adicionar:

- `passwordResetEmail(to, token, ttlSeconds)` — carrega o token, TTL em minutos,
  "se você não pediu isto, ignore esta mensagem; sua senha não muda".
- `passwordResetCompletedEmail(to)` — aviso pós-reset: "sua senha foi redefinida
  pelo fluxo de recuperação e todas as sessões foram encerradas. Se não foi
  você, refaça a recuperação de senha agora" — uma segunda recuperação tranca um
  atacante que tenha obtido o token.

Template dedicado, não reuso de `passwordChangedEmail`: o "se não foi você"
aponta para ações diferentes (lá, alguém tinha seu access token; aqui, alguém
teve acesso ao token de reset ou à sua caixa). Ver §12.5.

## 6. Fluxos

### 6.1 — `forgot`

`RequestPasswordResetUseCase.execute({ email }): Promise<void>`. Espelha o
`RegisterUserUseCase`: nunca abre transação, plano de entrega + um único `await
deliver()` no fim.

```
1. email = Email.create(command.email)
   VO — InvalidEmailError (→ ValidationError → 400) antes de qualquer leitura.
   No HTTP o schema Zod já barra com 400; o VO defende os entrypoints não-HTTP
   (decisão 10).

2. now = clock.now()
   Lido uma vez: carimba issued_at e expires_at.

3. deliver = await #planDelivery(email, now)

4. await deliver()
   UMA chamada para todo ramo — o control flow é o que torna as respostas
   indistinguíveis (§5.4 da spec da fatia 11).

#planDelivery(email, now):
  user = await usersRepository.findByEmail(email)   // Pick<IUsersRepository, 'findByEmail'>
  if (user === null) return NO_DELIVERY             // endereço sem conta → silêncio total (§3.4)

  { tokenHash, deliver } = issuer.issue(user.email)
  // user.email, o endereço ARMAZENADO, não command.email: o lookup casou por
  // Postgres lower() e Email.create dobra com toLowerCase() do JS — os dois
  // divergem em codepoints exóticos. Mesma razão do register.

  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
  const cooldownCutoff = new Date(now.getTime() - resendCooldownMs)
  const wrote = await passwordResetTokens.issueOrRefresh({
    id: idGenerator.generate(), userId: user.id, tokenHash,
    issuedAt: now, expiresAt, cooldownCutoff,
  })

  return wrote ? deliver : NO_DELIVERY
  // wrote === false: dentro do cooldown. O token recém-cunhado é descartado
  // (bytes aleatórios + digest, custo de ruído), como o confirm descarta o
  // hash-isca no no-match.
```

`NO_DELIVERY` é o `async () => {}` do `register` — todo ramo termina no mesmo
`await deliver()`, nenhum pode começar a divergir.

Construtor: `usersRepository: Pick<IUsersRepository, 'findByEmail'>`,
`passwordResetTokens: Pick<IPasswordResetTokensRepository, 'issueOrRefresh'>`,
`issuer: PasswordResetIssuer`, `clock`, `idGenerator`, `resendCooldownMs`,
`ttlSeconds`. **Não** recebe `IEmailSender` direto — o `forgot` não tem ramo
"conta já existe" como o `register`, então só o issuer envia.

### 6.2 — `reset`

`ResetPasswordUseCase.execute({ token, newPassword }): Promise<void>`.

```
1. newPassword = Password.create(command.newPassword)
   VO — InvalidPasswordError (→ 400/422) ANTES de qualquer leitura. Nenhum token
   é tocado por um payload que nem chegou a tentar. No HTTP o schema já barra.

2. now = clock.now()
   Lido uma vez: alimenta isUsable, e carimba updated_at e todo revoked_at.

3. tokenHash = tokenDigest.hash(command.token)

4. row = await passwordResetTokens.findByHash(tokenHash)   // fora da transação

5. if (row === null || !row.isUsable(now))
     throw new PasswordResetFailedError()
   Token inexistente, expirado ou já consumido: tudo colapsa num throw só (§6.3
   da spec da fatia 10, "um erro para todo modo de falha"; ramos que
   reportassem diferente virariam oráculo). SEM argon2 aqui (§3.5).

6. user = await usersRepository.findById(row.userId)   // Pick<..., 'findById'>
   if (user === null) throw new PasswordResetFailedError()
   Defensivo e na prática inalcançável: o FK tem ON DELETE CASCADE, então um
   usuário deletado já teria levado a linha do token junto e o passo 5 teria
   dado throw. Genérico, não um erro novo. Necessário para o e-mail do passo 9.

7. passwordHash = await hashProvider.hash(newPassword.value)
   Argon2, fora da transação (§8). Só neste ramo (§3.5).

8. await uow(async ({ users, refreshTokens, passwordResetTokens }) => {
     if (!(await passwordResetTokens.consume(row.id, now))) {
       throw new PasswordResetFailedError()
       // Perdeu a corrida por ESTE token (dois resets concorrentes). O throw
       // DENTRO do callback aborta a transação — um return deixaria estado pela
       // metade.
     }
     await users.updatePasswordHash(row.userId, passwordHash, now)
     await refreshTokens.revokeAllForUser(row.userId, now)
     // Ordem livre entre os dois: não há insert de token novo para ser
     // "pego" pelo revokeAllForUser, ao contrário do change-password.
   })

9. await bestEffortEmailSender.send(passwordResetCompletedEmail(user.email))
   Depois do commit, como todo envio do módulo (§8). Best-effort: a senha já
   mudou, um 500 aqui desinformaria.

10. return   // o endpoint responde 204 (§3.3)
```

Sem `PasswordUnchangedError`: não há senha atual conhecida para comparar, e rodar
`compare` contra o hash armazenado gastaria outro argon2 para responder a mesma
pergunta. Reset com a senha igual à antiga é idempotente e inofensivo.

Construtor: `usersRepository: Pick<IUsersRepository, 'findById'>`,
`passwordResetTokens: Pick<IPasswordResetTokensRepository, 'findByHash'>` (o
`consume` vem do callback do `uow`, não do `Pick`), `uow`, `hashProvider`,
`tokenDigest`, `clock`, `bestEffortEmailSender: IEmailSender`.

### 6.3 — Por que o `forgot` não enumera

A resposta HTTP é `202` sem corpo para os três casos: endereço livre, endereço
com conta, endereço malformado já barrado no `400`. O canal que diverge é o
e-mail, e ele só chega para quem controla a caixa de uma conta que existe. Um
anônimo martelando o `forgot` com endereços não aprende nada da resposta nem da
latência — o ramo "sem conta" retorna `NO_DELIVERY` **antes** de qualquer write,
mas o ramo "com conta dentro do cooldown" também retorna `NO_DELIVERY`, então o
tempo não separa "existe" de "não existe" de forma estável. O rate limit por IP
(`PASSWORD_FORGOT_RATE_LIMIT_*`) é o teto de custo.

Duas ressalvas, aceitas. O argumento do parágrafo acima ("o ramo do cooldown
também volta sem envio") só cobre uma sonda **repetida**; a **primeira** sonda de
um endereço qualquer separa limpo, porque o `forgot` usa o `emailSender` **nu**
(não o wrapper best-effort) e **aguarda** o envio:

- **Latência da primeira sonda.** Um endereço com conta e fora do cooldown paga
  um round trip SMTP inteiro antes do `202`; um endereço sem conta volta logo
  após o `findByEmail`.
- **Status com SMTP degradado.** Com o servidor de e-mail fora do ar, um endereço
  com conta estoura em `500` (o `deliver()` propaga); um sem conta ainda responde
  `202`.

Ambas são herdadas do `register` (mesmo sender nu, mesmo envio aguardado) — são
módulo-inteiro, não novas desta fatia — e o outbox transacional adiado (§5.3 /
§11) as fecharia, do mesmo jeito que fecharia o crash entre commit e envio.

## 7. Camada HTTP e erros

### 7.1 — Endpoints

Dois arquivos novos em `infra/http/endpoints/`, ambos registrados em `routes.ts`
**sem** `guard` (não autenticados). O `POST /auth/password` (troca autenticada,
fatia 9) fica **intocado** — handoff §5.5: são caminhos novos, não uma variante
daquele; não empilhar no mesmo handler.

**`forgot-password.ts`** — `POST /password/forgot`

| | |
|---|---|
| Corpo | `z.object({ email: <mesma forma do register> }).strict()` |
| `.strict()` | um cliente mandando campo a mais toma `400`, como o `register` |
| Respostas | `202` (`z.null()`), `400` (`errorResponseSchema`), `429` |
| Rate limit | `container.forgotPasswordRateLimit` — par próprio, como o `register`: anônimo + manda e-mail = amplificador de spam |
| Sem `503` | não abre transação |
| Handler | `await container.forgotPassword.execute(request.body)` → `reply.status(202).send(null)` |

**`reset-password.ts`** — `POST /password/reset`

| | |
|---|---|
| Corpo | `z.object({ token, newPassword }).strict()` |
| `token` | `z.string().regex(/^[A-Za-z0-9_-]{32,64}$/)` — **só a forma** (base64url, faixa generosa), como o `code` do `confirm` valida só "seis dígitos". A checagem autoritativa é `findByHash` devolver `null`. Um valor claramente não-base64url toma `400`; qualquer coisa na forma toma `422` |
| `newPassword` | política inteira (`MIN`/`MAX`/`PASSWORD_POLICY_PATTERN` do value object), como o `register` e o `change-password`. `400` com `details` por campo, e publica a política no OpenAPI |
| Respostas | `204` (`z.null()`), `400`, `422` (`errorResponseSchema`), `429`, `503` |
| Rate limit | `container.resetPasswordRateLimit` — par próprio |
| `503` | abre transação para consumir o token: um deadlock que sobrevive às retentativas do runner vira `TransactionConflictError`, como no `confirm` |
| Handler | `await container.resetPassword.execute(request.body)` → `reply.status(204).send(null)` |

Sem `refreshTransport` em nenhum dos dois: o `forgot` não emite sessão e o
`reset` também não (§3.3).

### 7.2 — Taxonomia de erros — uma categoria de erro nova, zero categoria nova de status

`PasswordResetFailedError` em `errors/password-reset-failed-error.ts`:

- `code: 'PASSWORD_RESET_FAILED'`, `message` `'Password reset failed'`.
- Um erro só para todo modo de falha de token: inexistente, errado, expirado,
  gasto, corrida de `consume` perdida. Espelha `EmailVerificationFailedError`.
- Estende `BusinessRuleError` (de `#shared/errors/app-error`), como
  `EmailVerificationFailedError` e `InvalidCurrentPasswordError` — mapeia para
  `422`, sem oitava categoria na taxonomia: o corpo é bem formado, o que falhou
  foi uma regra, e `422` já existe desde a fatia 9.

`PASSWORD_RESET_FAILED` entra na lista de `code`s estáveis do `README.md` do
módulo.

## 8. Migrations, DI, config

### 8.1 — Migration

`pnpm db:generate` depois de criar o arquivo de schema, seguido do passo de
nomeação de migration que o projeto usa (as três existentes são diretórios com
prefixo de timestamp, ex. `..._create_pending_registrations`; a nova segue o
mesmo molde: `..._create_password_reset_tokens`). É a 4ª. Confere no diff que ela
cria só `password_reset_tokens` e seus dois índices únicos, e que o FK sai com
`ON DELETE CASCADE`.

### 8.2 — Container (`makeAuthContainer`)

- `passwordResetTokens` destruturado de `authRepositories(db)`.
- `passwordResetIssuer = new PasswordResetIssuer(emailSender, tokenGenerator,
  tokenDigest, config.PASSWORD_RESET_TTL_SECONDS)`.
- Renomear `passwordChangedEmailSender` → `bestEffortEmailSender` (o wrapper
  `BestEffortEmailSender(emailSender, logger)` não é específico de template) e
  compartilhar entre `changePassword` e `resetPassword`.
- `forgotPassword: new RequestPasswordResetUseCase(usersRepository,
  passwordResetTokens, passwordResetIssuer, clock, idGenerator,
  config.PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND,
  config.PASSWORD_RESET_TTL_SECONDS)`.
- `resetPassword: new ResetPasswordUseCase(usersRepository, passwordResetTokens,
  uow, hashProvider, tokenDigest, clock, bestEffortEmailSender)`.
- `forgotPasswordRateLimit` / `resetPasswordRateLimit`: `{ max, timeWindow }` em
  milissegundos, como os outros pares.

### 8.3 — Config (`config.ts` + `authEnvSchema`)

| Constante | Default | Nota |
|---|---|---|
| `DEFAULT_PASSWORD_RESET_TTL_SECONDS` | `1800` (30 min) | 256 bits: o TTL limita a janela em que um e-mail vazado fica explorável, não substitui entropia. Mais longo que os 15 min do código de verificação de propósito |
| `DEFAULT_PASSWORD_FORGOT_RESEND_COOLDOWN_SECONDS` | `60` | como `EMAIL_VERIFICATION_RESEND_COOLDOWN` |
| `DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_MAX_REQUESTS` | `10` | como `register` |
| `DEFAULT_PASSWORD_FORGOT_RATE_LIMIT_WINDOW_SECONDS` | `60` | |
| `DEFAULT_PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS` | `10` | como `confirm` |
| `DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS` | `60` | |

Todas entram no `authEnvSchema` como `z.coerce.number().int().positive().default(...)`,
com o comentário "rejeitar zero é o que rejeita vazio" que as outras já carregam.

## 9. Deleções e renomeações

- **Renomear** `notifications/verification-email.ts` → `notifications/emails.ts`
  (§5.5). Ajustar imports: `use-cases/register-user.ts`,
  `use-cases/change-password.ts`, e os testes que importam de lá.
- **Renomear** a variável `passwordChangedEmailSender` → `bestEffortEmailSender`
  no `container.ts` (§8.2). Nenhum outro arquivo a referencia por nome.
- Nada é deletado.

## 10. Testes

Rodados separadamente. `pnpm vitest run --project unit <arquivo>` para um só.

### 10.1 — Unitários

| Arquivo | Cobre |
|---|---|
| `entities/password-reset-token.spec.ts` | `isUsable` nas fronteiras (não-consumido/consumido, antes/na/depois da expiração); `create` nasce com `consumedAt === null` e `expiresAt` derivado; `JSON.stringify(token) === '{}'`; getters devolvem cópias de `Date` |
| `services/password-reset-issuer.spec.ts` | `issue` cunha via `opaque()`, devolve `tokenDigest.hash(token)` e um `deliver`; nada é enviado nem persistido até `deliver()` ser chamado; o `deliver` manda `passwordResetEmail` com o token cru e o TTL |
| `use-cases/request-password-reset.spec.ts` | e-mail desconhecido → nenhum `issueOrRefresh`, nenhum envio; conhecido e fora do cooldown → `issueOrRefresh` com os args exatos e envio; `issueOrRefresh` devolve `false` (cooldown) → nenhum envio; usa `user.email` armazenado, não `command.email`; control flow plano — **um** `await deliver()` em todo ramo. Falsificar com `toEqual` no log de chamadas inteiro (handoff §7) |
| `use-cases/reset-password.spec.ts` | senha malformada → lança antes de `findByHash`; `row === null` → `PasswordResetFailedError`, `hashProvider.hash` **nunca** chamado; token expirado / consumido → idem; ramo válido → `hash` uma vez, depois `uow` com `consume` → `updatePasswordHash` → `revokeAllForUser` **nessa ordem** (`toEqual` no log inteiro — mata deleção e reordenação); `consume` devolve `false` → `PasswordResetFailedError`, e `updatePasswordHash`/`revokeAllForUser` **não** foram chamados; e-mail `passwordResetCompletedEmail` enviado depois do commit, best-effort (um throw do sender não vira erro do use case) |
| `errors/password-reset-failed-error` | forma do contrato (`code`, `message`, status 422) — asserção com a string literal, não importando a constante, para não virar tautologia (como o `confirm`) |
| `config.spec.ts` (adições) | os seis defaults novos; `positive()` rejeita `0` e vazio |

### 10.2 — Integração (`tests/integration/`, cada suite limpa as próprias tabelas no `beforeEach`)

| Arquivo | Cobre |
|---|---|
| `drizzle-password-reset-tokens-repository.spec.ts` | `issueOrRefresh` insere quando não há linha; sobrescreve `token_hash`/`issued_at`/`expires_at` e zera `consumed_at` quando há; devolve `false` e **não escreve** quando `issued_at > cooldownCutoff`; sob **concorrência** (duas chamadas simultâneas), só uma escreve; `consume` devolve `true` uma vez e `false` na segunda, sob concorrência; `findByHash` casa por digest e devolve `null` para digest ausente |
| `forgot-password.spec.ts` | `202` para endereço conhecido **e** desconhecido; o Mailpit recebe um e-mail de reset só para o conhecido (espera por condição, nunca `sleep`); segunda chamada dentro do cooldown não gera segundo e-mail; o link/token do segundo `forgot` após o cooldown invalida o primeiro |
| `reset-password.spec.ts` | `arrangeAccount` cria a conta; dirige o `forgot` e lê o token real do Mailpit; `reset` responde `204`; login com a senha nova passa e com a antiga responde `401`; um refresh token emitido antes do reset responde `401` depois (todas as sessões revogadas); replay do mesmo token → `422`; token de uma linha expirada (montada direto no banco) → `422`; `token` fora da forma base64url → `400` |

## 11. Custos aceitos

### Herdados

- **Outbox ainda adiado** (§5.3 da spec de verificação). Um crash entre o
  `COMMIT` do `reset` e o `send` do `passwordResetCompletedEmail` perde o aviso
  em silêncio. O `forgot` tem o mesmo modo de falha entre o `issueOrRefresh` e o
  `send` do `passwordResetEmail` — e aí o conserto barato **não** existe (não há
  "reenviar reset" fora de outro `forgot`, que o cooldown segura). O usuário
  reenvia manualmente após o cooldown. Registrado, não consertado aqui. O mesmo
  sender nu e aguardado deixa a **primeira** sonda do `forgot` separar endereço
  com conta de endereço sem conta, por latência (round trip SMTP antes do `202`)
  e por status (`500` vs `202` com o SMTP fora do ar) — herdado do `register`,
  módulo-inteiro, e fechado pelo mesmo outbox (§6.3).
- **Rate limit só por IP** (decisão §6 do `DECISIONS.md`). Uma botnet distribuída
  contra o `reset` gasta `PASSWORD_RESET_RATE_LIMIT_MAX` por IP e nada no
  servidor nota — mas contra 256 bits de token isso não leva a lugar nenhum, ao
  contrário do que levaria contra seis dígitos. É o argumento do §3.1.

### Novos

- **`reset` com a senha atual** não é detectado (§6.2). Idempotente e inofensivo.
- **`forgot` de mesmo instante** (duplo-submit no mesmo segundo, ambos fora do
  cooldown): o `issueOrRefresh` é serializado pelo índice único, então a segunda
  escrita sobrescreve o token da primeira. O usuário recebe dois e-mails e só o
  link do segundo funciona. O cooldown cobre qualquer intervalo realista; só a
  simultaneidade exata escapa. Aceito.
- **Interação com o login social, ainda não construído** (handoff §5.3): quando o
  Google entrar, uma conta ligada só ao Google **não tem senha para recuperar**.
  O `forgot` para esse endereço deve responder `202` e não mandar nada. Não
  construído agora, mas o `forgot` **não assume** que toda conta tem senha —
  `usersRepository.findByEmail` devolve o usuário e o fluxo segue sem tocar em
  `password_hash`. `DECISIONS.md` §6.

## 12. Decisões registradas

### 12.1 — Token opaco escolhido sobre código de seis dígitos

O `confirm` da fatia 11 escolheu seis dígitos (digitável no celular). O `reset`
escolhe opaco de 256 bits porque é grau-de-takeover sobre uma conta que já tem
dono e sessões, e porque o rate limit só-por-IP do `DECISIONS.md` §6 não segura
força bruta distribuída — contra seis dígitos isso importa, contra 256 bits não.
Custo: o corpo do `reset` diverge do `confirm` (`token`, não `code`), mas
converge com o refresh token. Alternativas recusadas: seis dígitos (§3.1, opção
B do handoff), híbrido link+código (duas superfícies, sem ganho claro).

### 12.2 — `INSERT … ON CONFLICT` para o `forgot`

Primeiro uso de upsert no repositório — os outros repos usam `find` +
`insert`/`update` separados. Escolhido porque o índice `unique (user_id)` +
cooldown no `WHERE` do `DO UPDATE` torna o `forgot` **livre de corrida** numa
declaração só: duas chamadas concorrentes da mesma conta não podem ambas cunhar,
e não há `23505` de `user_id` para traduzir nem constante de nome de índice para
exportar. A alternativa (`find` para o cooldown, depois `save` ou `supersede`)
reintroduz a corrida no primeiro `forgot` de uma conta.

### 12.3 — `reset` sem auto-login

Handoff §4.3. O `change-password` faz auto-login porque o chamador já estava
autenticado; o chamador do `reset` provou só controle da caixa. `204` mantém
"resetar senha" e "abrir sessão" separados, e torna o endpoint trivial (sem
`refreshTransport`, sem cookie, sem `session-tokens`). O login em seguida prova a
senha nova.

### 12.4 — argon2 só no ramo de token válido

Handoff §4.5, revisto para o token opaco. O hash-isca incondicional do `confirm`
e do `login-user` protege um segredo **adivinhável**; 256 bits não são, então o
oráculo de tempo "esse token era válido" não tem como ser explorado, e pagar
argon2 por request de token-lixo é custo sem retorno. Divergência consciente do
`confirm`.

### 12.5 — `passwordResetCompletedEmail` dedicado

Não reuso de `passwordChangedEmail`. O evento e o conselho "se não foi você"
diferem: no `change-password`, alguém tinha seu access token; no `reset`, alguém
teve o token de reset ou acesso à caixa, e a ação certa é refazer a recuperação.

### 12.6 — Renomear `verification-email.ts` → `emails.ts`

O arquivo guarda todo texto de e-mail do sistema e já passou de "verificação".
Feito agora, enquanto são três imports.

## 13. Fora de escopo

- **Poda de `password_reset_tokens`** — linhas expiradas de quem nunca refez o
  `forgot` ficam. Terceira tabela a precisar do cron (`refresh_tokens`,
  `pending_registrations`, agora esta). Handoff §8.
- **Outbox transacional** — §11.
- **Throttle de `reset` por e-mail** — o teto por IP não segura um anônimo
  mantendo um endereço sob pressão; mesma pendência do `confirm`. Handoff §8.
- **Login social** — a conta só-Google sem senha para recuperar; §11, `DECISIONS.md` §6.
- **Listar / notificar sessões revogadas** — o `reset` revoga em massa; um
  "estas sessões foram encerradas" é defesa em profundidade para outra fatia.
