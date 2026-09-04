# Fatia 9 — Troca de senha: o consumidor da revogação, e o primeiro `UPDATE` em `users`

> Escrita em 2026-09-03, a partir do handoff `2026-09-03-handoff-password-change.md`.
> Três afirmações daquele documento foram medidas e **refutadas** — ver §3. Elas
> estão registradas aqui porque o handoff continua no repositório, e uma sessão
> futura pode reabri-lo.

## 1. Objetivo

`POST /auth/password`: o usuário autenticado troca a própria senha apresentando
a senha atual, todas as sessões existentes são revogadas, e o aparelho que fez a
troca recebe um par de tokens novo.

É a fatia que fecha o laço da revogação: `revokeAllForUser` existe desde a fatia
7 e, até aqui, só era alcançado por um endpoint que o próprio usuário precisava
chamar de propósito.

## 2. Escopo

### Entra

- endpoint `POST /auth/password`, sob o guard de autenticação;
- `ChangePasswordUseCase`;
- `updatePasswordHash` no `IUsersRepository` e nas duas implementações;
- dois erros novos, ambos `BusinessRuleError` — as **primeiras** subclasses
  concretas dessa categoria no projeto;
- teto de rate limit próprio para a rota, com variáveis próprias;
- extração do `okSchema` de sessão, hoje duplicado em dois endpoints.

### Não entra, e por quê

| Fora | Motivo |
|---|---|
| Notificação por e-mail de "sua senha mudou" | Não existe provedor de e-mail. É a fatia de verificação de e-mail que o traz. |
| Recuperação de senha (esqueci a minha) | Depende de verificação de e-mail. Fluxo diferente: não há senha atual a apresentar. |
| Histórico de senhas ("não reuse as últimas N") | Exigiria tabela nova e argon2 por entrada do histórico. Nada nesta fatia pede. |
| Revogação por conta no rate limit | O `keyGenerator` roda em `onRequest`, antes do guard — ver §9.3. |
| `passwordChangedAt` na entidade | Nenhum leitor. `updated_at` já registra o instante. |

## 3. Três afirmações do handoff que a medição derrubou

O handoff foi escrito para poupar redescoberta, e na maior parte funcionou. Mas
o §6 dele manda **verificar, não presumir**, e aplicado a ele próprio derruba
três coisas.

### 3.1 — `$onUpdate` **não** sobrescreve o `IClock`

O §4.1 do handoff afirma que o `$onUpdate` da coluna `updated_at` descarta, em
silêncio, o valor calculado pelo `IClock`, e propõe escolher entre remover o
`$onUpdate` ou desistir do relógio injetado.

Medido em 2026-09-03 contra o `drizzle-orm@1.0.0-rc.4` do repositório,
construindo a query e lendo o SQL emitido:

```
set({ passwordHash, updatedAt: new Date('2020-01-01') })
  → updated_at = '2020-01-01T00:00:00.000Z'    ← o valor explícito venceu

set({ passwordHash })
  → updated_at = '2026-09-03T23:26:06.062Z'    ← o $onUpdate preencheu
```

A causa está em `pg-core/dialect.js`, no `buildUpdateSet`:

```js
const value = set[colName] ?? (is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col))
```

O `??` é o mecanismo inteiro: **o `$onUpdate` preenche a ausência, nunca
sobrescreve a presença.** Ele se comporta exatamente como os outros defaults do
schema, que o comentário do próprio `users.ts` já descreve como defense-in-depth
para escrita direta — seeds, `psql`, migração de dados.

Não há decisão a tomar, e o `$onUpdate` fica onde está. O que sobra é uma regra
menor e uma asserção:

> **O repositório passa `updatedAt` sempre, explicitamente.** Omitir a coluna é
> o único caso em que o relógio do sistema entra em silêncio, e é isso que o
> teste de integração do repositório trava — gravando uma data de 2020 e
> assertando 2020. Com o relógio real os dois valores coincidiriam e o teste
> provaria nada.

Nota lateral, sem consequência prática: o `col.onUpdateFn?.()` na linha anterior
é chamado **mesmo quando o valor explícito existe**, e só depois descartado. Com
`() => new Date()` isso é um objeto jogado fora. Se algum dia essa função tiver
efeito colateral, ele acontece de qualquer forma.

