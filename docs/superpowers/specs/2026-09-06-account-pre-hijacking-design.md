# Fatia 11 — Fechar o account pre-hijacking: design

> Escrito em 2026-09-06. Fecha a vulnerabilidade real, aberta e conhecida que a
> fatia 10 introduziu e estreitou sem fechar. Contexto de entrada:
> [`2026-09-05-handoff-account-pre-hijacking.md`](../2026-09-05-handoff-account-pre-hijacking.md).

## 1. O que esta fatia entrega

O cadastro deixa de receber senha. `POST /auth/register` recebe **só o e-mail**,
cria um **registro pendente** — um código de verificação de uso único ligado a um
endereço, e nada mais — e responde `202`. A linha em `users` nasce **na
confirmação**, com a senha fornecida **naquele request de confirm**, já
verificada. A sessão é emitida junto.

Vários registros pendentes para o mesmo endereço coexistem sem invalidar uns aos
outros. Eles são **fungíveis**: cada um é só prova de controle da caixa. Quem
resgatar qualquer código utilizável do endereço, com uma senha, leva a conta.

Isto é a saída **4.3** do handoff, escolhida sobre a 4.1 depois de a 4.1 ser
desenhada por inteiro e atacada — ver §12.2. A 4.1 (registro pendente carregando
o hash da senha, conta nasce com a senha do pendente) remove o hijack
*determinístico* da fatia 10, mas deixa um residual de timing e confusão de
inbox. A 4.3 fecha por construção: a senha vem do request de confirm, nunca do
pendente, então quem completa a confirmação define a senha — e completar exige um
código que só chegou na caixa do dono do endereço.

O que sobra é o residual **irredutível** que nenhum esquema de verificação de
e-mail escapa: o atacante ter acesso à caixa da vítima, ou adivinhar o código de
seis dígitos dentro do teto de cinco tentativas e do TTL de quinze minutos.

## 2. O ataque, reproduzível na `main` depois da fatia 10

1. o atacante cadastra `vitima@exemplo.com` com a **senha dele**. Responde `202`.
   A conta existe, não verificada;
2. a vítima cadastra o mesmo endereço com a **senha dela**. Cai no `23505`; o
   caminho de colisão emite um código novo e o manda para a caixa da vítima —
   indistinguível de um cadastro normal;
3. a vítima confirma. A conta fica verificada;
4. **de quem é a senha da conta?** Da última pessoa que cadastrou antes da
   confirmação. Se o atacante recadastrar depois da vítima e antes de ela
   confirmar, a senha é dele, e a vítima não recupera: `POST /auth/password`
   exige a senha atual e a recuperação de senha ainda não existe.

A fatia 10 corrigiu escrevendo o hash da senha nova **dentro da transação que
emite o código**. Isso estreitou a janela de "para sempre" para "entre o
cadastro da vítima e a confirmação dela", mas não fechou: **o dono da caixa não
distingue de qual cadastro veio o código**. A raiz é a invalidação —
`EmailVerificationIssuer.issueFor` chama `invalidateActiveForUser` antes de
inserir o código novo, para manter "um código vivo por usuário", e é esse
invariante que empurra a vítima para o código do atacante. Esta fatia remove o
invariante **e** tira a senha do pendente.

## 3. Decisões tomadas no brainstorming

| Ponto | Decisão |
|---|---|
| Abordagem | **4.3** — `register` só com e-mail; senha definida no `confirm`; conta nasce na confirmação. Ver §12.2 para o porquê sobre a 4.1 |
| `POST /auth/email/verify/resend` | Mantido. Recebe só o e-mail; re-emite o código do **pendente mais recente** utilizável daquele endereço |
| Teto de tentativas de código errado | **Por linha de pendente**, atômico, equivalente ao de hoje. Sem trava de conta, sem e-mail de aviso — a [`DECISIONS.md §6`](../../DECISIONS.md) já rejeitou contador de falha de autenticação com estado, e uma trava por pendente vira DoS contra a vítima |
| No-match no `confirm` (nenhum código casa) | Incrementa o teto **do pendente mais recente utilizável**. Incrementar todos amplifica DoS; não incrementar anula o teto |
| Poda dos pendentes | **Oportunista agora** (deleta expirados/consumidos daquele e-mail quando o e-mail é tocado por `register` ou `confirm`) + varredura completa fica para a fatia do `cron.ts` |
| Custo do argon2 no `confirm` | Roda **incondicionalmente**, antes da checagem do código, para o tempo de `match` e `no-match` ser igual — mesmo padrão do hash-isca do `login-user.ts` |
| `register` rejeita campo desconhecido | Schema `.strict()` — um cliente antigo mandando `password` recebe `400`, não um `202` silencioso que ignora a senha dele |
| Migration de `email_verification_tokens` | **Apagada**, não seguida por uma de `DROP`. Exceção deliberada a R4 — ver §12.1 |
| `User.create` | Passa a **nascer verificado**. É o único caminho de criação de usuário, e ele sempre roda depois da prova do endereço |

## 4. Modelo de dados

### 4.1 — Nova tabela `pending_registrations`

