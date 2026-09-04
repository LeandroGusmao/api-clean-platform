# Fatia 10 — Verificação de e-mail: o primeiro I/O externo, e o fim do oráculo de contas

> Escrita em 2026-09-03, a partir do handoff `2026-09-03-handoff-email-verification.md`.
> Uma afirmação daquele documento foi refutada — ver §3. Ela está registrada aqui
> porque o handoff continua no repositório, e uma sessão futura pode reabri-lo.
>
> Esta spec também confronta uma **implementação de referência**: o projeto
> `byteflow`, em `~/projects/byteflow`, já tem esta fatia inteira. O §4 registra o
> que dele foi copiado, o que foi corrigido e o que ele deixou em aberto. Copiar o
> desenho, não o código: o domínio dele chama `randomUUID()`, `new Date()` e
> `createHash` dentro da entidade, o que aqui violaria a R7 e a disciplina de
> portas.

## 1. Objetivo

O usuário prova que controla o endereço que cadastrou, digitando um código de
seis dígitos que chega por e-mail. Com isso, quatro coisas que estavam paradas se
movem:

- `emailVerifiedAt` ganha quem a **escreva** — a coluna existe, `GET /auth/me` já
  a publica e `get-user-profile.ts` já a lê;
- o login ganha o gate que [`login-user.ts:31`](../../../src/modules/auth/use-cases/login-user.ts)
  diz, em comentário, que não pode ter;
- o `register` deixa de ser um oráculo de contas;
- a notificação *"sua senha mudou"*, custo aceito no §11.1 da spec da fatia 9,
  é quitada.

É a primeira fatia a mandar **I/O externo**, e é isso que a torna perigosa — não
o tamanho.

## 2. Escopo

### Entra

- porta `IEmailSender` em `shared/ports/`, adapter SMTP (nodemailer) em
  `infra/providers/`, e o decorador `BestEffortEmailSender`;
- serviço `mailpit` no `docker-compose.yml` e no `ci.yml`;
- `numericCode(digits)` na porta `ITokenGenerator` e no adapter;
- tabela `email_verification_tokens`, entidade `EmailVerification`, contrato
  `IEmailVerificationsRepository` e as duas implementações;
- `markEmailVerified` no `IUsersRepository` e nas duas implementações;
- `emailVerifications` no `AuthRepos`;
- `EmailVerificationIssuer` (serviço de domínio) e o thunk `deliver`;
- use cases `ConfirmEmail` e `RequestEmailVerification`; alterações em
  `RegisterUser`, `LoginUser` e `ChangePassword`;
- endpoints `POST /auth/email/verify` e `POST /auth/email/verify/resend`;
  alteração do contrato de `POST /auth/register`;
- dois erros novos: `EmailNotVerifiedError` (`ForbiddenError` → 403) e
  `EmailVerificationFailedError` (`BusinessRuleError` → 422);
- três pares de rate limit por rota, e sete variáveis `MAIL_*` no env core.

### Não entra, e por quê

- **Recuperação de senha** — fatia própria. Reusa esta inteira (`IEmailSender`,
  `ITokenGenerator`, `ITokenDigest`, o thunk), e é justamente por isso que
  misturar as duas esconderia qual peça serve a qual fluxo.
- **Outbox transacional e `cron.ts`** — ver §5.3. É a única solução correta para
  um crash entre o commit e o envio, e custa uma fatia inteira.
- **E-mail de boas-vindas** — não defende nada e não destrava nada.
- **Templates HTML** — dobram a superfície de template e trazem decisão própria
  de escaping. Um e-mail cujo conteúdo é um código de seis dígitos não ganha nada.
- **CORS** — continua dependendo do primeiro front web.
- **Poda de `email_verification_tokens`** — a tabela nasce crescendo sem limite,
  como `refresh_tokens`. Ver §12.5.
- **Backfill de contas existentes** — ver §6.4. A ausência é decisão, não
  esquecimento.

## 3. A afirmação do handoff que caiu

### 3.1 — `ITokenGenerator` **não** serve "como está"

O §3 do handoff afirma, marcado `[lido]`:

> `ITokenGenerator.opaque(bytes?)` — pronto; o token de verificação reusa **como
> está**.

Isso valia para a fatia que o handoff imaginava, com um token opaco no molde do
refresh. Com a decisão do §6.2 — código numérico de seis dígitos — não vale:
[`token-generator.ts`](../../../src/shared/ports/token-generator.ts) só expõe
`opaque(bytes?)`, e um código numérico **uniforme** precisa de `randomInt`.

Derivar o código de `opaque()` com `%` introduziria viés modular: 256 não é
múltiplo de 10, então os dígitos baixos sairiam com probabilidade maior. E a R7
proíbe o use case chamar `randomInt` por conta própria.

A porta muda, portanto — e a mudança é coerente com o que ela já se declara ser
na própria docstring: *"a única fonte de aleatoriedade criptográfica que a camada
pura pode usar"*. Ver §6.3.

> **Calibração, no espírito do §3 da spec anterior.** A afirmação do handoff não
> era descuidada: era correta sob a premissa dele. O que envelheceu foi a
> premissa, não a leitura. É um modo de falha diferente do da fatia 9 — lá as
> afirmações estavam erradas sobre o presente; esta estava certa sobre um futuro
> que não aconteceu.