### 3.2 — O trade-off da sessão preservada não distingue as opções

O §5 do handoff apresenta *"revoga todas menos a atual"* com o custo de que, se o
atacante for quem trocou a senha, a sessão preservada é a dele.

Verdade, mas isso não separa desenho nenhum: **o atacante acabou de definir a
senha nova**, então ele faz login de novo em qualquer um dos três. Revogar tudo
não o expulsa — expulsa a vítima junto com ele. A escolha é de UX e de superfície
de contrato, e foi feita nesses termos (§4).

### 3.3 — O estado do repositório no §7 está vencido

O §7 afirma *"Nada mergeado"*. Em 2026-09-03, `main` contém `b4d6030 Merge pull
request #2 from levroxlabs/feat/rate-limiting`, e `git branch --contains`
confirma que **as duas** branches — `feat/rate-limiting` e
`feat/refresh-token-rotation` — já estão em `main`. Esta fatia parte de `main`.

## 4. As cinco decisões que o §5 do handoff deixou em aberto

### 4.1 — A sessão atual não sobrevive, e o endpoint emite um par novo

Todas as famílias são revogadas, sem exceção, e o aparelho que trocou a senha
recebe `accessToken` + `refreshToken` novos na resposta. A família nova nasce
**depois** da revogação, dentro da mesma transação.

Descartado *revogar tudo e pronto*: o app teria de mandar o usuário para a tela
de login logo após um `204` de sucesso, o que parece erro.

Descartado *revogar todas menos a atual*: exigiria que o endpoint recebesse o
refresh token atual só para saber qual família poupar — um segredo trafegando
num endpoint que não precisa dele — e um método novo no repositório. Pela §3.2,
não compra segurança nenhuma em troca.

### 4.2 — A revogação vai pelo `repos` do callback, não pelo `LogoutAllUseCase`

`ChangePasswordUseCase` chama `refreshTokens.revokeAllForUser(...)` dentro do seu
próprio `uow`, junto das outras duas escritas.

Compor os dois use cases era impossível de partida: o `LogoutAllUseCase` abre a
**própria** transação, e `uow` dentro de `uow` é o §4.2 do design da fatia 4 —
duas transações independentes, atomicidade quebrada e travamento que o detector
de deadlock do Postgres não enxerga.

E não há duplicação a evitar: o único lugar que sabe revogar tudo continua sendo
`revokeAllForUser`, no repositório. Os dois use cases são clientes dele, não
cópias um do outro. Um serviço compartilhado por cima seria uma camada cujo corpo
é uma linha de delegação; ele se paga quando a revogação ganhar regra própria
(auditoria, notificação), não antes.

### 4.3 — Senha atual errada é `BusinessRuleError` → 422

`InvalidCurrentPasswordError`, code `INVALID_CURRENT_PASSWORD`.

O argumento decisivo não é semântico, é de comportamento de cliente. **Todo
interceptor mobile trata 401 como "o access token venceu"**: ele dispara um
refresh e repete a request. Um 401 aqui faria o app refrescar um token que está
perfeito, repetir a troca, tomar 401 de novo e — em muitos interceptors —
deslogar o usuário por um erro de digitação. O 422 não é ambíguo: o Bearer estava
correto, a regra é que falhou.

Descartado reusar `InvalidCredentialsError`: além do laço acima, colocaria no
mesmo `code` duas situações em que o app faz coisas opostas. Descartado um
`UnauthorizedError` com code próprio: o interceptor genérico age no **status**,
antes de qualquer código de tela ver o corpo.

Consequência agradável: a linha `[BusinessRuleError, UNPROCESSABLE_ENTITY_STATUS]`
do `error-handler.ts` deixa de ser inalcançável por erro de domínio.

### 4.4 — A senha nova segue a política do registro e precisa diferir da atual

`Password.create(nova)` aplica a mesma política (8–128, letra + dígito +
especial). Uma regra nova rejeita nova igual à atual, com
`PasswordUnchangedError`, code `PASSWORD_UNCHANGED`, 422.

