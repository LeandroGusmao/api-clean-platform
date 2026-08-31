# Fatia 7 — Refresh token rotativo: rotação, janela de graça e detecção de reuso

> **Status:** desenho aprovado em 2026-08-31, pronto para implementação.
> **Fatia anterior:** [`2026-08-30-transient-failures-design.md`](2026-08-30-transient-failures-design.md)
> **Consome as decisões:** 11 (auth), 12 (transporte), 13 (taxonomia), 14 (env), 15 (logging), 21 (ports), 22 (atomicidade), 23 (fatia do container), 24 (posse de tabela)
> **Emenda as decisões:** 11 (mecânica da janela de graça), 12 (`Path` do cookie e o campo de transporte), 21 (`ITokenGenerator` e `ITokenDigest` nascem), 22 (segunda razão legítima para usar o UoW)

## 1. Objetivo

Fechar a decisão 11 inteira. Hoje o `login` emite um access token de 1h e mais
nada: quando ele expira, o usuário faz login de novo. Esta fatia entrega a
sessão longa que a decisão 11 desenhou — refresh opaco de 60 dias, rotativo a
cada uso, com janela de graça de 30 segundos, detecção de reuso que revoga a
família, e revogação explícita por `logout` e `logout-all`.

É a maior fatia restante, e a própria spec do login avisa por quê: **errar a
rotação é bug de segurança sutil**. Ela não quebra ruidosamente — ela desloga
usuários ao acaso, ou deixa um token vazado valendo por dois meses.

É também a primeira consumidora do Unit of Work, publicado na fatia 4 sem
nenhum consumidor, e o primeiro endpoint do projeto que pode produzir `503`.

## 2. Escopo

### Entra

- Tabela `refresh_tokens`, entidade `RefreshToken` e
  `IRefreshTokensRepository`, com o adapter Drizzle e o dublê in-memory.
- `ITokenGenerator` e `ITokenDigest` em `shared/ports/`, com adapters em
  `infra/providers/`.
- `POST /auth/refresh` — rotação, janela de graça, detecção de reuso.
- `POST /auth/logout` — revoga a família do token apresentado.
- `POST /auth/logout-all` — revoga todas as famílias do usuário, autenticado
  por Bearer.
- `POST /auth/login` passa a emitir o par, nos dois transportes da decisão 12.
- Cookie `httpOnly` via `@fastify/cookie`, registrado como infra global.
- Duas variáveis novas em `authEnvSchema`.

### Não entra, e por quê

- **Poda de tokens expirados.** É trabalho de `cron`, e o entrypoint `cron.ts`
  não existe (decisão 10). A tabela cresce enquanto isso, o que é aceitável na
  ordem de grandeza de um boilerplate — e a fatia que criar o `cron` já nasce
  com um consumidor óbvio em vez de um `DELETE` sem agendador.
- **Troca de senha.** É o gatilho real do `logout-all`, e não existe. O
  `logout-all` entra mesmo assim porque a rota é a parte cara: a fatia de troca
  de senha vai precisar chamá-la, e criá-la agora é uma linha em `routes.ts`
  em vez de uma fatia inteira.
- **Verificação de `emailVerifiedAt` na rotação.** Nada verifica e-mail ainda,
  então o portão trancaria toda conta. Chega com a fatia que o abre — a mesma
  ressalva que o `login` já carrega.
- **Verificação de que o usuário ainda existe, na rotação.** Não há exclusão de
  usuário nem banimento. Quando houver, o lugar é aqui — a decisão 11 escolheu
  o refresh justamente como o ponto onde a revogação acontece.
- **Rate limiting no `/auth/refresh`.** Continua na lista do §13 do
  `ARCHITECTURE.md`; é infra global e não pertence a esta fatia.
- **CORS.** A decisão 12 registra a nota, mas nenhum front existe para
  configurar origem. Entra com o primeiro cliente web real.

## 3. O modelo

### 3.1 — A tabela

Exatamente as colunas que a decisão 11 lista, sem inventar nenhuma.

| Coluna | Tipo | Origem do valor |
|---|---|---|
| `id` | `uuid` PK | `IIdGenerator` |
| `user_id` | `uuid NOT NULL` | FK → `users.id`, `ON DELETE CASCADE` |
| `token_hash` | `text NOT NULL` | `ITokenDigest`, **índice único** |
| `family_id` | `uuid NOT NULL` | `IIdGenerator` no login; herdado na rotação |
| `expires_at` | `timestamptz NOT NULL` | `IClock` |
| `revoked_at` | `timestamptz NULL` | `IClock` |
| `replaced_by` | `uuid NULL` | id do sucessor, **sem FK** |
| `created_at` | `timestamptz NOT NULL` | `IClock` |

Índices em `family_id` e em `user_id`: são os `WHERE` de `revokeFamily` e
`revokeAllForUser`, e sem eles cada revogação varre a tabela.