## 4. A implementação de referência: o que o `byteflow` já resolveu

O `byteflow` tem esta fatia em produção de desenho: tabela
`email_verification_tokens`, código de seis dígitos, `POST /auth/verify-email`,
reenvio com cooldown, gate no login e SMTP via nodemailer contra Mailpit.

### 4.1 — Copiado, porque está certo

| Peça | Por quê |
|---|---|
| Código numérico de 6 dígitos, sha256 guardado, código nunca persistido | ver §6.2 |
| TTL 15 min · teto de 5 tentativas · cooldown de reenvio 60 s | os três juntos são o que substitui entropia; ver §6.2 |
| Busca **sempre por `user_id`**, nunca por `code_hash` global | ver §7.2 |
| Thunk `deliver`: persiste dentro, devolve o envio | ver §5.1 |
| `smtpTransportOptions` como **função pura exportada** | é o que torna `requireTLS` e o piso de TLS testáveis sem servidor SMTP |
| `MAIL_*` opcional em dev, obrigatório em produção por refine | ver §8.1 |
| `202` genérico no reenvio, silencioso para e-mail desconhecido ou já verificado | ver §6.5 |
| Gate do login lançado **depois** da checagem de senha | ver §6.4 |

### 4.2 — Corrigido

**A entidade dele conhece `node:crypto`.** `EmailVerification.issue()` chama
`randomUUID()` e `new Date()`, e `hash()` chama `createHash` — tudo dentro da
camada de domínio. Aqui isso viola a R7 e a decisão 21. A entidade desta fatia
recebe `id`, `now` e `codeHash` prontos, e `matches()` recebe o **digest**, não o
código cru (§7.3).

**A sessão dele é emitida fora da transação.** O `ConfirmEmail` do byteflow
comita a verificação e depois chama `sessions.issueFor(user)`. Aqui o
`refreshTokens.save` entra **dentro** do mesmo `uow` (§6.3), porque o repositório
já está no `AuthRepos` e o custo é zero.

### 4.3 — Deixado em aberto lá, e fechado aqui

**A enumeração do `register` continua lá.** O endpoint responde `201 { userId }`
e o `409` de e-mail tomado segue publicado. Isso torna decorativo o cuidado do
`202` genérico no reenvio: quem quiser enumerar contas chama o `register`. Aqui a
fatia fecha os dois (§6.1).

**O adapter SMTP dele não tem teste que o exercite.** `smtp-mailer.spec.ts` testa
só a função pura de opções; os use cases usam `FakeMailer`; nada lê a mensagem de
volta do Mailpit. É exatamente o buraco que a revisão da fatia 9 cobrou aqui —
ver §10.2.

**O `register` dele não trata o e-mail já cadastrado e ainda não verificado.**
Não precisa: como responde `409`, o usuário sabe que a conta existe e vai para o
reenvio. Um `202` sem esse tratamento deixaria o usuário travado para sempre —
ver §6.1.

## 5. O §8 do Unit of Work, que governa esta fatia inteira

A primeira linha da tabela do §8 da fatia 4 diz:

> **I/O externo** — e-mail, HTTP → segura a transação aberta pelo tempo da rede.
> Persista dentro, envie **depois** do commit.

Há **dois** estragos independentes por trás dessa linha, e vale separá-los porque
eles têm causas diferentes:

1. **Retry.** O `TransactionRunner` reexecuta o callback inteiro a cada
   tentativa, e `MAX_ATTEMPTS` é 3. Um `40P01` na segunda escrita reexecuta tudo,
   e o e-mail sai de novo. Sem erro, sem log, e nunca em desenvolvimento —
   deadlock exige concorrência.
2. **Rollback.** Se a transação falhar depois do envio, foi mandado um e-mail
   sobre uma conta que não existe.

> **Simetria com a fatia 9.** Lá o proibido era **CPU** dentro da transação, e
> bastou tirar de dentro. Aqui é **I/O externo**, e tirar de dentro não basta:
> tem de ser *depois do commit*, porque só o commit garante que o motivo do
> e-mail existe.

### 5.1 — A escolha: o thunk `deliver`

`EmailVerificationIssuer.issueFor(user, verifications, now)` persiste no
repositório que **recebe** — passe o da transação — e devolve a função que envia:

```ts
export type DeliverVerification = () => Promise<void>
```

O use case fica:

```ts
const deliver = await this.uow(async ({ users, emailVerifications }) => {
  await users.save(user)
  return this.issuer.issueFor(user, emailVerifications, now)   // atravessa o commit
})

await deliver()                                                 // depois do commit
```

O ponto não é elegância: **dentro do callback não existe nada que envie**.
`issueFor` devolve uma função, e chamá-la ali dentro exigiria escrever
`await (await this.issuer.issueFor(...))()` — feio o bastante para não passar
numa revisão. A regra do §8 vira estrutura em vez de comentário, e `register` e
`resend` compartilham uma definição só de emitir→persistir→enviar.

### 5.2 — Descartado: inline no use case

O `uow` devolveria o código em texto e o use case enviaria depois. Menos peças e
leitura mais direta. Perdeu por dois motivos: duplica ~10 linhas entre `register`
e `resend`, e a versão **errada** é mais curta que a certa —

```ts
await this.uow(async ({ users, emailVerifications }) => {
  await users.save(user)
  await emailVerifications.save(verification)
  await this.emailSender.send(...)   // compila, passa no fake, quebra em produção
})
```