**A comparação é em texto claro e não custa um terceiro argon2.** O corpo já traz
as duas senhas, e a atual já foi confirmada correta pelo `compare`; então
`nova === atual` é comparação exata. Passar a nova por
`hashProvider.compare(nova, user.passwordHash)` gastaria mais ~7 ms para
responder a mesma coisa.

A regra vive no **use case**, não no `Password`: ela fala de um *par* de senhas, e
o value object conhece só uma.

Sem a regra, trocar a senha pela mesma viraria um no-op caro que responde
sucesso — revoga todas as sessões, emite par novo e grava o mesmo segredo com
salt diferente. O usuário que quis "confirmar" a senha perderia os outros
aparelhos sem entender por quê.

### 4.5 — Teto de rate limit próprio, com variáveis próprias

`PASSWORD_CHANGE_RATE_LIMIT_MAX_REQUESTS` e
`PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS`, default `10` e `60` — os mesmos
números do login, porque é o mesmo tipo de request: um palpite de senha por
tentativa, contando requests e não falhas, muito acima de retry humano e muito
abaixo de útil para atacante.

Variáveis próprias e não reuso do `loginRateLimit`: os dois tetos podem divergir,
e um campo chamado `login` declarado numa rota que não é login é comentário que
mente — exatamente o que a auditoria de arquitetura pega.

Sem teto próprio, a rota herdaria só o global de 300/min. O vetor que isso abre é
concreto: **sessão sequestrada → senha trocada → conta tomada**, e 300 palpites
por minuto contra uma conta cujo access token o atacante já tem é generoso demais.

## 5. O contrato HTTP

`POST /auth/password`, com `preHandler: guard`.

`POST` e não `PUT`: a operação **não é idempotente**. Cada chamada revoga todas as
sessões e cunha uma família nova, então repetir tem efeito diferente de chamar
uma vez.

```ts
body: {
  currentPassword: string              // 1 .. MAX_PASSWORD_LENGTH
  newPassword:     string              // política completa
  refreshTransport?: 'body' | 'cookie' // default 'body'
}

200: { accessToken: string, refreshToken?: string }
```

**`currentPassword` valida presença, não política.** Pelo mesmo motivo do login:
aplicar a política aqui responderia 400 onde a resposta certa é 422, contando ao
atacante que o palpite falhou nas *regras* e não na senha — e uma conta criada
sob política mais frouxa precisa continuar podendo trocar de senha. O teto de
tamanho fica pela razão do login: sem ele, um corpo de 10 MB vira argon2 sobre
10 MB.

**`newPassword` valida a política completa no Zod E no `Password.create`.** A
duplicação é a mesma do `register` e é deliberada: o schema é o que dá ao cliente
um 400 com `details` por campo e o que publica a política no OpenAPI; o value
object é o que mantém o use case seguro para os entrypoints não-HTTP da
decisão 10.

**`refreshTransport` no corpo, como no login.** Este é o **segundo** endpoint sem
sinal de entrada para inferir o canal — ele devolve um refresh token sem ter
recebido nenhum. O comentário de `refresh-cookie.ts` que hoje diz *"Only `login`
needs it"* deixa de ser verdadeiro e é emendado (§10).

Descartado inferir pela presença do cookie: ele tem `Path=/auth`, então
*chegaria* aqui — mas um browser que perdeu o cookie receberia o token no JSON, e
aí a SPA guarda em JavaScript o segredo que o desenho quis manter fora dele.

Status declarados: `200`, `400`, `401`, `404`, `422`, `429`, `503`.

Na resposta: em modo cookie, `setRefreshCookie` e o corpo sai só com
`accessToken`; em modo body, o token vai no corpo **e** `clearRefreshCookie` é
chamado — um cookie que tenha sobrado agora aponta para uma família revogada, e
deixá-lo no browser só produz um 401 confuso no refresh seguinte. É o mesmo
raciocínio já escrito no `logout-all`.

### O `okSchema` sai de dentro dos endpoints

`{ accessToken, refreshToken? }` está duplicado **literalmente** em `login.ts` e
`refresh.ts`, o segundo com um comentário apontando para o primeiro. Esta fatia
seria a terceira cópia.