**Nenhuma coluna usa `defaultNow()`.** A decisão 11 é explícita: o Postgres
guarda `timestamptz` em microssegundos e o `Date` do JS tem milissegundos, e a
janela de graça compara instantes. Com o `IClock` preenchendo os três, os dois
lados da comparação têm a mesma precisão. Os defaults de `users` existem como
defesa em profundidade para escrita direta; aqui não há escrita direta legítima
— um refresh token nasce de uma rotação ou não nasce.

**`replaced_by` não é decorativo, e não tem FK.** Ele é o que separa *revogado
por rotação* de *revogado por logout* — distinção que a janela de graça precisa
fazer e que `revoked_at` sozinho não faz (§4.2). FK auto-referente sairia por
dois motivos: o Drizzle exige anotação `AnyPgColumn` explícita para
self-reference, e a poda de expirados, quando chegar, passaria a ter ordem
obrigatória de deleção — deletar o antecessor antes do sucessor violaria a
constraint. É dado de diagnóstico e de máquina de estados, não de integridade
referencial.

**Nenhum nome de índice vira constante exportada.** O `users` exportou
`USERS_EMAIL_LOWER_UNIQUE_INDEX` porque o repositório **lê** o nome, para
traduzir um `23505` daquela constraint em `EmailAlreadyInUseError`. Aqui não há
tradução: colidir `token_hash` exige colidir 32 bytes de `randomBytes`, e se
isso acontecer `500` é a resposta honesta. O nome aparece exatamente uma vez, a
exceção do `CLAUDE.md` se aplica inteira, e os nomes ficam inline.

### 3.2 — A entidade

`modules/auth/entities/refresh-token.ts`, no molde do `User`: estado em campos
`#`, `Object.freeze` no construtor, `create` e `fromTrusted`, datas clonadas na
entrada e na saída.

Ela carrega os predicados, que é onde a aritmética de fronteira fica testável
sem banco:

```ts
isExpired(now: Date): boolean
isRevoked(): boolean
/** Revoked BY ROTATION, and recently enough to be a lost-response retry. */
isWithinGraceWindow(now: Date, graceWindowMs: number): boolean
```

A janela chega por parâmetro em vez de morar na entidade: o valor é
configuração (§7), e a entidade não lê configuração.

### 3.3 — As duas portas

A emenda da decisão 21 partiu o `ITokenGenerator` do sketch em dois pelo
critério de *motivos de mudar diferentes*. Esta fatia aplica o mesmo critério
mais uma vez:

```ts
// src/shared/ports/token-generator.ts        PURO
export interface ITokenGenerator {
  /** Cryptographically secure opaque value, for refresh tokens and the like. */
  opaque(bytes?: number): string
}

// src/shared/ports/token-digest.ts           PURO
export interface ITokenDigest {
  /**
   * Deterministic digest of an opaque value, so the value can be found by a
   * unique index.
   *
   * NEVER a password hash. Argon2 salts randomly, so `WHERE token_hash = ?`
   * would never match and the lookup would degenerate into scanning the table
   * running argon2 per row — a CPU denial-of-service vector on a
   * high-frequency endpoint. An opaque token already carries 256 bits of
   * entropy; what it needs is a deterministic digest, not key stretching.
   */
  hash(value: string): string
}
```

Duas portas e não uma. Gerar um segredo e indexar um segredo mudam por razões
diferentes — trocar o tamanho do token não tem nada a ver com trocar SHA-256
por SHA-3 — e, mais concretamente, **com a digest atrás de porta o use case não
escolhe algoritmo nenhum**. O aviso da decisão 11 sobre argon2 deixa de ser
comentário e vira estrutura: não existe, na camada pura, um lugar onde alguém
possa escrever `hashProvider.hash(token)` e ver aquilo compilar como
`token_hash`.

Adapters em `infra/providers/`, o endereço que a decisão 21 nomeia para port
transversal: `RandomTokenGenerator` (`randomBytes` → `base64url`) e
`Sha256TokenDigest` (`createHash('sha256')` → hex).

### 3.4 — O repositório

```ts
// src/modules/auth/repositories/refresh-tokens-repository.ts     PURO
export interface IRefreshTokensRepository {
  save(token: RefreshToken): Promise<void>

  /**
   * Finds by digest and LOCKS the row (`SELECT ... FOR UPDATE`).
   *
   * Only meaningful inside a transaction: outside one the lock is released at
   * the end of the statement, which is the same as no lock at all. §4.3
   * explains what the lock buys.
   */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>

  /** Revokes one token and points it at its successor, in a single write. */
  markRotated(id: string, replacedBy: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one family. */
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>

  /** Revokes every still-active token of one user, across every family. */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>
}
```

Comandos, e não entidade mutável com `save`. A razão é `revokeFamily`: revogar
uma família é **um** `UPDATE ... WHERE family_id = ?`, e a forma "carregue as
entidades, chame `revoke()` em cada uma, salve todas" seria N leituras e N
escritas para o mesmo efeito — mais lento, mais linhas travadas, e ainda
sujeito a perder uma linha inserida no meio do caminho.

