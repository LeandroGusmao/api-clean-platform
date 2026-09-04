# Fatia 4 — Unit of Work

> **Status:** desenho aprovado em 2026-08-29, pronto para virar plano de implementação.
> **Fatia anterior:** [`2026-08-27-login-design.md`](2026-08-27-login-design.md)
> **Consome as decisões:** 22 (atomicidade), 21 (portas e providers), 15 (ALS),
> 09 (testes), 08 (container), 24 (posse de tabela)
> **Emenda as decisões:** 15, 21, 22

## 1. Objetivo

Entregar a primitiva de atomicidade da decisão 22 — um Unit of Work genérico,
transversal e provado contra Postgres real — **antes** da fatia que vai consumi-la.

A decisão 22 está fechada desde o desenho do projeto e não tem uma linha de
código. A fatia seguinte (rotação de refresh token, decisão 11) depende dela
para revogar o token antigo, inserir o novo e marcar `replaced_by` atomicamente.
Construir o UoW dentro daquela fatia significaria desenhar a primitiva no meio
do maior bloco de segurança do projeto, com pressa. Esta fatia o tira do caminho
crítico.

O UoW **vai se repetir em todo módulo**. É o critério que governa o desenho
inteiro abaixo: cada escolha foi feita pensando no segundo e no terceiro módulo,
não só em `auth`.

## 2. Escopo

### Entra

- `IUnitOfWork<TRepos>` — contrato genérico na camada pura, em `shared/ports/`.
- `TransactionRunner` — a primitiva que abre a transação, com a guarda de
  aninhamento.
- `createUnitOfWork(runner, buildRepos)` — a casca genérica que casa as duas
  metades.
- `AuthRepos` e `IAuthUnitOfWork` — a fatia do módulo `auth`.
- `authRepositories(db)` — a fábrica de repositórios do módulo, servindo tanto
  autocommit quanto transação.
- Fiação no composition root: um runner por processo.
- Teste unitário da guarda e teste de integração de commit, rollback e
  isolamento contra Postgres real.

### Não entra, e por quê

- **Nenhum use case novo.** Não existe hoje um use case que escreva em dois
  repositórios: `register-user` escreve só em `users`. O primeiro consumidor
  real é a rotação, na fatia 5.
- **`IRefreshTokensRepository`.** Nasce com a fatia que o governa. `AuthRepos`
  começa com um repositório e cresce lá — que é exatamente o movimento que este
  desenho precisa provar que é barato.
- **Migration.** Nenhuma tabela nasce aqui.
- **Endpoint.** A fatia não tem superfície HTTP.
- **Savepoint / transação aninhada de verdade.** Aninhar passa a **lançar**;
  ver §4 e §5.4. O caso legítimo de aninhamento não existe no projeto e o
  desenho o proíbe em vez de o suportar.
- **Nível de isolamento configurável** (`READ COMMITTED`, `SERIALIZABLE`). O
  default do Postgres serve a rotação, e o `db.transaction` do Drizzle aceita
  config por chamada quando isso mudar. Contrato nasce com o que tem consumidor.

## 3. O corte: uma primitiva sem consumidor

Esta fatia contraria uma regra que o §3 da fatia 3 estabeleceu — *nada pode
nascer inerte*. Vale explicitar por que a exceção é legítima aqui, para que ela
não vire precedente frouxo.

O que aquela regra rejeitou foi **superfície de produto inerte**: um login que
emitisse um refresh token que nada troca por nada é uma promessa ao cliente que
o servidor não cumpre. Uma primitiva de infra sem consumidor é outra coisa: não
há cliente para enganar, e o comportamento inteiro dela — commit, rollback,
isolamento, recusa de aninhamento — é **provado por teste contra Postgres real**
nesta mesma fatia. Ela nasce verificada, não nasce mentindo.

O risco que sobra é real e diferente: **desenhar a interface certa para um
consumidor imaginário**. A mitigação é que o consumidor não é imaginário — a
rotação está inteiramente especificada na decisão 11, e um segundo consumidor
(troca de senha, que escreve em `users` **e** revoga famílias) também. O desenho
abaixo foi conferido contra os dois, e contra uma implementação de referência que
já roda com quatro repositórios (§5).

## 4. O problema que o desenho existe para impedir

O erro que o UoW mais convida é aninhar. Ele merece explicação própria porque a
intuição errada é razoável.