Vai para `infra/http/session-tokens.ts` e é importado pelos três. Não é refactor
oportunista: é um schema que **não pode divergir**, e divergência silenciosa
entre respostas de sessão é bug de contrato público.

## 6. O use case, e por que a ordem é normativa

```ts
class ChangePasswordUseCase {
  constructor(
    private readonly usersRepository: IUsersRepository,  // LEITURA, antes da transação
    private readonly uow: IAuthUnitOfWork,
    private readonly hashProvider: IHashProvider,
    private readonly tokenSigner: ITokenSigner,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly clock: IClock,
  ) {}
}
```

```
1  Password.create(command.newPassword)      política; payload ruim não paga banco nem argon2
2  usersRepository.findById(userId)          null ⇒ UserNotFoundError (404)
3  hashProvider.compare(atual, hash)         argon2 #1 — FORA da transação
                                             false ⇒ InvalidCurrentPasswordError (422)
4  nova === atual, em texto claro            true  ⇒ PasswordUnchangedError (422)
5  hashProvider.hash(nova)                   argon2 #2 — FORA da transação
6  refreshTokenIssuer.issue(...)             randomBytes + sha256, barato
7  uow(async ({ users, refreshTokens }) => {
     users.updatePasswordHash(id, hash, now)
     refreshTokens.revokeAllForUser(id, now)     ← ANTES
     refreshTokens.save(issued.entity)           ← DEPOIS
   })
8  return { accessToken: sign({ sub: id }), refreshToken: issued.token }
```

### 6.0 — `clock.now()` é lido UMA vez

O mesmo `now` alimenta `updated_at` em `users`, `revoked_at` em toda família
revogada, e `created_at`/`expires_at` do token emitido. Ler o relógio três vezes
produziria instantes ligeiramente diferentes para escritas que a transação faz
atômicas, e uma delas — `expires_at` da família nova — é comparada mais tarde
pela janela de graça da rotação.

O `IClock` é a fonte de todos, nunca `defaultNow()`: a decisão 11 registra que
uma coluna preenchida pelo banco chega truncada de microssegundos para
milissegundos, e manda não usar default em coluna que a rotação compara.

### 6.1 — Os dois argon2 ficam fora, e é o §8 da fatia 4 que manda

A troca roda argon2 **duas vezes**: `compare` para a senha atual e `hash` para a
nova. São ~15 ms e ~38 MB somados. O pool tem 10 conexões; segurar um cabo por
15 ms de CPU pura é exatamente o que aquela tabela proíbe.

Por isso o passo 6 também fica fora — não por proibição, mas porque `issue` só
depende do passo 5 e mover trabalho para dentro da transação sem motivo é o
mesmo erro em escala menor. O `save` da entidade emitida é que entra.

### 6.2 — A revogação vem antes do insert, e isso não é estilo

```sql
-- revokeAllForUser
UPDATE refresh_tokens SET revoked_at = $1
 WHERE user_id = $2 AND revoked_at IS NULL
```

Ele revoga **toda linha viva do usuário**, sem exceção. Se o `save` do token novo
vier antes, o token recém-emitido é apanhado pelo próprio `UPDATE` e nasce morto.

O sintoma seria: troca de senha responde 200, e o primeiro refresh do aparelho
responde 401 — o logout aleatório que a decisão da §4.1 existia justamente para
evitar. É um teste de ordem, não um comentário (§8).

### 6.3 — Por que o passo 1 vem antes do passo 2

Espelha a ordem documentada do `RegisterUserUseCase`: os value objects rodam
antes de qualquer custo, então um payload ruim não paga leitura de banco nem
argon2.

### 6.4 — Por que o passo 4 vem depois do passo 3

Se a senha atual estiver errada **e** for igual à nova, a resposta certa é
`INVALID_CURRENT_PASSWORD`, não `PASSWORD_UNCHANGED` — a falha mais informativa
para quem digitou errado. Checar depois não custa nada, porque a comparação é em
texto claro.

### 6.5 — Usuário não encontrado é 404, e é alcançável

`findById` pode devolver `null`: a conta foi apagada enquanto um access token
ainda não expirado circulava. `UserNotFoundError` já existe e o comentário dele
descreve exatamente este caso — os caminhos autenticados, onde o chamador já
provou que tem um token.