`src/modules/auth/infra/drizzle/schema/pending-registrations.ts`, própria do
módulo `auth`, um arquivo por tabela nomeado pela tabela (decisão 24).

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | `uuid` PK | de `IIdGenerator` |
| `email` | `text` not null | normalizado pelo `Email` VO, como `users.email` |
| `code_hash` | `text` not null | sha256 do código de 6 dígitos; nunca o código |
| `attempts` | `integer` not null | palpites errados; sem default (a entidade é dona do valor) |
| `code_issued_at` | `timestamptz` not null | quando o código vivo foi emitido; `create` e `reissueCode` setam `= now` |
| `expires_at` | `timestamptz` not null | `code_issued_at + ttl`, recomputado no `reissueCode` |
| `consumed_at` | `timestamptz` null | marca "confirmado" **ou** superado por um reenvio — nada a jusante lê a diferença |
| `created_at` | `timestamptz` not null | criação da linha, **imutável**; ordenação de poda e auditoria |

**Sem `password_hash`.** É a diferença da 4.1: nenhum pendente carrega senha, e é
por isso que a 4.3 fecha o ataque — não há senha do atacante para ser aplicada.
Como efeito, o custo "hash de senha em repouso para conta que pode nunca existir"
(§5.3 do handoff) **desaparece**, e o `register` deixa de rodar argon2.

**Sem defaults de coluna**, pela mesma razão de `refresh-tokens.ts`: Postgres
guarda `timestamptz` em microssegundos e um `Date` de JS tem milissegundos, e as
comparações de instante exigem que os dois lados venham do `IClock`. `attempts`
também é explícito: a entidade é dona do valor.

**Sem FK** — não há usuário quando a linha é escrita.

**Sem unique em `email`.** Vários pendentes por endereço são legítimos. Uma
colisão de PK (UUID duplicado) é falha real → 500 via `toPersistenceError`.

Índices:

- `pending_registrations_email_lower_idx` em `lower(email)` — o `confirm`, o
  `resend` e o cooldown do `register` buscam por e-mail case-insensitive.
- `pending_registrations_active_idx` em `lower(email)` `WHERE consumed_at IS
  NULL`, ordenável por `code_issued_at DESC` — o caminho quente. Expiry é
  filtrado em query, nunca no predicado do índice: predicado de índice parcial
  tem que ser IMMUTABLE, e `now()` não é (mesma razão de
  `email_verification_tokens_active_idx`).

Um nome de constraint que o repositório precise ler vira constante exportada
declarada no próprio arquivo de schema — a isenção do `CLAUDE.md` para nomes
inline para de valer quando o nome é lido de outro arquivo.

### 4.2 — `code_issued_at` separado de `created_at`

O reenvio faz `UPDATE` no lugar, não `INSERT` de linha nova (diferente de
`email_verification_tokens`, onde cada reenvio inseria). Se o cooldown medisse
de `created_at`, a sequência "registra, espera o cooldown, reenvia, reenvia de
novo" passaria no segundo reenvio, porque `created_at` continua velho — buraco de
flood. `code_issued_at` avança a cada emissão; `created_at` fica imutável e
honesto sobre quando a linha nasceu. Cada coluna com um significado só (mesma
doutrina de `markEmailVerified` não colapsar `verifiedAt` e `updatedAt`).

"Mais recente" — para o alvo do reenvio e para a atribuição do no-match — indexa
por `code_issued_at DESC`.

### 4.3 — `users.email_verified_at` e o gate de login ficam

Com a conta nascendo na confirmação, toda linha de `users` nasce com
`email_verified_at` preenchido, então o gate de `login-user.ts` vira defesa em
profundidade. Fica mesmo assim: o [§6 do `DECISIONS.md`](../../DECISIONS.md) já
fixou que o login social do Google cria conta verificada e depende desse campo e
desse gate, e que o item 3 ("sign-in do Google sobre conta verificada com senha")
também os usa. Remover agora para readicionar na próxima fatia é retrabalho. Um
comentário local em `login-user.ts` registra que o ramo "não verificado" não tem
mais produtor neste momento.

## 5. Camada de domínio

### 5.1 — Nova entidade `entities/pending-registration.ts`

Espelha o estilo de `EmailVerification`:

- Estado em campos `#` privados: `id`, `email: Email`, `codeHash`, `attempts`,
  `codeIssuedAt`, `expiresAt`, `consumedAt`, `createdAt`. `Object.freeze`, datas
  clonadas na entrada e na saída, `JSON.stringify` → `{}` — o `codeHash` (digest
  de um segredo vivo) não escapa por um `reply.send(pending)` ou
  `log.info({ pending })` acidental.
- `static create({ id, email, codeHash, now, ttlSeconds })` — nasce
  não-consumida, `attempts = 0`, `createdAt = now`, `codeIssuedAt = now`,
  `expiresAt = now + ttlSeconds`. **Não recebe senha.**
- `static fromTrusted(props)` — rehidrata uma linha; validação é papel do
  `create`, na entrada.
- `isUsable(maxAttempts, now)` — não consumida **e** não expirada (inclusivo no
  limite, como `EmailVerification`) **e** `attempts < maxAttempts`.
- `matches(codeHash)` — comparação simples: são dois digests, não dois segredos.
- getters clonando datas.

### 5.2 — Novo contrato `repositories/pending-registrations-repository.ts`

`IPendingRegistrationsRepository`:

- `save(pending: PendingRegistration): Promise<void>` — insert simples. Sem
  violação de unicidade a traduzir.
- `findUnconsumedByEmail(email: Email): Promise<PendingRegistration[]>` — todas
  as linhas não-consumidas de `lower(email)`, ordenadas `code_issued_at DESC`
  (índice `[0]` = mais recente). **Não** filtra expiry nem `attempts` em SQL —
  esse juízo é da entidade contra o `IClock` injetado, mesma doutrina de
  `findActiveByUserId`. O use case filtra por `isUsable`.