`AuthRepos` ganha `refreshTokens` e `auth-repositories.ts` ganha uma linha. É
literalmente o custo que a fatia 4 existiu para tornar pequeno.

## 4. A rotação

### 4.1 — A máquina de estados

Tudo dentro de `uow`, na ordem:

```
SET LOCAL lock_timeout = 1s
SELECT ... WHERE token_hash = :h FOR UPDATE
   │
   ├─ não achou ─────────────────────────────────► 401 INVALID_REFRESH_TOKEN
   │
   ├─ revoked_at IS NOT NULL
   │     ├─ replaced_by IS NOT NULL
   │     │   E now - revoked_at <= graceWindow ──► JANELA DE GRAÇA
   │     │     INSERT sucessor C, mesma family_id
   │     │     A não é tocado
   │     │
   │     └─ senão ──────────────────────────────► REUSO
   │           revokeFamily(A.family_id, now)
   │           401 REFRESH_TOKEN_REUSED
   │
   ├─ expires_at <= now ─────────────────────────► 401 INVALID_REFRESH_TOKEN
   │     expirar não é ataque: NÃO revoga a família
   │
   └─ ativo ───────────────────────────────► ROTAÇÃO
         INSERT sucessor N, mesma family_id
         markRotated(A.id, N.id, now)
```

**A ordem é normativa: revogação antes de expiração.** Não é arrumação — é a
diferença entre duas respostas, nos dois sentidos:

> O cliente rotaciona 1 segundo antes de `expires_at`. A resposta se perde. Ele
> faz retry 5 segundos depois. O token antigo está agora **revogado dentro da
> janela** e **expirado ao mesmo tempo**. Com a expiração primeiro, ele leva
> 401 — precisamente o logout aleatório que a janela de graça existe para
> eliminar, ressurgindo num caso de borda estreito e infernal de reproduzir.

E o efeito colateral vai para o lado certo: um token que **foi rotacionado** e
reaparece depois de ter expirado dispara detecção de reuso, em vez de um 401
mudo. Quem legitimamente rotacionou aquele token tem o sucessor e não teria
motivo para reapresentar o antecessor.

A expiração continua sendo checada, e continua **não** revogando a família:
token que expirou sem nunca ter sido usado é um cliente que ficou offline tempo
demais, não um vazamento.

### 4.2 — Quatro propriedades que decidem correção

**`replaced_by IS NOT NULL` é a guarda da janela.** Sem ela, um token revogado
por **logout** que chegasse dentro dos 30 segundos cairia na graça e emitiria
um par novo: logout que não desloga, e a janela de graça vira um bypass da
revogação explícita. `logout` revoga sem preencher `replaced_by`, então a
coluna é exatamente o discriminante que separa os dois.

**A janela não desliza.** `revoked_at` fica onde está, então `A` morre 30
segundos depois da primeira rotação por mais retries que cheguem no intervalo.
Deslizar transformaria um cliente em loop de retry numa sessão eterna sobre um
token que já devia estar morto.

**`replaced_by` guarda a primeira substituição, não a última.** Na graça, o
token antigo não é reescrito. Sobrescrever não acrescentaria nada — o único
consumidor da coluna é a guarda acima, que só pergunta se ela é nula — e
custaria o link para o sucessor original, que é o que torna a cadeia legível
numa investigação.

**Uma família pode ter mais de um token ativo dentro da janela.** O `B` cuja
resposta se perdeu continua válido ao lado do `C` recém-emitido. Matar o irmão
daria o invariante "um ativo por família", mas ao preço de revogar, num
duplo-toque legítimo, o token que o cliente acabou de receber — reintroduzindo
pela porta dos fundos o logout aleatório que a janela existe para eliminar. A
decisão 11 diz "emite um par novo na mesma família" e não manda matar o irmão;
esta spec fica com a leitura literal e registra o custo.

### 4.3 — O que o `FOR UPDATE` compra, exatamente

Dois refreshes simultâneos com o mesmo `A`:

```
txn 1: SELECT A FOR UPDATE  ──▶ pega o lock, revoked_at IS NULL
                                rotaciona, COMMIT
txn 2: SELECT A FOR UPDATE  ──▶ espera o lock
                                em READ COMMITTED, reencontra a versão NOVA
                                revoked_at preenchido, replaced_by preenchido
                                ──▶ janela de graça, emite par novo
```

Sem o lock, os dois leem `revoked_at IS NULL` e os dois tomam o ramo de
**rotação**: o segundo pedido gasta um token já gasto sem que nada registre que
aquilo aconteceu. O índice único em `token_hash` não pega: os dois sucessores
têm hashes diferentes.

> ⚠️ **E aqui há uma consequência incômoda, descoberta ao planejar os testes:
> com a janela de graça ligada, esse defeito é INVISÍVEL pelo HTTP.** Ramo de
> rotação e ramo de graça produzem o mesmo efeito externo — 200, par novo, mesma
> família — então dois refreshes simultâneos respondem igual com e sem o lock.
> Um teste de ponta a ponta que os dispare fica verde nos dois mundos, e
> portanto **não prova o lock**.