Não há oráculo de enumeração aqui: o chamador já é o dono da conta.

## 7. O conflito com o §9 do design do Unit of Work, e a emenda

O §9 da fatia 4 diz, em negrito: **"use case que recebe o UoW não recebe
repositório direto."**

Esta fatia precisa dos dois, e a necessidade é forçada por duas regras que se
cruzam:

```
findById       precisa vir ANTES do compare
compare        é argon2, PROIBIDO dentro da transação (§8)
∴ findById precisa acontecer fora da transação
```

Não há ordem que satisfaça as duas regras com um único `uow`.

**A regra passa a proibir escrita, não acesso.** O estrago que o §9 descreve é
inteiramente de uma **escrita** fora da transação:

```ts
await this.uow(async ({ refreshTokens }) => {
  await refreshTokens.save(next)          // dentro
  await this.usersRepository.save(user)   // FORA — commita sozinho
})
```

Uma **leitura** fora não tem esse estrago. O `UPDATE ... WHERE id = $1` é
incondicional, e duas trocas simultâneas do mesmo usuário terminam com a última
vencendo — as duas conheciam a senha atual, então é empate benigno, não falha de
segurança.

**O custo, dito por inteiro:** a regra deixa de ser visível na assinatura do
construtor. Antes, "tem `uow` **e** repositório" era o sinal de alarme, legível
sem abrir o corpo. Agora é preciso ler o corpo para saber se o repositório direto
está sendo lido ou escrito. Continua invisível ao lint e ao compilador, como o §9
já registrava.

Descartado ler dentro de uma primeira transação só-leitura: obedeceria à letra
da regra e trairia o motivo dela, gastando duas transações e dois cabos do pool
por troca de senha, para uma leitura que não precisa de isolamento nenhum.

Descartado o `UPDATE` condicional (`WHERE id = $1 AND password_hash = $2`,
detectando 0 linhas como troca concorrente): fecharia o empate benigno, ao custo
de o contrato do repositório devolver um booleano e o use case ganhar um quarto
caminho de erro, para um cenário que exige o mesmo usuário trocando a senha duas
vezes no mesmo instante.

## 8. O contrato do repositório

```ts
interface IUsersRepository {
  save(user: User): Promise<void>
  findByEmail(email: Email): Promise<User | null>
  findById(id: string): Promise<User | null>

  /** Escreve APENAS `password_hash` e `updated_at`. */
  updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>
}
```

Comando com primitivos, e não `update(user)` nem `updatePassword(user)`, porque
**é o padrão declarado do módulo**:

| Escrita | Assinatura | Contrato |
|---|---|---|
| `save(user)` | entidade | `IUsersRepository` |
| `save(token)` | entidade | `IRefreshTokensRepository` |
| `markRotated(id, replacedBy, revokedAt)` | primitivos | `IRefreshTokensRepository` |
| `revoke(id, revokedAt)` | primitivos | idem |
| `revokeFamily(familyId, revokedAt)` | primitivos | idem |
| `revokeAllForUser(userId, revokedAt)` | primitivos | idem |

O corte não é estético: **insert leva entidade, `UPDATE` leva comando com
primitivos**, sem exceção. Não existe hoje um só `update` que receba entidade.

Duas consequências que decidem a favor dele:

- **A coluna errada fica inexpressável.** `updatePasswordHash` não tem acesso a
  `email`; escrever a coluna errada é erro de compilação, não item de revisão.
  Com uma assinatura que recebe a entidade, isso dependeria da disciplina do
  mapper.
- **A entidade não ganha método.** O §4.3 do handoff manda criar
  `withNewPassword`, mas **nada nesta fatia leria a `User` nova** — ela seria
  construída só para ser passada ao repositório e descartada. É o mesmo erro da
  §3.1: uma necessidade presumida que some quando se olha.

Descartado `update(user)` amplo: uma `User` carregada há alguns milissegundos
sobrescreveria tudo que outra requisição tenha mudado no meio — lost update
silencioso, que nenhuma das outras formas permite.