- `reissueCode(id: string, codeHash: string, codeIssuedAt: Date, expiresAt:
  Date): Promise<void>` — `UPDATE SET code_hash = ?, attempts = 0,
  code_issued_at = ?, expires_at = ? WHERE id = ? AND consumed_at IS NULL`. O
  `expiresAt` chega pronto: é aritmética de clock injetado + ttl de config, e o
  use case a faz (como `markEmailVerified` recebe datas explícitas).
- `registerFailedAttempt(id: string, maxAttempts: number): Promise<boolean>` —
  `UPDATE ... SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL
  AND attempts < ?`. Devolve se **esta** chamada foi a que incrementou. O
  `UPDATE` condicional, serializado pelo row lock do Postgres, é o que segura o
  teto sob concorrência — um read-then-write deixaria N palpites paralelos lerem
  o mesmo valor e todos passarem. Chamado **fora** de qualquer transação (§8
  linha 3 do Unit of Work): dentro de uma que dá rollback, o contador de força
  bruta é apagado exatamente quando importa. Levantado quase verbatim do repo de
  email-verifications.
- `consume(id: string, at: Date): Promise<boolean>` — `UPDATE SET consumed_at =
  ? WHERE id = ? AND consumed_at IS NULL`. Devolve se **esta** chamada foi a que
  queimou. É o que faz o uso único ser à prova de corrida sem lock explícito.
  Verbatim do repo de email-verifications.
- `deleteExpiredByEmail(email: Email, now: Date): Promise<void>` — poda
  oportunista: `DELETE WHERE lower(email) = ? AND (expires_at <= ? OR consumed_at
  IS NOT NULL)`. Nunca toca uma linha viva e não-consumida — a que um `confirm`
  concorrente pode estar prestes a consumir não casa o `WHERE`.

`registerFailedAttempt` é um **write** no `Pick` que o `ConfirmEmailUseCase`
recebe, e a §9 do Unit of Work permite porque a §8 linha 3 o coloca fora da
transação. `consume` e o `users.save` do `confirm` vêm do `repos` do callback do
`uow`, não do `Pick` injetado — como hoje.

### 5.3 — `AuthRepos` e o Unit of Work

`AuthRepos.emailVerifications` vira `AuthRepos.pendingRegistrations`.
`unit-of-work.ts` tem o comentário atualizado: confirmar um e-mail consome o
registro pendente, cria a linha de `users` e o primeiro refresh token **numa
transação** — é um fato, e ou os três landam ou nenhum.

### 5.4 — Serviço `services/email-verification-issuer.ts` remodelado

Mantém o nome — ainda emite o código de verificação — e perde a dependência de
repositório e a mecânica `invalidateActiveForUser` + insert.

- Construtor: `(emailSender, tokenGenerator, tokenDigest, ttlSeconds)`.
  `idGenerator` sai — o id da entidade é cunhado pelo use case, como o `register`
  já faz com `User.create({ id: idGenerator.generate() })`.
- `issue(email: Email): { codeHash: string; deliver: DeliverVerification }` —
  cunha um código de 6 dígitos (`ITokenGenerator.numericCode`), devolve o digest
  (para o use case persistir) e o envio diferido. **Não persiste, não envia.**

`DeliverVerification` e o no-op `NO_DELIVERY` continuam. A razão agora não é a
transação (o `register` e o `resend` não abrem mais nenhuma) — é o anti-oráculo:
um único `await deliver()` por ramo mantém as respostas `202` indistinguíveis no
fluxo de controle.

`services/` continua bem-comportado: uma operação de domínio com colaboradores
que não pertence a uma entidade só, e que **não recebe repositório** — mais
alinhada com a regra de fronteira do que a versão de hoje, que recebia.

### 5.5 — `User.create` nasce verificado

`emailVerifiedAt: props.now` no lugar de `null`; docstring atualizada. A
assinatura de `CreateUserProps` não muda — `{ id, email, passwordHash, now }` —,
só que o `passwordHash` agora vem do request de confirm, e quem chama `create` é
o `ConfirmEmailUseCase`, não mais o `RegisterUserUseCase`. `fromTrusted` continua
aceitando `Date | null` para linhas antigas e para o caminho não verificado que
o login social pode reintroduzir.

## 6. Fluxos

### 6.1 — `register`

`RegisterUserUseCase.execute(command: { email: string }): Promise<void>`.
`RegisterUserCommand` **perde o campo `password`**.

1. `email = Email.create(command.email)` — VO. **Sem `Password.create`, sem
   argon2.**
2. `now = clock.now()` — uma vez (R7).
3. `deliver = await this.#planDelivery(email, now)`.
4. `await deliver()` — uma chamada para todo ramo.

`#planDelivery(email, now): Promise<DeliverVerification>`:

- `existingUser = await usersRepository.findByEmail(email)`. Se `!== null` (a
  conta só nasce verificada): devolve `() =>
  emailSender.send(accountAlreadyExistsEmail(existingUser.email))` — o e-mail
  guardado, não o do request, porque o `lower()` do Postgres e o `toLowerCase()`
  do JS podem divergir em codepoints exóticos.