### 4.1 — Transação é propriedade da conexão, não do banco

`BEGIN` é um comando enviado por **um** cabo. Tudo que passar por aquele mesmo
cabo está dentro da transação; qualquer outro cabo não sabe que ela existe. O
pool do `pg` mantém 10 cabos por padrão.

Quando o Drizzle abre uma transação, ele tira um cabo do pool e devolve um
handle grudado nele:

```js
// drizzle-orm/node-postgres/session.js:52
const session = isPool ? new NodePgSession(await this.client.connect(), ...) : this
```

### 4.2 — Por isso `uow` dentro de `uow` abre uma transação nova

O UoW é singleton no container e segura o **pool**, nunca o `tx`. Ele não tem
como saber que já existe uma transação aberta no contexto atual:

```
uow  ──segura──▶  db  (o pool)
                   │
uow(work) ────────▶│  tira o cabo #1, BEGIN
                   ├─▶ buildRepos(tx) ──▶ repositórios grudados no cabo #1
                   │
      lá dentro, uow(...) de novo
                   │   ← o uow segura o `db`, não o `tx`
                   └─▶ tira o cabo #2, BEGIN   ← transação INDEPENDENTE
```

Duas transações que não enxergam os dados não-commitados uma da outra. Daí saem
dois estragos:

**Atomicidade quebrada.** A de dentro commita sozinha. Se a de fora falhar e
fizer rollback, metade da escrita sobrevive — o defeito exato que o UoW existe
para impedir.

**Travamento que o Postgres não quebra.** Se a de fora deu `SELECT ... FOR
UPDATE` numa linha e a de dentro pede a mesma linha:

```
cabo #1: segura o lock e está esperando o JavaScript da função de dentro
cabo #2: está esperando o lock do cabo #1
```

O detector de deadlock do Postgres procura ciclos de transações esperando
**lock**. O cabo #1 não espera lock nenhum — espera um `await`. Para o banco, ele
é uma transação ociosa que por acaso segura um lock. Não há ciclo a detectar,
ninguém é abortado, e sem `statement_timeout` configurado aquilo pendura até a
conexão morrer. É a pior classe de defeito: trava, não quebra.

Isso importa concretamente na fatia 5, porque a decisão 11 exige `SELECT ... FOR
UPDATE` na linha do refresh token.

### 4.3 — Savepoint existe, mas não neste caminho

O Drizzle **suporta** aninhamento de verdade, por savepoint:

```js
// drizzle-orm/node-postgres/session.js:70-72
const savepointName = `sp${this.nestedIndex + 1}`
await tx.execute(sql.raw(`savepoint ${savepointName}`))
```

Só que isso acontece ao chamar `.transaction()` **no `tx`**. O use case recebe
`repos`, nunca o `tx`, então este desenho jamais alcança esse caminho. Suportá-lo
exigiria carregar o `tx` no contexto assíncrono — que é precisamente a
propagação implícita que a decisão 22 rejeitou.

## 5. Decisões tomadas neste brainstorming

O desenho foi conferido contra uma implementação de referência em produção
(`~/projects/byteflow`, contexto `identity`, quatro repositórios). Onde ela e o
esboço original divergiram, ela ganhou — e o porquê está registrado em cada item.

### 5.1 — Duas camadas: o runner e a casca

```
TransactionRunner                    abre a transação, commit/rollback, guarda.
  (não sabe o que é repositório)     UM por processo.
        │
        ▼
createUnitOfWork(runner, buildRepos) a casca genérica, 3 linhas
        │
        ▼
authRepositories(db)                 a fábrica do módulo
```

O esboço original juntava tudo numa classe `DrizzleUnitOfWork<TRepos>(db, bind)`.
Separar paga em dois lugares:

1. A mecânica de `BEGIN`/`COMMIT`/`ROLLBACK` **e a guarda** existem uma vez para
   o projeto inteiro. Um defeito nelas se corrige num arquivo, não em N módulos.
2. Transação **cruzando módulos** vira possível sem registro global de
   repositórios: basta fundir duas fábricas sobre o mesmo executor.

```ts
const registrationUoW = createUnitOfWork(runner, (tx) => ({
  ...authRepositories(tx),
  ...billingRepositories(tx),
}))
```

O item 2 não é hipotético: a decisão 24 proíbe FK entre módulos, mas não proíbe
escrita que atravesse dois. Com a classe única, dois UoWs seriam duas transações
— exatamente o defeito do §4.2, agora por construção.