— e nada no compilador, no lint ou no fake passthrough distingue as duas.

### 5.3 — Descartado nesta fatia: outbox transacional

A intenção do e-mail viraria linha na mesma transação, e um worker despacharia.
É a **única** opção correta para o modo de falha que nem o thunk resolve: um
crash entre o `COMMIT` e o `send` perde o e-mail em silêncio.

Perdeu por três motivos, nesta ordem:

1. exige o entrypoint `cron.ts`, que é fatia futura, mais retry, backoff e poda —
   vira duas fatias, não uma;
2. o modo de falha que ela resolve **tem conserto barato aqui**: o reenvio;
3. ela coloca o código em texto claro **em repouso no banco** até o despacho.
   Hoje ele só existe em memória.

O modo de falha que o thunk resolve — e-mail duplicado por retry, ou e-mail de
conta que sofreu rollback — não tem conserto nenhum depois que acontece. A
assimetria é o argumento.

### 5.4 — O risco residual do thunk, e o teste que o mata

Um thunk que ninguém chama falha em silêncio: a conta é criada, nenhum e-mail
sai, e todo teste que só verifica persistência passa verde. É o mesmo formato do
achado da revisão da fatia 9 — a revogação deletada que deixava dez testes
verdes.

O teste é de **ordem completa**, não de presença:

```ts
// Mata deleção do deliver(), envio dentro do callback e reordenação, de uma vez.
expect(callLog).toEqual(['users.save', 'verifications.save', 'COMMIT', 'email.send'])
```

Um `expect(callLog).toContain('email.send')` não mataria nenhuma das três.

## 6. As decisões que o §5 do handoff deixou em aberto

### 6.1 — O `register` responde `202`, sempre

Hoje ele responde `201 { id }` e `409 EMAIL_ALREADY_IN_USE`. O `409` é um
oráculo: qualquer anônimo descobre se um endereço tem conta.

**É esta fatia que torna o fechamento possível.** Fechar exige um canal que
divirja sem que a resposta HTTP divirja — e antes desta fatia não havia e-mail.
É aqui ou nunca; e sem isso, o `202` genérico do reenvio (§6.5) é teatro.

O contrato passa a ser `202`, sem corpo, `z.null()` no schema — a mesma forma que
o `204` do logout usa em [`logout.ts:46-50`](../../../src/modules/auth/infra/http/endpoints/logout.ts).
Somem o `201`, o `id` e o `409`.

Consequência na camada pura: `RegisterUserResult` **deixa de existir** e
`RegisterUserUseCase.execute` passa a devolver `Promise<void>`. Manter um
resultado que o endpoint não pode publicar seria contrato morto — e o `id` ainda
alcançável por quem importasse o use case de outro entrypoint (decisão 10).

`EmailAlreadyInUseError` **continua existindo e sendo lançado** pelo `23505`; só
perde o consumidor HTTP. Quem o consome agora é um `catch` no use case, que
decide qual e-mail sai:

| Estado da conta existente | E-mail enviado |
|---|---|
| já verificada | "alguém tentou criar conta com seu endereço; se foi você, faça login ou recupere a senha" |
| ainda **não** verificada | um **código novo**, sujeito ao mesmo cooldown do reenvio |
| (corrida: sumiu entre o `23505` e a leitura) | nenhum — o `deliver` é no-op |

A segunda linha fecha um buraco que o `202` cria e que o byteflow nunca enfrentou
(ele responde `409`): sem ela, quem se cadastrou, perdeu o e-mail e tentou de novo
receberia "você já tem conta" e ficaria travado para sempre. Com ela,
**recadastrar é reenviar**.

**Custo aceito:** o `id` sai da resposta. Ele nunca serviu para muita coisa — o
`register` não emite sessão — mas é contrato publicado, e algum cliente pode
estar lendo.

**Descartado — `202 { id }`, devolvendo o id da conta existente na colisão:**
preserva o campo, mas vaza mais que o `409`, entregando o identificador interno de
uma conta alheia a qualquer anônimo.

### 6.2 — Código de seis dígitos, não link

**Escolhido:** o e-mail traz seis dígitos; o cliente manda
`POST /auth/email/verify { email, code }`.

- verbo honesto — `GET` que muda estado é reexecutável por retry e prefetch;
- imune a pré-fetcher de e-mail corporativo, que consome links sozinho e faz o
  usuário receber "já verificado" antes de clicar;
- não exige `FRONT_URL`, CORS nem front — e este repositório não tem front, com
  CORS declarado como fatia futura;
- o código não vaza em `Referer` nem em log de acesso, como um token em
  querystring vazaria.

**O custo é explícito e tem preço pago em três parcelas.** Seis dígitos são 10⁶
combinações — entropia irrisória perto dos 256 bits do refresh. O que substitui a
entropia:

| Defesa | Valor | O que impede |
|---|---|---|
| TTL | 15 min | a janela de ataque |
| Teto de tentativas **por código** | 5 | força bruta sobre um código vivo |
| Cooldown de reenvio | 60 s | virar um oráculo de códigos novos à vontade |

Mais o teto de rate limit por IP na rota (§8.2). Sem os três juntos, seis dígitos
seriam inaceitáveis; com eles, o custo esperado de um acerto é proibitivo.