- senão:
  - `pendings = await pendingRegistrations.findUnconsumedByEmail(email)`.
  - `maisRecenteUsavel = pendings.find(p => p.isUsable(maxAttempts, now))` — a
    lista é `code_issued_at DESC`. Se existe e `now -
    maisRecenteUsavel.codeIssuedAt < resendCooldownMs`: devolve `NO_DELIVERY`.
    Sem isso, um anônimo que saiba o endereço floda a caixa a cada cadastro. Na
    4.3 esse ramo é inofensivo do ponto de vista de hijack — o código recente na
    caixa, seja de quem for, é resgatável com uma senha escolhida pela vítima.
  - senão: `await pendingRegistrations.deleteExpiredByEmail(email, now)` →
    `{ codeHash, deliver } = issuer.issue(email)` →
    `pending = PendingRegistration.create({ id: idGenerator.generate(), email,
    codeHash, now, ttlSeconds })` → `await pendingRegistrations.save(pending)` —
    **um insert autocommit, sem `uow`** → devolve `deliver`.

O `register` não abre transação nem roda argon2. Construtor: entram `maxAttempts`
e `ttlSeconds`; **saem `hashProvider` e `uow`**; o `catch` de
`EmailAlreadyInUseError` sai. `EmailAlreadyInUseError` continua existindo (o
índice único de `users` ainda o levanta) mas só o `confirm` o produz agora.

### 6.2 — `confirm`

`ConfirmEmailUseCase.execute({ email, code, password }): Promise<ConfirmEmailResult>`.
`ConfirmEmailCommand` **ganha o campo `password: string`**. O `refreshTransport`
é tratado no endpoint.

1. `email = Email.create(command.email)`; `password =
   Password.create(command.password)` — VOs. Uma senha malformada lança
   `InvalidPasswordError` (→ `ValidationError` → 400) **antes** de qualquer
   leitura ou da checagem do código, então nenhuma tentativa é queimada por um
   payload que nem chegou a tentar um código. No HTTP o schema Zod já barra isso
   com 400; o VO é a defesa para os entrypoints não-HTTP (decisão 10).
2. `passwordHash = await hashProvider.hash(password.value)` — antes da transação
   (§8) e **incondicional**. É o hash-isca do `login-user.ts` aplicado aqui: se
   o argon2 só rodasse no ramo de `match`, o tempo de resposta separaria "esse
   código era válido para algum pendente" de "não era" — exatamente o sinal que
   um força-bruta quer. Rodando sempre, `match` e `no-match` custam o mesmo. O
   hash é descartado no `no-match`.
3. `now = clock.now()` — uma vez; carimba `user.createdAt`, `email_verified_at` e
   o `created_at` do primeiro refresh token, três colunas em três tabelas que
   uma transação torna atômicas.
4. `pendings = await pendingRegistrations.findUnconsumedByEmail(email)`;
   `usable = pendings.filter(p => p.isUsable(maxAttempts, now))` — preserva a
   ordem `code_issued_at DESC`;
   `match = usable.find(p => p.matches(tokenDigest.hash(command.code)))`.
5. **`match === undefined`** — e-mail desconhecido, nenhum pendente utilizável,
   código errado, expirado, tentativas esgotadas: tudo colapsa num `throw new
   EmailVerificationFailedError()` (§6.3 da spec da fatia 10, "um erro para todo
   modo de falha"; ramos que reportassem diferente virariam oráculo de
   conta-e-código para um anônimo). Antes do `throw`: se `usable.length > 0`,
   `await pendingRegistrations.registerFailedAttempt(usable[0].id, maxAttempts)` —
   `usable[0]` é o mais recente utilizável. Autocommit, fora de transação (§8
   linha 3); o resultado não é ramificado.
6. **`match` encontrado** — cria a conta:

   ```
   user = User.create({ id: idGenerator.generate(), email, passwordHash, now })
   // passwordHash é o DESTE request. Nasce verificado.
   issued = refreshTokenIssuer.issue(user.id, refreshTokenIssuer.newFamilyId(), now)  // fora da txn

   await uow(async ({ users, pendingRegistrations, refreshTokens }) => {
     if (!(await pendingRegistrations.consume(match.id, now))) {
       throw new EmailVerificationFailedError()   // perdeu a corrida por ESTE pendente (dois confirms concorrentes do mesmo código)
     }
     try {
       await users.save(user)
     } catch (error) {
       if (error instanceof EmailAlreadyInUseError) throw new EmailVerificationFailedError()
       // §5.1 do handoff: outro confirm, de um pendente DIFERENTE do mesmo e-mail,
       // ganhou o índice único. Erro genérico, sem oráculo. O rollback des-consome
       // este pendente.
       throw error
     }
     await refreshTokens.save(issued.entity)
   })

   return { accessToken: await tokenSigner.sign({ sub: user.id }),
            refreshToken: issued.token }
   ```

   Os `throw` dentro do callback são o que abortam a transação — um `return`
   deixaria estado pela metade. Um `confirm` bem-sucedido consome o pendente, e
   numa retentativa `findUnconsumedByEmail` já não o devolve → cai no passo 5,
   `throw` genérico, sem transação.

Construtor de `ConfirmEmailUseCase`: **sai `usersRepository`** (o confirm não lê
usuário, ele cria); o `Pick` de verificações vira
`pendingRegistrations: Pick<IPendingRegistrationsRepository,
'findUnconsumedByEmail' | 'registerFailedAttempt'>`; **entram `hashProvider` e
`idGenerator`**; ficam `uow`, `refreshTokenIssuer`, `tokenSigner`,
`tokenDigest`, `clock`, `maxAttempts`.