### 5.2 — Só o `IUnitOfWork` é porta

O `TransactionRunner` é consumido **apenas por infra** (a casca). A camada pura
nunca o vê. Então:

- `shared/ports/unit-of-work.ts` — puro, transversal, prefixo `I` como todo
  contrato do projeto.
- `infra/database/transaction-runner.ts` — tipo de infra, sem prefixo `I`, pela
  mesma razão que `Database` não tem.

Isso mantém a fronteira da R6 apertada: o use case enxerga uma função que
entrega repositórios, e nada mais.

### 5.3 — Interface chamável, não objeto com `.run()`

A decisão 22 escreveu `run<T>(fn)`. Vira chamada direta:

```ts
await this.uow(async ({ refreshTokens }) => { ... })
```

O `.run()` é um único método num objeto que não tem estado nem outra
responsabilidade — o objeto é embalagem sem conteúdo. A forma chamável também é
a que compõe: `createUnitOfWork` devolve o retorno de `runner(...)` direto, sem
construir nada. Custo: uma emenda à decisão 22.

### 5.4 — A guarda de aninhamento usa `AsyncLocalStorage`

Contador de instância não resolve. O UoW é singleton e requisições concorrentes
se intercalam no mesmo processo, então um `#depth` daria falso positivo entre
requests diferentes. Detecção de aninhamento é intrinsecamente uma pergunta
sobre o **contexto assíncrono atual**, e o ALS é o mecanismo que responde isso.

```ts
const insideTransaction = new AsyncLocalStorage<{ open: boolean }>()
```

O storage carrega uma caixa mutável, não um `true` fixo, porque o contexto
aberto por `insideTransaction.run` sobrevive ao fim de `work`: qualquer recurso
assíncrono criado dentro dela — um `setTimeout`, um flush de outbox — herda o
mesmo contexto. Uma flag que nunca fecha leria esse contexto como "ainda dentro
de uma transação" para sempre, e rejeitaria esse trabalho legítimo — agendado
dentro do callback, mas executado depois do commit — com um
`NestedTransactionError` falso. A caixa é fechada (`open = false`) num
`finally` quando a transação se resolve, o que distingue esse trabalho tardio
de um aninhamento genuíno, feito enquanto a transação ainda está aberta.

**Este é o segundo uso de ALS no projeto, e a decisão 15 o aceitou como exceção
única e consciente.** A diferença que sustenta a emenda: a decisão 22 rejeitou
ALS para **propagar a transação**, porque ela sumiria da assinatura e o
repositório resolveria a conexão a partir de estado ambiente. Aqui o storage
carrega uma caixa de controle interno, os repositórios nunca o leem, e a
transação continua explícita no parâmetro `repos`. É detecção, não
propagação — e o único efeito possível dele é lançar.

O erro **não** é `AppError`, pela mesma razão que `PersistenceError` não é
([`driver-error.ts`](../../../src/infra/database/driver-error.ts)): aninhar é
defeito de programação, não uma das seis categorias semânticas da decisão 13.
Cai no ramo genérico do handler e responde 500, que é o que é.

### 5.5 — O fake não simula rollback

O esboço original propunha um fake com snapshot/restore dos repositórios
in-memory, para permitir asserção de atomicidade na suíte unitária. **Descartado.**

Um fake com snapshot é uma segunda implementação de semântica transacional. Ele
modela "restaurar o array no throw" e não modela mais nada — falha no `COMMIT`,
violação de constraint diferida, visibilidade, lock. Um teste verde contra ele
concede uma confiança que não foi inteiramente ganha, e o risco cresce à medida
que o dublê e o Postgres divergem.

A régua adotada é mais limpa e mais ensinável para um boilerplate:

> **Unidade prova orquestração. Integração prova atomicidade.**