**Descartado — link opaco via `GET`:** entropia total e um clique, mas verbo
errado, prefetch corporativo e vazamento por `Referer`.

**Descartado — link para o front que faz `POST`:** junta um clique com verbo
correto, mas exige `FRONT_URL`, CORS e um front que não existe — a fatia não
conseguiria provar o caminho ponta a ponta.

**Descartado — código alfanumérico de 8:** ~10¹² combinações e menos pressão
sobre o teto de tentativas, mas pior UX mobile (teclado alfanumérico, e a
ambiguidade `O`/`0` e `I`/`1` obrigaria a um alfabeto reduzido tipo Crockford).
O teto de tentativas já resolve os 10⁶ — a entropia extra não compra nada que
não esteja comprado.

### 6.3 — `EmailVerificationFailedError` é `BusinessRuleError` → 422

Um erro **só** para todos os modos de falha do `confirm`: e-mail desconhecido,
nenhum código ativo, expirado, tentativas esgotadas, código errado, corrida
perdida. O raciocínio é o de [`login-user.ts:54-57`](../../../src/modules/auth/use-cases/login-user.ts):
dois ramos começam idênticos e divergem na primeira manutenção — um ganha um log,
o outro uma mensagem — e o oráculo volta.

422 e não 400: o corpo é sintaticamente válido (seis dígitos), o que falhou foi
uma regra. É simétrico ao `InvalidCurrentPasswordError` da fatia 9 — segredo
errado apresentado por quem já se identificou.

### 6.4 — `EmailNotVerifiedError` é `ForbiddenError` → 403

O handoff manda **não copiar** a escolha da fatia 9 aqui, e ele tem razão. A
fatia 9 escolheu 422 para senha atual errada por causa do laço de refresh do
interceptor mobile diante de um 401. Esse argumento não se aplica: isto acontece
**no login**, onde não há token a refrescar.

403 é o que a própria decisão 13 glosa como *"autenticado, sem permissão"*, e é
literalmente o caso: quando o erro é lançado, a senha **já bateu** — o servidor
sabe exatamente quem é, e o que falta é permissão para prosseguir.

`ForbiddenError` → 403 já está mapeado em
[`error-handler.ts:64`](../../../src/infra/http/errors/error-handler.ts); falta
só `FORBIDDEN_STATUS` e `ACCEPTED_STATUS` nas constantes HTTP do módulo.

**A ordem do gate é a defesa.** O `throw` vem **depois** da checagem de
credencial, para que o sinal "não verificado" só chegue a quem já provou saber a
senha — senão o gate vira uma superfície de enumeração nova, no mesmo endpoint
que gastou um decoy de argon2 para fechar a antiga.

**Sem backfill.** Ligar o gate tranca toda conta existente, porque `User.create`
sempre grava `emailVerifiedAt: null` e nada nunca escreveu outro valor — logo
100% das linhas de `users` têm `email_verified_at` nulo. A saída escolhida é
**nenhuma**: não há contas, em lugar nenhum. O projeto está em estado de
boilerplate e nunca teve usuário real.

> ⚠️ **Ressalva normativa para apps derivados.** Um app que já esteja em produção
> sobre uma versão anterior deste boilerplate **precisa escrever a própria
> migration de grandfathering** (`UPDATE users SET email_verified_at = now()
> WHERE email_verified_at IS NULL`) **antes** de puxar esta fatia. Sem ela, o
> merge é uma queda de login em massa — e é o tipo de coisa que passa em toda a
> suíte de testes, porque os testes criam contas novas dentro do mesmo cenário.

**Descartado — flag de env `REQUIRE_EMAIL_VERIFIED`:** cria um ramo permanente no
caminho mais quente da autenticação, dobra a matriz de teste do login, e um gate
desligável é um gate que fica desligado.

**Descartado — corte por data de `created_at`:** enfia uma data mágica permanente
num `if` que ninguém remove, e que mente sobre o estado real da conta.

### 6.5 — Reenvio existe, é `202` sempre, e tem cooldown próprio

Sem reenvio, um código expirado mata a conta em definitivo — não é opcional.

`POST /auth/email/verify/resend { email }` responde `202` sem corpo em **todos**
os casos: e-mail inexistente, conta já verificada, dentro do cooldown, ou envio
feito. O use case simplesmente retorna nos três primeiros.

É um endpoint que dispara e-mail para terceiro a partir de request anônima — ou
seja, um amplificador de spam. O cooldown de 60 s por conta (medido pelo
`created_at` do código ativo) e o teto de rate limit por IP (§8.2) são o que o
contêm.

### 6.6 — O `confirm` faz auto-login

Devolve access token no corpo e refresh no cookie, reusando o `sessionTokensSchema`
e o `RefreshTokenIssuer` que já existem. Poupa um round-trip e evita o usuário
digitar a senha duas vezes seguidas.

### 6.7 — Tabela nova, não coluna em `users`

Um código de verificação tem hash, expiração, uso único **e contador de
tentativas**. Coluna em `users` não guarda o contador sem inchar a tabela mais
quente do módulo com quatro colunas que 99% das leituras ignoram, não permite
reenvio limpo (invalidar o anterior) e não deixa histórico. Custa uma migration.

## 7. Os contratos

### 7.1 — A porta do envio