### 6.3 — `resend`

`RequestEmailVerificationUseCase.execute({ email }): Promise<void>` — assinatura
intacta.

1. `email = Email.create(command.email)`; `now = clock.now()` — uma vez.
2. `user = await usersRepository.findByEmail(email)`. Se `!== null` → `return`
   (conta real existe ⟹ verificada; nada a reenviar).
3. `pendings = await pendingRegistrations.findUnconsumedByEmail(email)`;
   `target = pendings.find(p => p.isUsable(maxAttempts, now))` — mais recente
   utilizável.
4. `target === undefined` → `return` (endereço desconhecido, ou tudo
   expirado/esgotado; resposta idêntica a todo ramo — §6.5 da fatia 10).
5. Cooldown: `if (now - target.codeIssuedAt < cooldownMs) return` —
   estritamente menor (um reenvio na idade exata do cooldown é permitido;
   reemitir sob demanda cunharia orçamento de tentativa de graça).
6. `{ codeHash, deliver } = issuer.issue(email)`;
   `expiresAt = new Date(now.getTime() + ttlSeconds * MILLISECONDS_PER_SECOND)`;
   `await pendingRegistrations.reissueCode(target.id, codeHash, now, expiresAt)` —
   **um `UPDATE` autocommit, sem `uow`** → `await deliver()`.

Construtor: ficam `usersRepository` (`Pick<…, 'findByEmail'>`), `issuer`,
`clock`, `cooldownMs`; o `Pick` de pendentes é
`Pick<…, 'findUnconsumedByEmail' | 'reissueCode'>`; **entram `maxAttempts` e
`ttlSeconds`**; **sai `uow`**.

### 6.4 — Por que a 4.3 fecha o ataque

O primitivo do pre-hijacking exige o atacante **controlar a senha da conta**. Na
4.3 a senha é definida por quem completa o `confirm`, e completar o `confirm`
exige um código utilizável para o endereço — que só chega na caixa do dono. O
atacante nunca vê o código, logo nunca define senha.

E o ponto que a 4.1 não tinha: **não importa qual código a vítima usa.** Mesmo
que ela digite o código do pendente do atacante, ela fornece **a senha dela**
naquele request → a conta nasce com a senha dela. Os pendentes são fungíveis;
qual pendente foi resgatado não determina nada além de "o código era válido".

Percursos de ataque, e o que barra cada um:

| Percurso | Barreira |
|---|---|
| Atacante cadastra `V@e` primeiro, vítima depois, vítima confirma com o código do atacante | Vítima define a senha dela no confirm → conta com a senha dela |
| Vítima primeiro, atacante depois (o que a fatia 10 não fechava) | Mesma coisa — o código da vítima nem é invalidado |
| Atacante faz brute-force do `POST /auth/email/verify` | Teto de 5 por pendente (atômico), TTL de 15 min, espaço de 10⁶, rate limit por IP; cada `no-match` paga argon2, então nem o tempo vaza |
| Atacante recadastra depois da vítima confirmar | `#planDelivery` vê `existingUser` verificado → `accountAlreadyExistsEmail`, nenhum pendente |
| Atacante correndo o `confirm` da vítima | Precisa de um código válido, que não tem |
| Pendente-trojan do atacante sobrevive à criação da conta | `users.save` do resgate tardio bate no índice único → `EmailVerificationFailedError` genérico, rollback; o pendente fica inerte |

Residual irredutível: o atacante ter acesso à caixa da vítima, ou vencer o
brute-force de 5/10⁶. Nenhum esquema de verificação por e-mail escapa disso.

## 7. Camada HTTP e erros

### 7.1 — Endpoints

| Rota | Mudança |
|---|---|
| `POST /auth/register` | Body vira `z.object({ email }).strict()` — **`password` sai**; `.strict()` para um cliente antigo mandando `password` receber `400` em vez de um `202` que ignora a senha em silêncio. Respostas: `202 z.null()`, `400`, `429`. Sem `503` (não abre transação). Descrição OpenAPI: "inicia o cadastro de um e-mail e envia um código; a senha é escolhida na confirmação" |
| `POST /auth/email/verify` (`confirm`) | Body ganha `password`, validado pelas mesmas constantes de política (`MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH`, `PASSWORD_POLICY_PATTERN`) que estavam no `register` — a política continua com uma definição só, no VO `Password`, e o endpoint importa. Respostas: `200 sessionTokensSchema`, `400`, `422`, `429`, `503` (continua abrindo `uow`). Descrição: "resgata o código de seis dígitos junto com uma senha escolhida, cria a conta verificada e abre uma sessão" |
| `POST /auth/email/verify/resend` | Fica. **Perde `503`** (não abre mais `uow`). Mantém `202 z.null()`, `400`, `429`. Comentário de rate limit retocado — o `reissueCode` só toca o pendente mais recente |

O `503` que sai de `register` e `resend` é uma declaração **inalcançável** depois
que eles param de abrir transação: `TransactionConflictError` só é construída
dentro de `createTransactionRunner`. Removê-la é o mesmo movimento da fatia 10
tirando o `409` do `register` quando ele parou de chegar na rede.

### 7.2 — Taxonomia de erros — zero categoria nova

- `EmailVerificationFailedError` (→ `BusinessRuleError` → 422) cobre todo modo de
  falha do `confirm`, como a emenda da decisão 13 já montou.