**A aresta aceita:** `id` e `passwordHash` são dois `string` posicionais
adjacentes, trocáveis sem erro de compilação. `markRotated(id, replacedBy,
revokedAt)` tem exatamente essa forma e foi aceita, então é o estilo da casa — e
o teste de integração do repositório assere **qual** linha mudou, não só que uma
mudou (§9).

### O adapter in-memory reidrata

`InMemoryUsersRepository` não pode mutar a `User` guardada: ela é `Object.freeze`
com campos `#` `readonly`. Ele constrói uma nova via `User.fromTrusted`, lendo os
getters da antiga e trocando o elemento do array. É scaffolding de teste, não
especificação de comportamento — a mesma ressalva que o comentário da classe já
faz sobre unicidade de e-mail.

## 9. A árvore

**Novos**

```
src/modules/auth/errors/invalid-current-password-error.ts
src/modules/auth/errors/password-unchanged-error.ts
src/modules/auth/use-cases/change-password.ts
src/modules/auth/use-cases/change-password.spec.ts
src/modules/auth/infra/http/endpoints/change-password.ts
src/modules/auth/infra/http/session-tokens.ts
tests/integration/change-password.spec.ts
```

**Alterados**

```
src/modules/auth/repositories/users-repository.ts        + updatePasswordHash
src/modules/auth/infra/drizzle/drizzle-users-repository.ts
src/modules/auth/infra/in-memory/in-memory-users-repository.ts
src/modules/auth/config.ts                               + 2 variáveis
src/modules/auth/container.ts                            + use case, + passwordChangeRateLimit
src/modules/auth/infra/http/routes.ts                    + 1 linha
src/modules/auth/infra/http/constants.ts                 + UNPROCESSABLE_ENTITY_STATUS
src/modules/auth/infra/http/refresh-cookie.ts            comentário emendado
src/modules/auth/infra/http/endpoints/login.ts           importa session-tokens
src/modules/auth/infra/http/endpoints/refresh.ts         importa session-tokens
tests/integration/drizzle-users-repository.spec.ts       + updatePasswordHash
```

**Intocados, e vale dizer:** a entidade `User`, o `LogoutAllUseCase`, e o schema
`users.ts` — inclusive o `$onUpdate`, pela §3.1.

## 10. Testes

A regra do repositório é falsificar todo teste: escrever a mutação que ele
deveria matar e confirmar que ele fica vermelho. A tabela abaixo é a lista de
mutações, não uma lista de asserções.

> **O que a falsificação encontrou, em 2026-09-03.** O teste *"senha nova fraca
> ⇒ erro antes de tocar o repositório"* **sobreviveu** à sua própria mutação: ele
> asseria apenas que argon2 e a transação não rodaram, o que continua verdadeiro
> com `Password.create` movido para depois do `findById`. Ou seja, ele não
> testava o próprio nome. Passou a espionar também a leitura. É exatamente o
> defeito que o §6 do handoff descreve tendo acontecido na fatia 8, reaparecendo
> num teste diferente.

### Unidade — `change-password.spec.ts`

| Teste | Mutação que ele mata |
|---|---|
| os dois argon2 **resolveram antes** de o `uow` ser chamado | mover `compare`/`hash` para dentro do callback — nada no compilador impede, e com o fake passthrough todo o resto continua verde |
| dentro do callback, `revokeAllForUser` chamado **antes** de `save` | inverter as duas: o token novo nasce revogado (§6.2) |
| senha atual errada ⇒ 422 **e o `uow` nunca foi chamado** | uma escrita que escape do caminho de erro |
| nova = atual ⇒ 422 **e `hash` nunca foi chamado** | mover a checagem de diferença para depois do hash |
| senha nova fraca ⇒ `InvalidPasswordError` **e `findById` nunca foi chamado** | mover `Password.create` para depois da leitura |
| `updatedAt` gravado é o do `IClock` falso, avançado | qualquer volta ao relógio do sistema |
| `findById` devolve `null` ⇒ `UserNotFoundError`, nada escrito | tratar ausência como sucesso |
| o `sub` do access token é o do principal | assinar com qualquer outro id |

A primeira linha é a lição do §15.1 da fatia 3 aplicada aqui: **assertar a
chamada, não o resultado**. Um teste que só confira "a senha mudou" continua
passando com os dois argon2 dentro da transação.