`shared/ports/email-sender.ts`, e **não** `modules/auth/ports/`. O critério é o
que já pôs `IClock` e `ITokenDigest` em `shared/`: mandar e-mail é capacidade
técnica transversal, não conceito de autenticação. O próximo módulo que precisar
notificar não vai importar uma porta do `auth` — isso seria o antipadrão da R5.

```ts
export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface IEmailSender {
  send(message: EmailMessage): Promise<void>
}
```

Só `text`, pelo motivo do §2.

O adapter é `infra/providers/smtp-email-sender.ts` (nodemailer), e exporta uma
função **pura** `smtpTransportOptions(config)` — a única peça copiada
literalmente do byteflow, porque é o que torna `requireTLS` e
`minVersion: 'TLSv1.2'` testáveis sem servidor SMTP.

### 7.2 — A tabela `email_verification_tokens`

Espelha `refresh_tokens` de propósito, **inclusive na ausência de defaults**:
todo `timestamptz` vem do `IClock`, pelo motivo já escrito em
[`refresh-tokens.ts:9-14`](../../../src/modules/auth/infra/drizzle/schema/refresh-tokens.ts).
`attempts` também é escrito explicitamente — a entidade é dona do valor, e um
default seria defesa em profundidade para uma escrita direta que não existe.

| Coluna | Nota |
|---|---|
| `id` | uuid, PK, do `IIdGenerator` |
| `user_id` | FK para `users`, `on delete cascade` — legal porque os dois moram no `auth` (decisão 24) |
| `code_hash` | sha256 do código. Nunca o código |
| `expires_at` | |
| `consumed_at` | nulo = ainda usável |
| `attempts` | inteiro; o teto anti-força-bruta |
| `created_at` | é dele que sai o cooldown de reenvio |

**Sem índice único em `code_hash`,** e essa é a diferença que importa em relação a
`refresh_tokens`. Seis dígitos **colidem por desenho**: 10⁶ valores para toda a
base, e duas contas com o mesmo código pendente é evento comum, não alarme. Por
isso a busca é **sempre por `user_id`**. Um lookup global por `code_hash` deixaria
o código de um usuário confirmar a conta de outro — e o índice único chegaria a
recusar a emissão legítima.

Dois índices:

- `email_verification_tokens_user_id_idx` — o cascade do FK precisa dele, e sem
  ele todo `DELETE` de usuário varre a tabela;
- parcial, `on (user_id) where consumed_at is null` — o caminho quente
  (`findActiveByUserId`, `invalidateActiveForUser`). A expiração é filtrada em
  tempo de consulta, não no predicado: predicado de índice parcial precisa ser
  `IMMUTABLE`, e `now()` não é.

Os dois nomes aparecem exatamente uma vez, então ficam inline pela exceção do
`CLAUDE.md`. Nenhum deles é lido de outro arquivo — não há `23505` a
interpretar aqui, ao contrário de
`REFRESH_TOKENS_TOKEN_HASH_UNIQUE_INDEX`.

### 7.3 — A entidade

`EmailVerification`, no molde de `RefreshToken`: campos `#`, `Object.freeze`,
datas clonadas na entrada e na saída.

```ts
static create(props: {
  id: string
  userId: string
  codeHash: string
  now: Date
  ttlSeconds: number
}): EmailVerification

static fromTrusted(props: TrustedEmailVerificationProps): EmailVerification

isUsable(maxAttempts: number, now: Date): boolean   // não consumido, não expirado, sob o teto
matches(codeHash: string): boolean
```

`matches` recebe o **digest**, não o código cru. É a correção sobre o byteflow
(§4.2): a entidade continua sem conhecer portas nem `node:crypto`, exatamente
como `RefreshToken`. O use case faz
`verification.matches(this.tokenDigest.hash(command.code))`.

**Comparação com `===`, não `timingSafeEqual`, deliberadamente.** O que se compara
são dois digests, não dois segredos. Explorar o vazamento de timing exigiria
forjar um código cujo sha256 compartilhasse prefixo com o guardado — e cada
tentativa queima uma das cinco. Usar `timingSafeEqual` traria `node:crypto` para
a camada pura em troca de nada.

### 7.4 — O repositório

```ts
export interface IEmailVerificationsRepository {
  save(verification: EmailVerification): Promise<void>

  /** A mais recente ainda não consumida. NÃO filtra expiração: quem julga tempo é a entidade. */
  findActiveByUserId(userId: string): Promise<EmailVerification | null>

  invalidateActiveForUser(userId: string, at: Date): Promise<void>

  incrementAttempts(id: string): Promise<void>

  /** `WHERE id = ? AND consumed_at IS NULL`; devolve se ESTA chamada queimou o código. */
  consume(id: string, at: Date): Promise<boolean>
}
```

`consume` devolver `boolean` é o que torna o uso único à prova de corrida sem
lock explícito: dois `confirm` simultâneos com o mesmo código, um perde o
`UPDATE` condicional, lança o mesmo erro genérico e dá rollback.

`findActiveByUserId` não filtrar expiração em SQL é o que mantém o teste do TTL
determinístico — o `now` do `IClock` é o único relógio da decisão.

`AuthRepos` ganha `emailVerifications`. `IUsersRepository` ganha:

```ts
markEmailVerified(id: string, verifiedAt: Date, updatedAt: Date): Promise<void>
```