Por isso a falsificação do `FOR UPDATE` é feita **no nível do repositório**, onde
a diferença é observável e determinística: duas transações sobre a mesma linha,
a primeira travando e atualizando, a segunda obrigada a esperar o commit e a ler
o valor **novo**. Sem `.for('update')` a segunda lê a versão antiga na hora, e o
teste fica vermelho.

O teste HTTP de concorrência continua existindo, e continua valendo — ele prova
que dois refreshes simultâneos **não** produzem falso positivo de reuso, que é
uma propriedade de produto. Só não é ele que defende o lock.

**`SET LOCAL lock_timeout`** abre a transação, numa constante nomeada do
repositório — `ROTATION_LOCK_TIMEOUT_MS = 1_000` — e não em variável de
ambiente: o valor certo decorre da forma da transação, não da topologia de
deploy, ao contrário dos cinco limites da fatia 5. O default de
conexão é 5s (fatia 5), e cinco segundos esperando a linha mais quente do
sistema são conexões do pool paradas justamente quando a contenção já indica
pressão — com `DATABASE_POOL_MAX` em 10, meia dúzia de refreshes travados
esgota a instância. `SET LOCAL` reverte no commit, então é seguro num pool.
Custa um round trip por refresh, contra uma transação que já faz três ou
quatro.

O que estoura esse timeout é `55P03`, que o runner **não** retenta por desenho
(fatia 6 §3) e converte em `TransactionConflictError` → `503` com
`Retry-After`. Esta fatia é onde esse código deixa de ser teórico.

### 4.4 — O que nasce dentro do callback, e o que nasce fora

O handoff deixou isso em aberto de propósito. A resposta:

| O quê | Onde | Por quê |
|---|---|---|
| Token opaco + digest | **dentro** | o valor que chega ao cliente é, por construção, o da linha que commitou |
| `family_id` do sucessor | dentro | é herdado da linha travada, que só existe lá |
| Assinatura do access JWT | **fora**, depois do commit | não depende da transação, só do `user_id` |
| argon2 (login) | fora, e o login nem abre transação | §8 da fatia 4 |

**Dentro, e não fora, apesar do "calcula antes" do §8 da fatia 4.** Aquela regra
existe contra rede e contra CPU pesada — um argon2 de 100ms segurando um cabo do
pool. `randomBytes(32)` é síncrono e custa microssegundos, então ela não alcança
este caso. E gerar dentro dá uma propriedade que gerar fora só dá por argumento:
como o runner pode reexecutar o callback, um token gerado fora seria reusado pela
segunda tentativa. Funciona — o `INSERT` da primeira sofreu rollback, então não há
colisão — mas a correção do valor devolvido passa a depender de um raciocínio
sobre semântica de retry, em vez de ser estrutural.

## 5. Os três use cases, e a segunda razão para usar o UoW

| Use case | Recebe `uow`? | Endpoint declara `503`? | Por quê |
|---|---|---|---|
| `RefreshTokenUseCase` | **sim** | sim | atomicidade: escreve duas vezes |
| `LogoutUseCase` | **sim** | sim | **não** por atomicidade — pelo retry |
| `LogoutAllUseCase` | **sim** | sim | idem |
| `LoginUserUseCase` | não | não | um `INSERT` só, e faz argon2 |

A decisão 22 escreveu que "o UoW é para quem precisa dele", e o exemplo era
atomicidade. Esta fatia acrescenta uma segunda razão legítima, e ela é
concreta:

> A rotação trava a linha `A` e, no ramo de reuso, atualiza a **família
> inteira**. O `logout` atualiza a família inteira direto. São conjuntos de
> linhas sobrepostos, travados em ordens diferentes — **AB-BA clássico**, e
> `40P01` é alcançável.

Fora do runner esse deadlock vira `PersistenceError` e responde **500**: um
defeito da aplicação, onde na verdade nada estava errado e repetir resolveria.
Dentro do runner ele vira retry — e o Postgres já matou uma das duas
transações justamente para a outra passar, então a vítima quase sempre passa na
segunda. Só o que sobreviver a três tentativas vira `503`.

O `login` fica de fora e ilustra a regra pelo outro lado: um `INSERT` de linha
nova não trava linha existente, e argon2 dentro de transação é exatamente o que
o §8 da fatia 4 proíbe.

**Nenhum dos três recebe repositório direto.** A regra do §9 da fatia 4 —
invisível ao lint e ao compilador — é o defeito mais provável desta fatia: um
`this.refreshTokensRepository.save(...)` dentro do callback compila, passa no
teste unitário com o dublê passthrough, e escreve fora da transação em
produção. Os três acessam tudo por `repos`.