- `InvalidPasswordError` (→ `ValidationError` → 400) — já existe, levantada pelo
  `Password.create`; passa a poder vir do `ConfirmEmailUseCase` também (para
  chamadores não-HTTP). No HTTP, o schema Zod do `confirm` a antecipa com 400.
- `EmailAlreadyInUseError` (→ `ConflictError` → 409) continua existindo,
  levantada pelo índice único de `users`, mas **não chega mais na rede por
  endpoint nenhum**: o `register` não toca `users.save`; o `confirm` a captura e
  remapeia para `EmailVerificationFailedError` dentro do callback.
- `EmailNotVerifiedError` (→ `ForbiddenError` → 403) segue fiada no `login`;
  inalcançável na prática, mantida para o login social + defesa em profundidade,
  com um comentário local.

## 8. Migrations, DI, config

### 8.1 — Migrations

- Apagar `drizzle/20260904014721_create_email_verification_tokens_table/`,
  ajustar `drizzle/meta/_journal.json` e remover o snapshot correspondente.
- Novo `schema/pending-registrations.ts`; apagar `schema/email-verification-tokens.ts`.
- `pnpm drizzle-kit generate --name create_pending_registrations`. Histórico
  final: `users` → `refresh_tokens` → `pending_registrations`.

### 8.2 — Container (`makeAuthContainer`)

- `authRepositories(db)` devolve `{ users, refreshTokens, pendingRegistrations }`;
  `DrizzlePendingRegistrationsRepository` no lugar do de email-verifications.
- `new EmailVerificationIssuer(emailSender, tokenGenerator, tokenDigest,
  EMAIL_VERIFICATION_TTL_SECONDS)` — `idGenerator` sai dos argumentos.
- `RegisterUserUseCase`: **saem `hashProvider` e `uow`**; entram
  `EMAIL_VERIFICATION_MAX_ATTEMPTS` e `EMAIL_VERIFICATION_TTL_SECONDS`.
- `ConfirmEmailUseCase`: sai `usersRepository`; **entram `hashProvider` e
  `idGenerator`** (`UuidIdGenerator`).
- `RequestEmailVerificationUseCase`: sai `uow`; entram
  `EMAIL_VERIFICATION_MAX_ATTEMPTS` e `EMAIL_VERIFICATION_TTL_SECONDS`.
- `InMemoryPendingRegistrationsRepository` substitui o in-memory de
  email-verifications (usado pelos testes unitários).

### 8.3 — Config

Nenhuma variável de ambiente nova. `EMAIL_VERIFICATION_TTL_SECONDS`,
`EMAIL_VERIFICATION_MAX_ATTEMPTS` e `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`
já existem; passam a ser consumidas por outros construtores.

## 9. Deleções

Teste de deleção antes da troca (handoff §8):

- `entities/email-verification.ts` + `.spec.ts`
- `repositories/email-verifications-repository.ts`
- `infra/drizzle/drizzle-email-verifications-repository.ts`
- `infra/drizzle/email-verification-mapper.ts`
- `infra/drizzle/schema/email-verification-tokens.ts`
- `infra/in-memory/in-memory-email-verifications-repository.ts`
- `tests/integration/drizzle-email-verifications-repository.spec.ts`
- `tests/integration/email-verification-tokens-schema.spec.ts`
- `IUsersRepository.markEmailVerified` + a impl Drizzle + a in-memory — o
  `confirm` cria usuário já verificado via `save`.

## 10. Testes

### 10.1 — Unitários (`pnpm vitest run --project unit <arquivo>`)

- **Novo** `entities/pending-registration.spec.ts` — `create`/`fromTrusted`,
  fronteiras de `isUsable` (expiry inclusivo, teto), `matches`,
  `JSON.stringify` → `{}`, clonagem de datas. Sem `passwordHash` em lugar nenhum.
- **Reescrito** `use-cases/register-user.spec.ts` — command sem `password`;
  **nenhum argon2**, **nenhum `uow`**; endereço livre → pendente salvo + código
  entregue; usuário verificado → `accountAlreadyExistsEmail`, nenhum pendente;
  pendente utilizável recente → `NO_DELIVERY`, nada novo; pendente
  expirado/esgotado → pendente novo + `deleteExpiredByEmail` chamado; `now` lido
  uma vez.
- **Reescrito** `use-cases/confirm-email.spec.ts` — command com `password`; VO de
  senha validado antes de qualquer leitura; **argon2 roda mesmo no `no-match`**
  (tempo plano); `match` → usuário nasce verificado com o hash **deste request**
  + sessão + pendente consumido, tudo numa txn; **o código de um pendente
  "alheio" resgatado com a senha do confirmador dá a senha do confirmador** (a
  propriedade da 4.3); `no-match` com utilizáveis → `registerFailedAttempt(usable[0].id)`
  + throw; `no-match` sem utilizáveis → throw, sem incremento; senha malformada →
  throw de validação, nenhuma tentativa queimada; corrida de `consume` perdida →
  throw dentro do callback; `users.save` com `23505` → remapeado para
  `EmailVerificationFailedError` + rollback.
- **Reescrito** `use-cases/request-email-verification.spec.ts` — usuário
  verificado → return; sem pendente utilizável → return; dentro do cooldown
  (medido de `code_issued_at`) → return; fora → `reissueCode` + deliver; **sem
  `uow`**.
- **Reescrito** `services/email-verification-issuer.spec.ts` — `issue(email)`
  devolve `{ codeHash, deliver }`; `codeHash === digest(numericCode(6))`;
  `deliver` envia `verificationEmail`; nada persistido; nada enviado até
  `deliver()`.