### Integração — Postgres real

- fluxo inteiro: troca responde 200 → refresh **antigo** dá 401 → refresh
  **novo** funciona. É o último que morre se a ordem da §6.2 inverter;
- outro aparelho: uma segunda família criada antes da troca está morta depois;
- login com a senha velha 401, com a nova 200;
- em `drizzle-users-repository.spec.ts`: `updatePasswordHash(id, hash, D)` com
  `D` em 2020 grava **2020**, e as outras colunas da linha não mudam. Trava o
  achado da §3.1 e impede que alguém "conserte" o repositório omitindo a coluna;
- envelope do 422 com `code: INVALID_CURRENT_PASSWORD` e `traceId` presente;
- o teto de rate limit da rota, e não o global.

## 11. Custos aceitos

### 11.1 — O atacante que trocou a senha recebe um par novo

Ele definiu a senha, então faria login de novo em qualquer desenho (§3.2).
Revogar tudo não o expulsa; expulsaria a vítima junto. A defesa real contra
sessão sequestrada é o teto da §4.5 e a notificação por e-mail, que chega com a
fatia de verificação.

### 11.2 — Duas trocas simultâneas: a última vence

Ambas conheciam a senha atual. O compare-and-swap foi considerado e descartado
(§7).

### 11.3 — O access token da vítima em outros aparelhos sobrevive até 1h

Decisão 11, inalterada por esta fatia. A revogação vale no refresh, e a latência
é o TTL do access.

### 11.4 — O teto é por IP, não por conta

O `keyGenerator` do `@fastify/rate-limit` roda em `onRequest` (medido:
`index.js:13`, `defaultHook = 'onRequest'`), que é **antes** do `preHandler` onde
o guard escreve o principal. A rota poderia pedir `hook: 'preHandler'` — o plugin
faz *append* no array, então o guard correria primeiro —, mas isso é mecanismo
lido e não exercitado, e fica para quando houver demanda.

### 11.5 — A regra do §9 fica menos visível

Ver §7. O sinal de alarme sai da assinatura e vai para o corpo.

### 11.6 — O 400 chega antes do 401 num corpo malformado

Encontrado **na execução**, não no desenho. `POST /auth/password` é a primeira
rota protegida do projeto que também tem schema de corpo — `logout-all` não tem
corpo e `me` é `GET` —, e o Fastify valida o corpo **antes** do `preHandler`.

Consequência: um chamador sem credencial nenhuma, mandando `{}`, recebe `400`
com os nomes dos campos, e o guard nunca executa. Com corpo válido ele recebe o
`401` esperado, verificado contra o servidor real.

Aceito: a forma da request é contrato publicado para os clientes desta própria
API, não segredo. Não há correção declarativa — mover a validação para depois da
autenticação significaria abrir mão do schema, que é o que produz o `details`
por campo e o documento OpenAPI. Está fixado por teste para ser decisão
registrada e não comportamento acidental.

## 12. Emendas de documentação

| Onde | O quê |
|---|---|
| `specs/2026-08-29-unit-of-work-design.md` §9 | "não recebe repositório direto" → "não faz **escrita** por repositório direto", com o motivo desta fatia |
| `ARCHITECTURE.md` §11, *Bibliotecas que falham em silêncio* | `$onUpdate` preenche a ausência, não sobrescreve a presença; o perigo real é **omitir** a coluna |
| `infra/http/refresh-cookie.ts` | *"Only `login` needs it"* deixa de ser verdade |
| `2026-09-03-handoff-password-change.md` | nota no topo apontando §3 desta spec: os §4.1, §5 e §7 dele foram medidos e refutados |
| `DECISIONS.md` 11 | emenda: a troca de senha é o consumidor da revogação, e emite par novo |

## 13. Próxima fatia

Inalterada em relação ao §8 do handoff: **verificação de e-mail**, que destrava
`emailVerifiedAt`, o gate do login, o `202` que fecha a enumeração do `register`
— e é a primeira vez que *"persista dentro, envie depois do commit"* sai do
papel. Ela também traz a notificação de "sua senha mudou" que a §11.1 deixou em
aberto.