**Dois códigos de erro, não um.** `INVALID_REFRESH_TOKEN` (desconhecido,
expirado, ausente) e `REFRESH_TOKEN_REUSED` (família revogada), ambos
`UnauthorizedError` → 401. Um código só seria mais econômico e não vazaria
nada, mas a decisão 15 usa o `code` **como a linha de log** — o use case não
loga, e o `code` semântico é o que substitui o log. Unificar apagaria do log a
única evidência de que houve detecção de reuso, que é o evento de segurança que
esta fatia inteira existe para produzir. O cliente também age diferente:
`REUSED` significa "limpe o armazenamento seguro e volte para a tela de login",
enquanto `INVALID` pode ser um token velho depois de reinstalar o app.

## 6. Transporte

### 6.1 — O campo, e por que ele existe

No `/auth/refresh` o próprio pedido diz qual transporte usar: veio cookie, ou
veio body. No `login` não há esse sinal, e é ele quem entrega o primeiro
refresh token.

```
POST /auth/login
{ "email": "...", "password": "...", "refreshTransport": "cookie" }
                                     └─ opcional, default "body"
```

| `refreshTransport` | Resposta |
|---|---|
| ausente ou `"body"` | `{ accessToken, refreshToken }` |
| `"cookie"` | `{ accessToken }` + `Set-Cookie` |

**Não é o padrão de mercado, e a escolha é consciente.** Todos os provedores da
tabela da própria decisão 11 — Firebase, Supabase, Cognito, Auth0 — devolvem o
refresh **no body, sempre**, e nunca setam cookie no endpoint de token; quando
há cookie `httpOnly` num app web deles, quem seta é um **BFF**, um backend do
próprio front. As stacks cookie-first (NextAuth, dj-rest-auth, Rails, Django)
decidem por configuração de deploy, não por pedido, porque não servem mobile
pelo mesmo endpoint.

A decisão 12 desvia disso de propósito: põe o cookie na própria API, para
servir os dois clientes com uma superfície só e colapsar CSRF em vez de
administrá-lo. O campo explícito é o preço desse desvio — configuração de
processo não serve, já que os dois clientes chegam ao mesmo processo ao mesmo
tempo. Precedente de primeira parte existe: os endpoints de Identity do ASP.NET
Core expõem `POST /login?useCookies=true`, exatamente esta chave.

**Descartado — sempre os dois, body e cookie:** o JS do SPA passaria a ler o
refresh no body, que é precisamente o que o `httpOnly` da decisão 12 existe
para impedir. Anula o desenho contra XSS em troca de um campo.

**Descartado — inferir de `Sec-Fetch-Site`/`Origin`:** detecção de browser é
frágil e falha em silêncio — um proxy que remove o header, um `fetch` de SSR
sem header, um cliente nativo que forja um. E a falha silenciosa é para o lado
errado: entrega o refresh no body para quem devia receber cookie.

**Descartado — caminho separado para o web:** schemas de resposta honestos, nada
opcional. Perdeu porque a simetria exigiria `web/refresh` e `web/logout`
também: seis rotas onde a decisão 12 previu três.

O campo ser controlado pelo cliente é inofensivo: quem escolhe já passou pelas
credenciais, e a escolha só afeta a entrega da própria sessão.

### 6.2 — A emenda ao `Path` da decisão 12

A decisão 12 fixa `Path=/auth/refresh`. Com esse path, **o browser não manda o
cookie para `/auth/logout`**, e o logout por cookie fica impossível de
implementar. A decisão foi escrita quando o logout ainda não estava sendo
desenhado.

**Emenda: `Path=/auth`.** Alcança `refresh`, `logout` e `logout-all`. O custo é
o cookie trafegar também em `login` e `register`, que o ignoram — e ele
continua `HttpOnly`, `Secure`, `SameSite=Strict`, com `headers.cookie` e
`res.headers["set-cookie"]` já no `REDACT_PATHS`. A alternativa, manter o path
estreito, significaria que o cliente web só consegue deslogar via
`logout-all`, que é semântica diferente: mataria a sessão do celular junto.

```
Set-Cookie: refresh_token=<opaco>
  HttpOnly
  Secure
  SameSite=Strict
  Path=/auth                      ← era /auth/refresh
  Max-Age=<REFRESH_TOKEN_TTL_SECONDS>
```

`Secure` fica ligado inclusive em desenvolvimento: browsers modernos tratam
`localhost` como origem segura e aceitam o cookie sobre HTTP ali, e um flag de
segurança que depende de `NODE_ENV` é exatamente o tipo de coisa que viaja para
produção com o valor errado. O `app.inject` dos testes não aplica política de
cookie nenhuma, então nada disso atrapalha a suíte.

`clearCookie` precisa repetir `Path=/auth`, ou o browser não apaga.

### 6.3 — Precedência e códigos

**Body vence o cookie quando os dois vêm.** O body é explícito; o cookie é
ambiente. A resposta segue o canal que foi usado — quem mandou body recebe body,
quem mandou cookie recebe `Set-Cookie`.

**`@fastify/cookie` entra**, em versão exata, registrado em `main/app.ts`
**antes das rotas**, junto do `registerOpenApi` e pela mesma razão de ordem.
Ele é infra global — o módulo `auth` não registra plugin de transporte.