- **Atualizado** `entities/user.spec.ts` — `User.create` nasce verificado.
- **Deletado** `entities/email-verification.spec.ts` e as asserções de ordem
  `invalidate+insert` do issuer antigo.
- Falsificação: `toEqual` no log de chamadas inteiro (mata deleção, reordenação e
  realocação), e a deleção escrita antes da troca.

### 10.2 — Integração (`tests/integration/`, limpa as próprias tabelas no `beforeEach`)

- **Novo** `drizzle-pending-registrations-repository.spec.ts` — `save`;
  `findUnconsumedByEmail` ordem `code_issued_at DESC` + case-insensitive;
  `registerFailedAttempt` atômico sob palpites concorrentes; `consume` à prova
  de corrida; `reissueCode` zera `attempts` e avança `code_issued_at`/`expires_at`;
  `deleteExpiredByEmail` não toca linha viva.
- **Novo** `pending-registrations-schema.spec.ts` — colunas (**sem
  `password_hash`**), os dois índices, sem defaults de coluna, **sem unique em
  `email`**.
- **Deletados** `drizzle-email-verifications-repository.spec.ts`,
  `email-verification-tokens-schema.spec.ts`.
- **Reescrito** `verify-email.spec.ts`:
  - ponta a ponta: `register(email)` → código no Mailpit → `confirm(email, code,
    password)` → sessão; `login(email, password)` funciona.
  - **hijack, os dois sentidos:** atacante `register(V@e)` primeiro, vítima
    `register(V@e)`, vítima `confirm(V@e, código, senhaDaVítima)` → `login` com a
    senha da vítima funciona; o atacante não tem código, então
    `confirm(V@e, palpite, qualquerSenha)` responde `422` e nunca abre sessão. A
    conta tem exatamente a senha que a vítima definiu no confirm.
  - vítima primeiro, atacante depois → mesmo resultado.
  - atacante faz brute-force do próprio pendente → teto em 5 → `422`s, nenhuma
    conta, o pendente da vítima intocado.
  - corrida: dois `confirm` de dois pendentes do mesmo e-mail, com duas senhas →
    um `200`, um `422`, exatamente uma linha em `users`, verificada, com a senha
    do vencedor.
  - senha malformada no `confirm` → `400` antes de a checagem do código rodar
    (nenhuma tentativa queimada).
- **Atualizado** `register.spec.ts` — body só `{ email }`; mandar `password` →
  `400` (`.strict()`); uma linha de pendente escrita e **nenhuma** linha em
  `users`; recadastro dentro do cooldown → `202`, ainda um pendente; sem `503` no
  schema.

## 11. Custos aceitos

### Da §12 da fatia 10 — o que morre

- §12.8 (recadastrar invalida o código da vítima) — pendentes coexistem; o
  código da vítima sobrevive ao recadastro do atacante.
- O raciocínio "reescrever a senha no caminho de colisão" — não há mais caminho
  de colisão no `register`, nem senha no pendente.
- O estado "conta não verificada com senha" — deixa de existir.
- **Os residuais que a 4.1 deixaria** (hash de senha em repouso; hijack por
  timing + confusão de inbox; o cooldown engolindo o cadastro da vítima) — não
  se aplicam à 4.3.

### O que sobrevive

- §12.10 (oráculo por latência do reenvio) — folga menor (`UPDATE` em vez de
  transação com 2 escritas), ainda presente. Conserto real é o outbox, adiado.
- §12.11 (anônimo queima o teto de tentativas de um pendente) — agora
  por-pendente; a vítima recupera recadastrando. Conserto real é throttle por
  e-mail, fatia própria.
- §12.9 / §12.2 (incômodo na caixa via `accountAlreadyExistsEmail` + resend, só
  teto por IP).
- §12.3 (crash entre a escrita e o envio perde o e-mail — recadastrar/reenviar é
  o conserto).
- §12.4 (dump do banco expõe digests de códigos vivos — sha256, limitado por
  TTL e uso único).

### Novos

- **Dois endpoints publicados mudam de forma** — `POST /auth/register` perde
  `password`, `POST /auth/email/verify` ganha. Em cima da decisão 25. Barato
  agora (boilerplate, sem cliente, sem front — CORS é fatia futura), e é o mesmo
  raciocínio da decisão 25: adiar a quebra é adiar o fechamento.
- **Um código vivo é grau-de-takeover**: quem resgatar um código utilizável do
  endereço, com uma senha, leva a conta. Ainda só chega na caixa do dono; ainda
  limitado pelo teto de 5, TTL de 15 min, espaço de 10⁶, rate limit por IP.
  Equivalente na prática à matemática de brute-force da 4.1.
- **O `confirm` paga argon2 em toda tentativa, inclusive código errado** —
  deliberado, para o tempo de `match` e `no-match` ser igual (mesmo padrão do
  hash-isca do `login`). Um martelo de código errado custa ~7 ms / 19 MB por
  tentativa; contido pelo teto de tentativas + rate limit por IP.
- **`register` e `resend` perdem o `503`** — não abrem mais transação; um
  deadlock em statement autocommit (improvável para esses statements — SELECTs
  não travam, INSERT sem unique não colide, UPDATE por PK não fecha ciclo)
  viraria `500` genérico em vez de `503 + Retry-After`.
- **A poda oportunista só limpa endereços com tráfego** — um pendente de
  endereço abandonado fica até a fatia do `cron.ts`. Mais barato que na 4.1: sem
  hash de senha na linha.