O teste que o snapshot permitiria ("se salvar o novo falha, o antigo não fica
revogado") não se perde: ele vira teste de integração, onde a garantia é real em
vez de simulada.

Consequência de arquitetura: o fake vira uma linha.

```ts
const uow: IAuthUnitOfWork = (work) => work(repos)
```

E aí ele cai na regra que o projeto já escreveu em
[`register-user.spec.ts`](../../../src/modules/auth/use-cases/register-user.spec.ts):
*"One-method ports do not deserve their own file: an object literal here keeps
the double next to the assertions it serves, and out of `dist/`"*. Igual ao
`const clock: IClock = { now: () => NOW }`. **Não há arquivo de fake, nem pasta
`in-memory/` nova, nem contrato de dublê.**

### 5.6 — A fábrica de repositórios serve autocommit e transação

`Database` já é a união `NodePgDatabase | NodePgTransaction` — ver
[`client.ts`](../../../src/infra/database/client.ts), cujo comentário registra
que repositórios que aceitam os dois precisam dela. Nenhum repositório existente
muda.

Isso deixa a fábrica servir os dois lados com a mesma função:

```ts
authRepositories(db)   // singletons de autocommit, para o container
authRepositories(tx)   // presos à transação, para dentro do callback
```

O container passa a usá-la, o que elimina a duplicação de saber o conjunto de
repositórios do módulo em dois lugares. `auth-repositories.ts` vira **o único
arquivo que conhece o conjunto completo** — que é o que faz o crescimento de
`AuthRepos` na fatia 5 custar uma linha.

### 5.7 — O adapter mora em `infra/database/`, não em `infra/providers/`

Pela letra da decisão 21, contrato em `shared/ports/` implica implementação em
`infra/providers/`. Mas aquela regra foi escrita quando o único port transversal
era o `IClock`, e o projeto já tem precedente do contrário: `DrizzleUsersRepository`
mora em `modules/auth/infra/drizzle/`, não em `.../infra/providers/` — adapter de
banco fica em pasta de banco.

Além do precedente, cohesão: o runner precisa do tipo `Database` que o vizinho
`client.ts` exporta, e quem abrir `infra/database/` passa a ver a história
completa — conexão, erro e transação.

### 5.8 — `AuthRepos` nasce com um repositório

Um pacote de um item parece cerimônia. É deliberado: o genérico fica provado com
o conjunto que existe hoje, e a fatia 5 acrescenta `refreshTokens` a **um** tipo
e a **uma** fábrica. Se `AuthRepos` esperasse o segundo repositório para nascer,
a fatia 5 pagaria o desenho inteiro do UoW junto com o desenho da rotação.

### 5.9 — O runner é criado no composition root e o UoW é exposto sem consumidor

Um runner por processo, criado em `makeContainer` e passado a cada módulo. O
`makeAuthContainer` monta o `uow` e o publica, mesmo sem use case que o consuma
nesta fatia.

A alternativa — construir o UoW só nos testes — foi descartada porque adiaria a
primeira construção em produção para a mesma fatia em que ele é usado pela
primeira vez, que é o pior lugar para descobrir um erro de fiação. O custo é uma
chave não consumida no container por uma fatia (§11).

## 6. A árvore

```
src/
├── shared/ports/
│   ├── clock.ts
│   ├── id-generator.ts
│   └── unit-of-work.ts                   NOVO   IUnitOfWork<TRepos>
│
├── infra/database/
│   ├── client.ts                         intocado
│   ├── driver-error.ts                   intocado
│   ├── transaction-runner.ts             NOVO   transação + guarda de aninhamento
│   ├── transaction-runner.spec.ts        NOVO
│   └── unit-of-work.ts                   NOVO   createUnitOfWork
│
├── modules/auth/
│   ├── repositories/
│   │   ├── users-repository.ts           intocado
│   │   └── unit-of-work.ts               NOVO   AuthRepos + IAuthUnitOfWork
│   ├── infra/drizzle/
│   │   ├── drizzle-users-repository.ts   intocado
│   │   └── auth-repositories.ts          NOVO   authRepositories(db)
│   └── container.ts                      TOCADO usa a fábrica, recebe o runner
│
└── main/container.ts                     TOCADO cria o runner do processo

tests/integration/
└── unit-of-work.spec.ts                  NOVO   commit, rollback, isolamento
```

Quatro arquivos de produção, dois de teste, três tocados. Sem migration, sem
endpoint, sem dependência nova no `package.json`.

## 7. Os contratos

```ts
// src/shared/ports/unit-of-work.ts        PURO — o único que o use case enxerga
/**
 * Runs `work` inside a single transaction, handing it repositories bound to
 * that transaction. Commits when `work` resolves, rolls back when it throws —
 * and the throw propagates unchanged.
 *
 * `TRepos` is whatever the caller's factory produces: one module's repositories,
 * or several modules' merged onto the same transaction.
 */
export interface IUnitOfWork<TRepos> {
  <T>(work: (repos: TRepos) => Promise<T>): Promise<T>
}
```

```ts
// src/infra/database/transaction-runner.ts
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from './client.js'

/**
 * The context-free half of the Unit of Work: it knows how to open a transaction
 * and nothing about repositories. Build ONE per process, in the composition
 * root, and share it with every module's Unit of Work.
 */
export type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>

const NESTED_TRANSACTION_ERROR_NAME = 'NestedTransactionError'
const NESTED_TRANSACTION_MESSAGE =
  'a transaction is already open on this async context: open it once at the ' +
  'use case boundary and reuse the transaction-bound repositories'

/**
 * Deliberately NOT an `AppError`, for the same reason `PersistenceError` is not:
 * nesting is a programming defect, not one of the six semantic categories of
 * decision 13. It falls through to the error handler's generic branch and
 * answers 500 — which is what it is.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(NESTED_TRANSACTION_MESSAGE)
    this.name = NESTED_TRANSACTION_ERROR_NAME
  }
}

/**
 * Tracks whether the current async context already holds an open transaction.
 * Read ONLY by the guard below: repositories never touch it, and the only
 * thing a positive read can do is throw.
 *
 * The store holds a mutable box rather than a bare `true` because the context
 * entered by `insideTransaction.run` outlives the transaction: any async
 * resource created inside `work` (a `setTimeout`, a detached retry, an outbox
 * flush) inherits the same context and would otherwise read the store as
 * "still inside a transaction" forever, long after the connection returned to
 * the pool. Closing the box in `finally` — rather than never closing it —
 * means that work is allowed once the transaction has settled, while a
 * genuine nested call made DURING the transaction (still `open: true`) is
 * still blocked.
 *
 * That is what separates it from the ambient-transaction pattern decision 22
 * rejected — the transaction stays explicit in `work`'s parameter, and the
 * only thing this flag can do is throw. It is the project's second use of
 * `AsyncLocalStorage`, which decision 15 had accepted as a one-off; the
 * amendment records why detection is not propagation.
 */
const insideTransaction = new AsyncLocalStorage<{ open: boolean }>()

export function createTransactionRunner(db: Database): TransactionRunner {
  return async <T>(work: (tx: Database) => Promise<T>): Promise<T> => {
    // A second call would take ANOTHER pooled connection and open an
    // independent transaction — not a savepoint. It would commit on its own
    // while the outer one rolls back, and deadlock outright whenever the outer
    // holds a row lock the inner asks for. Postgres cannot break that one: the
    // outer transaction is not waiting on a lock, it is waiting on JavaScript.
    //
    // The read happens synchronously, before the first `await`, so it runs in
    // the CALLER's async context regardless of `createTransactionRunner`
    // itself now being `async` — the guard's semantics are unchanged. Making
    // the function `async` only changes what happens when the guard fires:
    // the `throw` below becomes a rejection of the returned promise instead of
    // a synchronous throw out of a function typed `Promise<T>`, which is what
    // let it surface as an uncaught exception in a detached caller that has no
    // enclosing `try` and no `.catch()` attached yet.
    if (insideTransaction.getStore()?.open === true) throw new NestedTransactionError()

    const state = { open: true }

    try {
      return await insideTransaction.run(state, () => db.transaction((tx) => work(tx)))
    } finally {
      state.open = false
    }
  }
}
```

```ts
// src/infra/database/unit-of-work.ts
/**
 * The generic shell: pair the context-free runner with a factory that binds
 * repositories to the transaction. Every module plugs in the same way, and the
 * transaction mechanics are never duplicated.
 */
export function createUnitOfWork<TRepos>(
  runner: TransactionRunner,
  buildRepos: (db: Database) => TRepos,
): IUnitOfWork<TRepos> {
  return <T>(work: (repos: TRepos) => Promise<T>): Promise<T> =>
    runner((tx) => work(buildRepos(tx)))
}
```

```ts
// src/modules/auth/repositories/unit-of-work.ts        PURO
/**
 * The module's repositories, every one bound to the SAME open transaction.
 * Grows with the module: the refresh token slice adds `refreshTokens` here and
 * in `auth-repositories.ts`, and nothing else changes.
 */
export interface AuthRepos {
  users: IUsersRepository
}

export type IAuthUnitOfWork = IUnitOfWork<AuthRepos>
```

```ts
// src/modules/auth/infra/drizzle/auth-repositories.ts
/**
 * The only place that knows the module's full repository set. Serves both
 * sides: pass the pool handle for autocommit singletons, or a transaction
 * handle for repositories bound to it — `Database` covers both.
 */
export function authRepositories(db: Database): AuthRepos {
  return { users: new DrizzleUsersRepository(db) }
}
```

## 8. O que não pode entrar no callback

Regra de uso que a fatia 5 vai precisar, e que vale documentar na porta agora:

| Fora do callback | Por quê |
|---|---|
| **I/O externo** — e-mail, HTTP | Segura a transação aberta pelo tempo da rede. Persista dentro, envie **depois** do commit. |
| **CPU pesada** — argon2 | Mesma razão: calcule antes e passe o resultado pronto. Um hash de ~100ms com a transação aberta é um cabo do pool parado. |
| **Escrita que precisa sobreviver à falha** — contador de brute force | O rollback apagaria justamente o registro que existe para lembrar da falha. É autocommit por desenho. |
| **Outro `uow(...)`** | §4.2 — lança. |

## 9. A regra do repositório direto

O erro mais provável na prática não é aninhar:

```ts
constructor(
  private readonly uow: IAuthUnitOfWork,
  private readonly usersRepository: IUsersRepository,   // singleton, autocommit
) {}

await this.uow(async ({ refreshTokens }) => {
  await refreshTokens.save(next)            // dentro da transação
  await this.usersRepository.save(user)     // FORA — commita sozinho
})
```

Compila, passa com o fake passthrough, e quebra a atomicidade em produção.

**Regra: use case que recebe o UoW não faz ESCRITA por repositório direto.**
Ele escreve tudo pelo `repos` do callback. É invisível ao lint e ao compilador,
então vive como regra escrita na porta e no `ARCHITECTURE.md` — e é mais um item
na dívida que o §4 do `ARCHITECTURE.md` já registra.

> **Emendada em 2026-09-03, pela fatia 9.** A regra original proibia *receber* o
> repositório, e a troca de senha não consegue obedecê-la: o `compare` do argon2
> precisa do hash guardado, então a leitura tem de vir antes dele — e o §8
> proíbe argon2 dentro da transação. Não existe ordem que satisfaça as duas
> regras com um único `uow`.
>
> O estrago que este parágrafo descreve é inteiramente de uma **escrita** fora
> da transação, que commita sozinha e quebra a atomicidade. Uma **leitura** fora
> não tem esse estrago: o `UPDATE ... WHERE id` da fatia 9 é incondicional, e
> duas trocas simultâneas do mesmo usuário terminam com a última vencendo — as
> duas conheciam a senha atual.
>
> **E o custo tem conserto, encontrado na revisão da própria fatia 9.** A
> objeção original era que a regra deixaria de ser visível na assinatura do
> construtor. Não deixa, se o parâmetro for declarado no tamanho do uso:
>
> ```ts
> private readonly usersRepository: Pick<IUsersRepository, 'findById'>,
> ```
>
> Com isso, `usersRepository.updatePasswordHash(...)` fora da transação é **erro
> de compilação**, não comentário de revisão — medido. É o mesmo movimento do
> `RateLimitEnv = Pick<Env, …>` da decisão 23, e o mesmo raciocínio que escolheu
> `updatePasswordHash` em vez de um `update(user)` amplo.
>
> **A regra passa a ter dente:** use case que recebe o UoW declara o repositório
> direto por `Pick`, com os métodos de leitura que realmente usa.

## 10. Achados empíricos

Verificados lendo `drizzle-orm@1.0.0-rc.4`, não presumidos.

### O erro sai intacto, e o retorno passa direto

```js
// node-postgres/session.js:55-61
try {
  const result = await transaction(tx)
  await tx.execute(sql`commit`)
  return result
} catch (error) {
  await tx.execute(sql`rollback`)
  throw error
}
```

`EmailAlreadyInUseError` lançado lá dentro chega ao error handler como ele
mesmo, com o 409 do envelope do projeto — o UoW não interfere na taxonomia da
decisão 13. E `run<T>` é transparente: a rotação vai devolver o par novo por ali.

### Transação de topo pega uma conexão nova do pool

```js
// node-postgres/session.js:51-52
const isPool = this.client instanceof Pool || ...
const session = isPool ? new NodePgSession(await this.client.connect(), ...) : this
```

É a linha que torna o aninhamento do §4.2 uma transação independente em vez de
um savepoint, e a que justifica a guarda inteira.

### Savepoint existe, mas só a partir do `tx`

`NodePgTransaction.transaction()` (linhas 70-72) emite `savepoint sp1`. Esse
caminho é inalcançável neste desenho, porque o `tx` nunca sai do runner.

### Se o `ROLLBACK` falhar, ele substitui o erro original

No `catch` acima, `await tx.execute(sql`rollback`)` roda **antes** do
`throw error`. Se a conexão morreu, o erro do rollback é o que sobe e o original
se perde. Borda rara, sem código para contornar — vale só o comentário, para que
um diagnóstico futuro não perca tempo procurando o erro que não chegou ao log.

### `**/in-memory/**` está fora do build, em qualquer lugar

O `exclude` do [`tsconfig.build.json`](../../../tsconfig.build.json) usa glob,
não caminho. Levantado enquanto o desenho ainda previa um fake em arquivo; ficou
sem uso quando o §5.5 eliminou o arquivo, mas vale registrado: a convenção
generaliza para qualquer módulo futuro sem tocar no build.

### `BEGIN` roda fora do `try…finally` que libera o cliente

```js
// node-postgres/session.js:54-62
await tx.execute(sql`begin${...}`)
try {
  const result = await transaction(tx)
  await tx.execute(sql`commit`)
  return result
} catch (error) {
  await tx.execute(sql`rollback`)
  throw error
} finally {
  if (isPool) session.client.release()
}
```

O `BEGIN` (linha 54) roda **antes** do `try` (linha 55), e é o `finally` desse
`try` (linha 62) que libera o cliente de volta ao pool. Se o `BEGIN` falhar numa
conexão que morreu entre o checkout do pool e o `BEGIN` — a janela é estreita,
mas existe — aquele cliente nunca é liberado. Borda rara, sem workaround local;
registrado porque esta fatia é a que torna `db.transaction` alcançável pela
primeira vez.

### `client.ts` não limita `max`, `statement_timeout` nem `idle_in_transaction_session_timeout`

[`src/infra/database/client.ts`](../../../src/infra/database/client.ts) só
configura `connectionTimeoutMillis` no `Pool`. Enquanto só havia autocommit, um
`statement` preso segurava no máximo uma conexão por request. Com transação em
jogo, um callback pendurado — o cenário do §4.2, uma transação que não trava
mas também nunca solta — segura uma conexão indefinidamente, e sem
`statement_timeout` nem `idle_in_transaction_session_timeout` o Postgres não a
derruba sozinho. Não corrigido nesta fatia; registrado para que a omissão seja
uma decisão deliberada, não um esquecimento.

## 11. Custos aceitos

### 11.1 — Uma chave não consumida no container por uma fatia

`makeAuthContainer` publica `uow` e nenhum use case o chama até a fatia 5.
Aceito em §5.9: a alternativa era descobrir erro de fiação dentro da fatia da
rotação.

### 11.2 — Segundo ponto de contexto implícito no projeto

O ALS da guarda. A decisão 15 aceitou o primeiro como exceção única; este é o
segundo. Mitigado por escopo — carrega uma caixa de controle interno, é lida
num único `if`, e nenhum repositório a alcança — mas é honesto registrar que a
exceção deixou de ser única.

### 11.3 — O teste unitário do runner precisa de um dublê com cast

`Database` é o tipo completo do Drizzle e o runner só chama `.transaction`. O
dublê do spec é um literal com esse único método, convertido via `as unknown as
Database`. Confinado a uma linha, num arquivo que nunca chega ao `dist/`.

### 11.4 — A regra do §9 não tem dente no lint

Como a R7 e a fronteira de import, ela depende de revisão humana.

## 12. Testes

### Unitário — `src/infra/database/transaction-runner.spec.ts`

Roda sem Postgres, com um dublê de `Database` cujo `transaction` apenas executa
o callback.

1. **executa o work e devolve o que ele devolve** — a transparência do retorno.
2. **propaga o erro do work sem embrulhar** — `rejects.toBe(erro)`, identidade,
   não tipo.
3. **lança `NestedTransactionError` quando um runner é chamado dentro de outro** —
   a guarda, no caminho direto.
4. **lança também quando o aninhamento vem de um colaborador**, e não do próprio
   callback — prova que a detecção é por contexto assíncrono, e não por
   inspeção da pilha de chamadas.
5. **duas execuções sequenciais não disparam a guarda** — o contexto é
   desmontado ao fim de cada uma. Sem este teste, um ALS mal escrito passa nos
   quatro anteriores e trava a segunda requisição de cada processo.
6. **duas execuções que se sobrepõem não disparam a guarda** — a segunda
   começa antes de a primeira terminar, e ambas resolvem. É o teste que mata o
   contador de instância que o §5.4 rejeita: um `#depth` veria duas requisições
   concorrentes pelo mesmo runner singleton como aninhamento, porque conta
   execuções em voo em vez de perguntar pelo contexto assíncrono atual.
7. **trabalho agendado dentro do callback, mas executado depois do commit, não
   dispara a guarda** — um `setTimeout` desanexado, criado dentro de `work`,
   chama o runner de novo depois que a transação já committou. É o teste que
   reproduz o falso positivo corrigido no commit `bdaf517`: um storage que
   carrega um `true` fixo e nunca fecha leria esse contexto como "ainda dentro
   de uma transação" para sempre, e rejeitaria essa chamada legítima com um
   `NestedTransactionError` — de dentro de uma função tipada `Promise<T>`, o
   que a fazia escapar como `uncaughtException` num chamador desanexado.

### Integração — `tests/integration/unit-of-work.spec.ts`

Postgres real, `truncate` entre casos, como as demais suítes de integração.

1. **commita as escritas quando o work resolve** — lido de volta por um
   repositório de autocommit, fora do UoW.
2. **desfaz TODAS as escritas quando o work lança** — duas escritas na mesma
   transação, falha depois da segunda, e ambas somem. É o teste que o §5.5 tirou
   da suíte unitária e trouxe para cá, e é o que prova a atomicidade de verdade.
3. **escrita não commitada é invisível para leitura de fora** — lê pelo handle de
   autocommit **durante** o callback e não encontra nada. Prova que os
   repositórios do callback estão presos à transação, e não ao pool.
4. **o erro de domínio atravessa o rollback intacto** — `EmailAlreadyInUseError`
   lançado por `users.save` dentro do UoW sai como ele mesmo, e a escrita
   anterior do mesmo callback não sobrevive.

Os testes 2 e 3 pegam, os dois, um `buildRepos` que ignorasse o `tx` e
escrevesse pelo pool — o 2 porque a escrita sobreviveria ao rollback, o 3 porque
ela ficaria visível de fora antes do commit. O 3 existe além disso para fixar o
**isolamento em si**: é dele que a rotação da decisão 11 depende quando segura
uma linha com `SELECT ... FOR UPDATE` e conta que ninguém leia o estado
intermediário.

**Não testado:** o travamento do §4.2 contra Postgres real. Reproduzi-lo exigiria
`statement_timeout` e um teste que espera um impasse acontecer; a guarda torna o
caminho inalcançável, e é a guarda que os testes unitários 3, 4 e 5 cobrem.

## 13. Emendas de documentação

- **Decisão 15** — nota de emenda: o ALS deixa de ser uso único. Registrar o
  segundo, com o argumento de detecção vs. propagação (§5.4).
- **Decisão 21** — nota de emenda: adapter de banco vai para `infra/database/`,
  não `infra/providers/`, com o precedente do `DrizzleUsersRepository` (§5.7).
- **Decisão 22** — nota de emenda: o contrato nasce genérico em `shared/ports/`,
  em duas camadas, com interface chamável em vez de `.run()`, e com guarda de
  aninhamento (§5.1, §5.3, §5.4).
- **`ARCHITECTURE.md`** — a árvore ganha os arquivos novos; a seção de fronteira
  ganha a regra do §9 e a tabela do §8.
- **`DECISIONS.md` §6** — nada a fechar aqui; a atomicidade não era decisão em
  aberto, era decisão fechada sem código.

## 14. Próxima fatia

**Fatia 5 — refresh token rotativo** (decisões 11 e 12), agora com a primitiva
pronta. O que ela acrescenta a esta fatia: `refreshTokens` em `AuthRepos` e em
`authRepositories`, e o primeiro consumidor real do `uow` — a rotação com janela
de graça, detecção de reuso e revogação de família, sob `SELECT ... FOR UPDATE`.