### 6.4 — A superfície

| Rota | Credencial | Sucesso | Status declarados |
|---|---|---|---|
| `POST /auth/login` | e-mail + senha | 200 `{ accessToken, refreshToken? }` | 200, 400, 401 |
| `POST /auth/refresh` | cookie **ou** body | 200 `{ accessToken, refreshToken? }` | 200, 400, 401, **503** |
| `POST /auth/logout` | cookie **ou** body | 204 | 204, 400, 401, **503** |
| `POST /auth/logout-all` | Bearer (guard) | 204 | 204, 401, **503** |

`logout` declara 400 e `logout-all` não porque só o primeiro tem schema de
corpo: um `refreshToken` que chegue como número é rejeitado pelo Zod antes do
handler. O `logout-all` não lê corpo nenhum.

**Os primeiros `503` do projeto.** O §7 do `ARCHITECTURE.md` exige que todo
endpoint declare todo status que ele mesmo produz, e até aqui nenhum podia
produzir 503 porque nenhum usava o `uow`.

**`refreshToken` é opcional no schema de resposta.** O aviso do §7 do
`ARCHITECTURE.md` se aplica: declarar um status faz o `serializerCompiler`
validar o corpo contra o schema, e um campo novo obrigatório quebraria em
silêncio, respondendo 500 no lugar do status pretendido. Opcional cobre as duas
formas.

**`/auth/logout` responde 401 só quando não vem credencial nenhuma**, espelhando
o guard: credencial ausente é 401. Token **apresentado** — válido, desconhecido,
expirado ou já revogado — responde sempre **204**. Não há oráculo: as duas
respostas são indistinguíveis, e logout não tem nada a proteger além de ser
idempotente.

**`/auth/logout-all` sempre manda o `Set-Cookie` de expiração**, tenha ou não
vindo cookie: se veio, ele acabou de morrer no banco.

**A latência de revogação continua sendo o TTL do access (1h).** Depois de
`logout-all`, o access token já emitido segue valendo até expirar. É o
trade-off que a decisão 11 aceitou explicitamente ao manter o banco fora do
caminho autenticado, e esta fatia não o muda.

## 7. Config

Duas variáveis em `authEnvSchema` — módulo declara, boot valida (decisão 14):

| Variável | Default | Nota |
|---|---|---|
| `REFRESH_TOKEN_TTL_SECONDS` | `5184000` (60d) | alimenta `expires_at` **e** o `Max-Age` do cookie, de uma fonte só |
| `REFRESH_TOKEN_GRACE_WINDOW_SECONDS` | `30` | decisão 11 |

Ambas `.coerce.number().int().positive()`, como `ACCESS_TOKEN_TTL_SECONDS` e
pela mesma razão registrada lá: `z.coerce.number()` cru transforma valor vazio
em `0` em silêncio, e `.positive()` é o que rejeita isso. Zero não é legítimo em
nenhuma das duas — um TTL zero emite token já expirado, e uma janela zero
reintroduz o logout aleatório que a janela existe para eliminar. Segundos, e não
dias, porque é a unidade que o `Max-Age` do cookie consome direto.

`.env.example` e `TEST_ENV` ganham as duas, esta última pelas constantes
exportadas e nunca por valor literal.

## 8. Testes

### Unidade

**`entities/refresh-token.spec.ts`** — os predicados nas fronteiras, que é o que
o `IClock` existe para tornar possível: `isExpired` exatamente em `expires_at`,
um milissegundo antes e um depois; `isWithinGraceWindow` idem nos 30s; e a guarda
`replaced_by IS NULL` devolvendo `false` mesmo dentro do prazo. Mais
imutabilidade: mutar a `Date` devolvida por um getter não altera a entidade.

**`use-cases/refresh-token.spec.ts`**, contra `InMemoryRefreshTokensRepository` e
um `uow` fake passthrough:

1. rotaciona um token ativo: revoga o antigo, insere o novo na **mesma**
   família, aponta `replaced_by`
2. devolve access token novo **e** refresh token novo
3. token desconhecido → `INVALID_REFRESH_TOKEN`, e **nada** é revogado
4. token expirado e **nunca revogado** → `INVALID_REFRESH_TOKEN`, e a família
   **não** é revogada
5. token revogado por rotação, dentro da janela → par novo, família intacta
6. token revogado por rotação, **fora** da janela → família revogada,
   `REFRESH_TOKEN_REUSED`
7. token revogado por **logout** (`replaced_by` nulo), dentro da janela →
   `REFRESH_TOKEN_REUSED`, **não** graça — o teste que prova a guarda do §4.2
8. token revogado dentro da janela **e já expirado** → a graça vence, par novo —
   o teste que prova a ordem normativa do §4.1
9. token rotacionado que reaparece **depois de expirar** → `REFRESH_TOKEN_REUSED`
   e família revogada, não 401 mudo — o outro lado da mesma ordem