- **Um pendente que perdeu a corrida do `users.save`** fica permanentemente
  não-resgatável (o código dele devolve a falha genérica para sempre); o
  endereço é do vencedor.
- **Custo do `no-match` no `confirm` varia por ramo** (classe §12.12) — "quantos
  pendentes utilizáveis o e-mail tem" adiciona um número variável de comparações
  `matches()` em memória; sub-milissegundo, abaixo do ruído de rede.
- **`EmailNotVerifiedError`, o gate de `login` e a nulabilidade de
  `email_verified_at`** ficam sem produtor neste momento — código vivo que um
  leitor pode confundir com ativo. Mantidos para a fatia do login social;
  mitigado por comentário local.
- **Uma janela em que um endereço tem pendentes e nenhuma conta** — dá para
  "reservar" um endereço cadastrando e nunca confirmando. Mais barato ainda na
  4.3 (sem argon2 no `register`). Limitado por TTL + poda oportunista + a fatia
  do cron.
- **Uma futura fatia de deleção de conta precisa varrer os pendentes** do
  endereço deletado — senão um código utilizável remanescente confirmaria uma
  conta nova. Fora de escopo aqui; registrado para aquela fatia.

## 12. Decisões registradas

### 12.1 — Exceção deliberada a R4

R4 diz que migration aplicada é imutável. A migration
`20260904014721_create_email_verification_tokens_table` é **apagada**, não
seguida por uma de `DROP`. É seguro porque não há ambiente deployado: a migration
só existe em CI (efêmero, recriado a cada run) e no Postgres local do
desenvolvedor (sob controle dele, `drop`/recreate resolve). A tabela
`email_verification_tokens` viveu só entre as fatias 10 e 11.

A alternativa R4-limpa — uma migration nova de `DROP TABLE` — deixaria um
tombstone permanente no histórico para uma tabela que nunca chegou a produção. O
rewrite foi escolhido; esta linha é o registro que a `architecture-audit` vai
procurar.

### 12.2 — 4.3 escolhida sobre 4.1

A 4.1 (registro pendente carregando o hash da senha; a conta nasce com a senha do
pendente; pendentes coexistem) foi desenhada por inteiro e **atacada**. Ela
remove o hijack *determinístico* da fatia 10 — o código da vítima nunca é
invalidado, e o `confirm` casa o código digitado contra o pendente dele, não "o
mais recente" — mas deixa um residual:

- **Timing + confusão de inbox.** Se o atacante mantém um código vivo na caixa da
  vítima na janela em que ela age (um e-mail de código por ciclo de TTL), e a
  vítima digita **esse** em vez do dela, a conta nasce com a senha
  pré-registrada do atacante.
- **O cooldown do `register` piora.** Dentro do cooldown de qualquer pendente
  utilizável, um novo `register` não cria pendente nem envia e-mail. Se o
  atacante cadastrou < cooldown antes da vítima, o cadastro **da vítima é
  engolido** e o único código na caixa dela é o do atacante.

A 4.3 fecha os dois **por construção**: a senha vem do request de confirm, nunca
do pendente, então qual código a vítima usa não importa — ela sempre define a
senha dela. O que sobra é o residual irredutível (atacante com acesso à caixa da
vítima, ou brute-force de 5/10⁶).

**Custo da 4.3 sobre a 4.1:** `POST /auth/register` e `POST /auth/email/verify`
mudam de forma. Barato agora, pelo argumento da decisão 25.

**Alternativas recusadas:**

- **Link de confirmação por pendente** em vez de código de seis dígitos
  compartilhado pelo endereço — fecharia o residual da 4.1 mantendo a senha no
  `register`, mas vai contra a decisão §6.2 da fatia 10 ("código, não link",
  digitável no celular).
- **Expirar conta não verificada** (§4.2 do handoff) — não fecha, só limita a
  janela de squatting.

### 12.3 — `POST /auth/email/verify/resend` mantido

Analisado remover o endpoint (recadastrar geraria o pendente novo). Mantido: o
cooldown por-e-mail no `register` é inevitável nos dois desenhos, então manter o
`resend` é um incremento pequeno, preserva a UX e a maior parte dos testes da
fatia 10. Na 4.3 o residual de `resend` (o código de um pendente do atacante ser
re-emitido para a caixa da vítima) é inofensivo — a vítima define a senha dela ao
resgatar.

## 13. Fora de escopo

- **Recuperação de senha** — a fatia seguinte no roteiro, e é por isso que vem
  depois: recuperação sobre um desenho vulnerável só amplia a superfície.
- **Poda por varredura** (`cron.ts`) — entrypoint novo; `refresh_tokens`,
  `email_verification_tokens` (que sai aqui) e agora `pending_registrations`
  todas dependem dela.
- **Login social / Google** — herda o formato que a 4.3 deixa pronto (conta na
  confirmação, endereço já provado), mas o fluxo federado, o merge e a recusa
  específica do item 3 do `DECISIONS.md §6` são fatia própria.
- **Throttle de `confirm` por e-mail** — o conserto real do §12.11, fatia
  própria.
- **Deleção de conta varrendo pendentes** — registrado no §11; a fatia de
  deleção resolve.
- **Invalidar toda sessão na verificação + notificar o dono** (§4.4 do handoff)
  — defesa em profundidade que a literatura recomenda por cima da correção
  estrutural; não bloqueia esta fatia.