Estreita como `updatePasswordHash`, e pelos mesmos dois motivos escritos em
[`users-repository.ts:24-42`](../../../src/modules/auth/repositories/users-repository.ts):
a coluna errada fica inexpressível, e `updatedAt` vai **explícito** porque o
`$onUpdate` preenche a ausência — omitir aqui é o jeito silencioso de o `IClock`
deixar de ser a fonte da verdade.

Os dois parâmetros recebem o mesmo instante no único call site. São dois mesmo
assim: colapsá-los faria o repositório **decidir** que `email_verified_at` é
sempre igual a `updated_at`, o que é verdade neste chamador e não é uma
propriedade da tabela.

> **Custo aceito.** `consumed_at` marca tanto "usado" quanto "substituído por
> reemissão". `refresh_tokens` separa isso em `revoked_at` + `replaced_by` porque
> a detecção de reuso precisa da distinção. Aqui não há cadeia, e nada a jusante
> lê a diferença — uma coluna só.

## 8. Configuração

### 8.1 — `MAIL_*` no env **core**

Em `infra/config/env.ts`, junto de `DATABASE_URL`, e não no módulo: o mailer não
é do `auth` (§7.1). A R6 continua valendo — só esse arquivo lê `process.env`.

| Variável | Nota |
|---|---|
| `MAIL_HOST`, `MAIL_PORT` | default de dev aponta para o Mailpit (`127.0.0.1:1025`) |
| `MAIL_SECURE` | TLS implícito na conexão (SMTPS, 465). Default `false` |
| `MAIL_REQUIRE_TLS` | força STARTTLS: a conexão **falha fechada** se o servidor não subir para TLS. Default `false` — o Mailpit não tem STARTTLS |
| `MAIL_FROM` | |
| `MAIL_USER`, `MAIL_PASSWORD` | opcionais — o Mailpit não pede auth |

Com um `superRefine` no schema já mergeado: em `NODE_ENV=production`,
`MAIL_HOST`, `MAIL_PORT` e `MAIL_FROM` passam a ser obrigatórios e
`MAIL_REQUIRE_TLS` precisa ser `true`. É o mesmo movimento do `TRUST_PROXY` em
[`env.ts:119-120`](../../../src/infra/config/env.ts), e impede um cenário
concreto: subir em produção herdando o default de dev e mandar códigos de
verificação em texto claro pela internet, para um MITM que basta suprimir o
anúncio de STARTTLS.

### 8.2 — O módulo

Em `modules/auth/config.ts`, todos com `.int().positive()` pelo motivo já
documentado ali (um valor vazio vira `0` em silêncio):

`EMAIL_VERIFICATION_TTL_SECONDS` (900) · `EMAIL_VERIFICATION_MAX_ATTEMPTS` (5) ·
`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS` (60).

E **três** pares de rate limit, no molde do `PASSWORD_CHANGE_RATE_LIMIT_*`:

| Rota | Por quê |
|---|---|
| `register` | **passa a disparar e-mail para endereço arbitrário a partir de request anônima.** Hoje herda só o teto global de 300/min: é um amplificador de spam que esta fatia cria |
| `email/verify` | palpite de código, mesmo raciocínio do login |
| `email/verify/resend` | idem `register`, e ainda permite queimar o código legítimo da vítima |

Pares separados e não compartilhados, pelo motivo já escrito em
[`config.ts:44-46`](../../../src/modules/auth/config.ts): *"um campo chamado
`login` numa rota que não é login é um comentário que mente"*.

### 8.3 — Mailpit no compose e no CI

Serviço `mailpit`, **pinado exato** como o Postgres, ligado só em `127.0.0.1`
(1025 SMTP, 8025 UI/API), sem volume — mensagem capturada é efêmera por desenho.
O `ci.yml` ganha o mesmo bloco em `services:`, ao lado do Postgres, que já usa
esse mecanismo.

## 9. Os fluxos

### 9.1 — `RegisterUser`

```ts
const email = Email.create(command.email)
const password = Password.create(command.password)
const passwordHash = await this.hashProvider.hash(password.value)   // fora da tx — §8, CPU
const now = this.clock.now()
const user = User.create({ id: this.idGenerator.generate(), email, passwordHash, now })

let deliver: DeliverVerification
try {
  deliver = await this.uow(async ({ users, emailVerifications }) => {
    await users.save(user)                                  // 23505 → EmailAlreadyInUseError
    return this.issuer.issueFor(user, emailVerifications, now)
  })
} catch (error) {
  if (!(error instanceof EmailAlreadyInUseError)) throw error
  deliver = await this.deliverForExisting(email, now)
}

await deliver()
```

`clock.now()` é lido **uma vez**, como no §6.0 da fatia 9.

O use case passa a receber o UoW **e** `Pick<IUsersRepository, 'findByEmail'>`
para a leitura do caminho de colisão — a §9 emendada, exatamente como escrita: o
`Pick` faz de uma escrita direta um erro de compilação.

### 9.2 — `ConfirmEmail`