10. o novo `expires_at` sai do `IClock` + TTL, não de `Date.now()`
11. o digest procurado é o do token apresentado — dublê de `ITokenDigest`

**`use-cases/logout.spec.ts`** — revoga a família inteira, e não só a linha;
token desconhecido não lança; token já revogado não lança.

**`use-cases/logout-all.spec.ts`** — revoga as famílias **do usuário** e deixa
as de outro usuário intactas.

**`use-cases/login-user.spec.ts`** (tocado) — passa a emitir o par: família
nova a cada login, `expires_at` do `IClock`, e o hash persistido é o digest do
token devolvido, nunca o token.

**`infra/providers/random-token-generator.spec.ts`** — dois valores seguidos
diferem; o tamanho decodificado é o pedido; a saída é `base64url` (sem `+`, `/`
ou `=`).

**`infra/providers/sha256-token-digest.spec.ts`** — determinístico para a mesma
entrada, diferente para entradas diferentes, e **não** é o token em claro.

### Integração — `tests/integration/refresh-token.spec.ts`

O fluxo real, pelo HTTP:

1. login → refresh → o par novo funciona, o antigo não
2. o refresh antigo, **de novo em seguida**, cai na graça e devolve outro par —
   sem revogar nada
3. o refresh antigo **fora** da janela revoga a família: o token que estava
   ativo para de funcionar, e a resposta é `REFRESH_TOKEN_REUSED`
4. **concorrência** — dois `POST /auth/refresh` simultâneos com o mesmo token:
   os dois respondem 200, a família continua uma só, e a detecção de reuso
   **não** dispara. Prova a ausência de falso positivo, **não** o lock — §4.3
5. `logout` revoga a família; o refresh depois dele responde 401
6. `logout` com token desconhecido responde 204; sem credencial nenhuma, 401
7. `logout-all` mata as famílias de dois logins distintos do mesmo usuário, e
   não toca a de outro usuário
8. transporte: `refreshTransport: "cookie"` no login não devolve `refreshToken`
   no body e manda `Set-Cookie` com `HttpOnly`, `Secure`, `SameSite=Strict` e
   `Path=/auth`; o refresh subsequente funciona **só com o cookie**
9. o token em claro nunca aparece no corpo de erro nem em linha de log

### Integração — `tests/integration/drizzle-refresh-tokens-repository.spec.ts`

Além do ida-e-volta dos cinco métodos, **o teste que defende o `FOR UPDATE`**:
duas transações sobre a mesma linha, a primeira travando e marcando rotação, a
segunda obrigada a esperar o commit e a ler `revoked_at` **preenchido**. Sem
`.for('update')` ela lê `null` na hora, e o teste fica vermelho — que é a
falsificação que o teste HTTP não consegue dar (§4.3).

Também prova que `revokeFamily` **não** empurra um token já revogado para
frente: sem o `IS NULL` no `WHERE`, a janela de graça deslizaria a cada
revogação.

### Falsificação obrigatória

Três, e cada uma com o alvo nomeado — um teste que nunca ficou vermelho não
provou nada:

| Quebre | Fica vermelho em |
|---|---|
| remover `.for('update')` | o teste de duas transações do repositório |
| remover a guarda `replaced_by` de `isWithinGraceWindow` | `refuses a token revoked by LOGOUT` |
| inverter a ordem revogado/expirado no use case | `lets the grace window WIN over expiry` |

### Integração — `tests/integration/refresh-tokens-schema.spec.ts`

No molde de `users-schema.spec.ts`, e só o que **é** do schema: o índice único
em `token_hash` rejeita duplicata pelo nome da constraint; a FK de `user_id`
rejeita usuário inexistente; e `ON DELETE CASCADE` apaga os tokens ao apagar o
usuário. Nomes de constraint soletrados no teste, nunca importados do schema —
importar tornaria a asserção tautológica.

## 9. A árvore