```ts
const user = await this.users.findByEmail(Email.create(command.email))
const verification = user === null ? null : await this.verifications.findActiveByUserId(user.id)
const now = this.clock.now()

if (user === null || verification === null || !verification.isUsable(this.maxAttempts, now)) {
  throw new EmailVerificationFailedError()
}

if (!verification.matches(this.tokenDigest.hash(command.code))) {
  await this.verifications.incrementAttempts(verification.id)   // autocommit — §8, linha 3
  throw new EmailVerificationFailedError()
}

const issued = this.refreshTokenIssuer.issue(user.id, this.refreshTokenIssuer.newFamilyId(), now)

await this.uow(async ({ users, emailVerifications, refreshTokens }) => {
  if (!(await emailVerifications.consume(verification.id, now))) {
    throw new EmailVerificationFailedError()                    // perdeu a corrida → rollback
  }
  await users.markEmailVerified(user.id, now, now)
  await refreshTokens.save(issued.entity)
})

return { accessToken: await this.tokenSigner.sign({ sub: user.id }), refreshToken: issued.token }
```

Três coisas ficam **fora** da transação, cada uma por uma linha diferente do §8:

| O quê | Linha do §8 |
|---|---|
| `hash` do código e `sign` do access token | CPU pesada |
| `incrementAttempts` | escrita que precisa sobreviver à falha |

Este é o único fluxo da fatia que **não** manda e-mail — daí não haver thunk aqui.

`refreshTokens.save` fica **dentro**, ao contrário do byteflow: o repositório já
está no `AuthRepos`, então custa zero, e "verificado e logado" vira um átomo só.
Se a sessão falhar, a verificação volta atrás e o **mesmo** código funciona na
retentativa.

### 9.3 — `RequestEmailVerification`

Lê o usuário; retorna se não existe, se já está verificado, ou se o código ativo
foi criado há menos que o cooldown. Caso contrário abre um `uow`, emite pelo
`issuer` e chama o `deliver` depois do commit. Resposta `202` em todos os casos.

### 9.4 — `LoginUser`

Uma linha depois da checagem de credencial (§6.4), e o comentário das linhas
31-32 sai.

### 9.5 — `ChangePassword` e a assimetria propaga / best-effort

A notificação vai depois que o `uow` retorna. Mas as duas famílias de e-mail
desta fatia têm políticas **opostas** diante de uma falha de envio:

- **Falha ao enviar o código de verificação propaga.** A conta não serve para
  nada sem ele, e recadastrar se autocura pelo caminho de colisão (§6.1).
- **Falha ao enviar a notificação NÃO pode propagar.** A senha **já mudou**. Um
  500 diria ao usuário que a troca falhou, e a senha antiga já não funciona — é
  desinformação ativa, e pior que o silêncio.

A decisão 15 é taxativa: *"o use case não loga e não recebe logger"*. Logo a
política não pode morar no use case, que precisaria capturar e registrar. Ela
vira **fiação**: um decorador `BestEffortEmailSender` em `infra/providers/`, que
captura, loga (infra pode logar) e resolve. O `container.ts` injeta o decorado só
na troca de senha e o cru no resto.

Isso põe a escolha no composition root, que é onde a decisão 08 diz que ela
pertence, e mantém a camada pura ignorante de logging.

> **Custo aceito.** Dois `IEmailSender` no container, indistinguíveis pelo tipo:
> trocá-los na fiação é erro silencioso. Mitigado por nome
> (`emailSender` / `bestEffortEmailSender`) e por teste — a mesma forma que os
> dois pares de rate limit já usam.

## 10. Testes

### 10.1 — Unidade

| Alvo | O que o teste mata |
|---|---|
| `RegisterUser`, sucesso | `expect(callLog).toEqual(['users.save','verifications.save','COMMIT','email.send'])` — deleção do `deliver()`, envio dentro do callback e reordenação, de uma vez |
| `RegisterUser`, colisão | verificada → e-mail "você já tem conta"; **não** verificada → código novo; não verificada dentro do cooldown → **nenhum** e-mail; e que erro que não seja `EmailAlreadyInUseError` **propaga** |
| `ConfirmEmail` | os seis modos de falha lançam o **mesmo** erro; código errado incrementa a tentativa; `consume` devolvendo `false` lança e dá rollback; a ordem do sucesso por `toEqual`; o `sub` do access token |
| `LoginUser` | senha **errada** em conta não verificada devolve `InvalidCredentialsError`, **não** `EmailNotVerifiedError`. É o único teste que quebra se alguém "simplificar" movendo o `if` do gate para cima |
| `RequestEmailVerification` | e-mail desconhecido, já verificado e dentro do cooldown: nenhum envio, mesmo retorno |
| `EmailVerification` | `isUsable` nas três fronteiras (consumido, expirado, teto batido); clonagem das datas |
| `EmailVerificationIssuer` | invalida **antes** de salvar; o thunk devolvido envia; o thunk **não** é chamado por dentro |
| `RandomTokenGenerator.numericCode` | comprimento fixo, só dígitos, e que **zeros à esquerda sobrevivem** — `000042` é código válido, e um `.toString()` ingênuo o encurtaria |
| `BestEffortEmailSender` | falha do envio não vaza para o chamador |
| `smtpTransportOptions` | `requireTLS` e `minVersion: 'TLSv1.2'`; auth omitida sem usuário |
| `env` | produção sem `MAIL_*` **não** sobe; produção com `MAIL_REQUIRE_TLS=false` **não** sobe |

### 10.2 — Integração

- `email-verification-tokens-schema.spec.ts` — colunas, cascade do FK, os dois
  índices;
- `drizzle-email-verifications-repository.spec.ts` — `consume` devolve `true` na
  primeira chamada e `false` na segunda (uso único contra o Postgres real);
  `incrementAttempts`; `invalidateActiveForUser`; `findActiveByUserId` devolve a
  mais recente não consumida;
- **`verify-email.spec.ts` — o fluxo inteiro lendo o Mailpit.** Registra, busca a
  mensagem pela API HTTP do Mailpit, extrai os seis dígitos, confirma, recebe
  `200` + cookie de refresh. É o único teste em que o `SmtpEmailSender` real está
  no caminho, e é o buraco que o byteflow deixou (§4.3);
- `register.spec.ts` — `202` sem corpo para e-mail novo **e** para e-mail tomado;
  ausência do `409` e do `id`;
- `login.spec.ts` — `403` para conta não verificada, `200` depois de verificar;
- `resend` — `202` para e-mail inexistente e para conta já verificada.

### 10.3 — Falsificação

Toda mutação vale, mas **a deleção vale mais que a troca** — foi o achado da
revisão da fatia 9. Em particular: deletar o `await deliver()`, deletar o
`incrementAttempts`, deletar o `if (!consumed)`, deletar o gate do login, e
inverter a ordem entre o gate e a checagem de senha. Se algum desses deixar a
suíte verde, o teste é que está errado.

## 11. A medir, não presumir

Três afirmações desta spec são raciocínio, não medição, e a implementação deve
confirmá-las antes de confiar nelas:

1. **[suposto]** O `uow` do caminho de colisão, aberto no `catch` do primeiro, é
   **sequencial e não aninhado** — a guarda de `AsyncLocalStorage` do §4.2 já
   desfez o contexto quando o callback rejeitou. Se estiver errado, o `register`
   lança na colisão em vez de mandar e-mail.
2. **[suposto]** Os dois caminhos do `register` custam tempo parecido: ambos pagam
   argon2, que domina. Se a diferença for mensurável, o `202` volta a ser um
   oráculo — só que por timing.
3. **[suposto]** O `postgres.js` reporta linhas afetadas de forma que
   `consume` consiga distinguir 0 de 1. Todo o uso único depende disso.

## 12. Custos aceitos

### 12.1 — O `id` sai do contrato do `register`

Ver §6.1. Contrato publicado que algum cliente pode estar lendo.

### 12.2 — Reenvio pode queimar o código legítimo da vítima

Quem souber o e-mail de alguém pode chamar o reenvio a cada 60 s, invalidando o
código que a vítima acabou de receber e enchendo a caixa dela. O cooldown e o
teto por IP limitam a taxa; não eliminam o incômodo.

### 12.3 — Um crash entre `COMMIT` e `send` perde o e-mail

Sem sinal nenhum para o usuário além de não receber nada. O conserto é o reenvio.
A solução correta é o outbox (§5.3), adiado.

### 12.4 — Um dump do banco entrega os códigos vivos

sha256 sobre 10⁶ valores quebra em microssegundos. É aceitável porque o dano é
limitado pelo TTL de 15 minutos e pelo uso único — e porque quem tem dump do
banco tem problemas maiores. Não vale argon2 aqui: a docstring de
[`token-digest.ts`](../../../src/shared/ports/token-digest.ts) explica por que
digest determinístico é o requisito — e o argumento dela (argon2 saltea, então
`WHERE code_hash = ?` nunca casaria) vale igual para este caso.

### 12.5 — `email_verification_tokens` cresce sem limite

Cada reenvio insere uma linha e nada apaga. É a mesma dívida de `refresh_tokens`,
que a fatia 9 já havia acelerado. A poda que estava no roteiro passa a ter
**duas** tabelas.

### 12.6 — Dois `IEmailSender` no container

Ver §9.5.

## 13. Emendas de documentação

| Onde | O quê |
|---|---|
| `DECISIONS.md` | o `202` do `register` como mudança de contrato público deliberada; a ausência de backfill com a ressalva para apps derivados; `EmailNotVerifiedError` → 403 e `EmailVerificationFailedError` → 422 na taxonomia da decisão 13 |
| spec do Unit of Work, **§8** | o thunk `deliver` como o caso concreto da linha "I/O externo", e a distinção retry × rollback do §5 |
| spec do Unit of Work, **§9** | hoje a regra manda declarar o `Pick` **só com leitura**. `incrementAttempts` a viola com razão. Passa a ser: o `Pick` lista o que o use case usa, e uma **escrita** só entra quando a linha 3 do §8 a justifica — com o porquê escrito no lugar |
| `ARCHITECTURE.md` §11 | o que o nodemailer falhar em silêncio nos ensinar, começando pelo `requireTLS` |
| `docs/local.md` | Mailpit em `http://127.0.0.1:8025` |
| `docs/STRUCTURE.md` | os arquivos novos |

## 14. Próxima fatia

**Recuperação de senha.** Reusa esta inteira — `IEmailSender`, o thunk,
`ITokenGenerator`, `ITokenDigest`, o molde da tabela com hash + expiração + uso
único — e é o fluxo sem senha atual a apresentar. Deve ser a fatia mais barata do
roteiro, justamente porque esta pagou a infraestrutura.

Depois dela, a **poda** ganha urgência: duas tabelas crescendo, e o `cron.ts`
ainda não existe.