```
src/
├── shared/ports/
│   ├── token-generator.ts                     NOVO   ITokenGenerator
│   └── token-digest.ts                        NOVO   ITokenDigest
│
├── infra/
│   ├── providers/
│   │   ├── random-token-generator.ts          NOVO
│   │   ├── random-token-generator.spec.ts     NOVO
│   │   ├── sha256-token-digest.ts             NOVO
│   │   └── sha256-token-digest.spec.ts        NOVO
│   └── config/fixtures/test-env.ts            TOCADO  duas variáveis
│
├── modules/auth/
│   ├── config.ts                              TOCADO  TTL + janela
│   ├── container.ts                           TOCADO  três use cases, dois providers
│   ├── entities/
│   │   ├── refresh-token.ts                   NOVO
│   │   └── refresh-token.spec.ts              NOVO
│   ├── errors/
│   │   ├── invalid-refresh-token-error.ts     NOVO
│   │   └── refresh-token-reused-error.ts      NOVO
│   ├── repositories/
│   │   ├── refresh-tokens-repository.ts       NOVO
│   │   └── unit-of-work.ts                    TOCADO  AuthRepos + refreshTokens
│   ├── use-cases/
│   │   ├── refresh-token.ts                   NOVO
│   │   ├── refresh-token.spec.ts              NOVO
│   │   ├── logout.ts                          NOVO
│   │   ├── logout.spec.ts                     NOVO
│   │   ├── logout-all.ts                      NOVO
│   │   ├── logout-all.spec.ts                 NOVO
│   │   ├── login-user.ts                      TOCADO  emite o par
│   │   └── login-user.spec.ts                 TOCADO
│   └── infra/
│       ├── drizzle/
│       │   ├── schema/refresh-tokens.ts       NOVO
│       │   ├── drizzle-refresh-tokens-repository.ts   NOVO
│       │   ├── refresh-token-mapper.ts        NOVO
│       │   └── auth-repositories.ts           TOCADO  uma linha
│       ├── in-memory/
│       │   └── in-memory-refresh-tokens-repository.ts NOVO
│       └── http/
│           ├── constants.ts                   TOCADO  204, 503, cookie
│           ├── refresh-cookie.ts              NOVO    ler/setar/limpar, um lugar só
│           ├── routes.ts                      TOCADO  três linhas
│           └── endpoints/
│               ├── login.ts                   TOCADO  refreshTransport
│               ├── refresh.ts                 NOVO
│               ├── logout.ts                  NOVO
│               └── logout-all.ts              NOVO
│
└── main/app.ts                                TOCADO  @fastify/cookie

.env.example                                   TOCADO  duas variáveis
package.json                                   TOCADO  @fastify/cookie, versão exata

drizzle/
└── <ts>_create_refresh_tokens_table/          NOVO    forward-only (R4)

tests/integration/
├── refresh-token.spec.ts                      NOVO
├── refresh-tokens-schema.spec.ts              NOVO
└── login.spec.ts                              TOCADO  o par na resposta
```

`refresh-cookie.ts` existe para que os atributos do cookie sejam escritos **uma
vez**: quatro endpoints o tocam, e quatro cópias de `SameSite=Strict` é como um
deles perde o `HttpOnly` numa manutenção futura.

## 10. Custos aceitos

- **A tabela cresce sem poda.** Cada refresh insere uma linha e nenhuma sai. É
  aceitável na ordem de grandeza de um boilerplate, e o gatilho para resolver é
  o entrypoint `cron.ts`, não um volume.
- **Uma família pode ter mais de um token ativo dentro da janela** (§4.2). O
  limite é quantos retries chegam em 30 segundos.
- **Um round trip a mais por refresh**, pelo `SET LOCAL lock_timeout` (§4.3).
- **`logout` e `logout-all` pagam uma transação para um `UPDATE` só.** Comprado
  deliberadamente pelo retry de deadlock (§5): a alternativa é `500` num caso
  em que nada estava errado.
- **`refreshTransport` é um campo que provedor nenhum tem** (§6.1). É o preço de
  a decisão 12 servir dois transportes de uma superfície só.
- **O cookie passa a trafegar em todo `/auth/*`** (§6.2), inclusive onde é
  ignorado.
- **A regra "quem recebe UoW não recebe repositório" agora tem três violações
  possíveis em vez de zero.** Continua sem dente no lint — é a dívida que o §4
  do `ARCHITECTURE.md` já registra, e ela acabou de ficar maior.

## 11. Emendas de documentação

- **Decisão 11** — a mecânica da janela de graça fica registrada:
  `replaced_by` é o discriminante entre rotação e logout, a janela não desliza,
  e a família pode ter mais de um ativo dentro dela.
- **Decisão 12** — `Path=/auth` no lugar de `Path=/auth/refresh`, com o motivo
  (§6.2); e o campo `refreshTransport` no login, com o registro honesto de que
  não é padrão de mercado e de por que a decisão 12 o exige (§6.1).
- **Decisão 21** — `ITokenGenerator` nasce, sem o `uuid()` do sketch original, e
  ao lado dele nasce `ITokenDigest`, pelo mesmo critério de "motivos de mudar
  diferentes" que partiu o port da primeira vez.
- **Decisão 22** — segunda razão legítima para receber o UoW: o retry de
  deadlock, não só a atomicidade (§5).
- **`ARCHITECTURE.md`** — §7 ganha os primeiros endpoints que declaram 503; a
  árvore do §2 ganha as pastas novas; e o §13 **corrige um erro que já existe**:
  ele ainda lista "Unit of Work" como inexistente, e a fatia 4 o construiu.

## 12. Próxima fatia

Com a decisão 11 fechada, os candidatos naturais são **verificação de e-mail**
(que destrava o portão `emailVerifiedAt` que o login e a rotação hoje ignoram, e
que reusa `ITokenGenerator` e `ITokenDigest` tal como estão) e **troca de
senha**, que é o gatilho real do `logout-all` que esta fatia entregou sem
consumidor.

O `cron.ts` da decisão 10 ganha aqui o primeiro trabalho concreto: podar
`refresh_tokens` expirados.
