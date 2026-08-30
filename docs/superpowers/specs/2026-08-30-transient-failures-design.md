# Fatia 6 — Falha transitória: logger standalone, retry e a sétima categoria

> **Status:** desenho aprovado em 2026-08-30, pronto para implementação.
> **Fatia anterior:** [`2026-08-30-connection-limits-design.md`](2026-08-30-connection-limits-design.md)
> **Consome as decisões:** 10 (múltiplos entrypoints), 13 (taxonomia), 15 (logging), 22 (atomicidade)
> **Emenda as decisões:** 13 (sétima categoria), 15 (logger sai do Fastify)

## 1. Objetivo

Transação aberta cria uma classe de falha que o projeto ainda não sabe nomear: a
**transitória** — a mesma operação, repetida, provavelmente passa. Deadlock é o
caso canônico, e hoje ele responderia **500**, indistinguível de um defeito da
aplicação.

Esta fatia fecha os dois anéis dessa falha:

- **O de dentro**, no servidor: o runner retenta sozinho o que o Postgres já
  desempatou, em milissegundos, sem envolver o cliente.
- **O de fora**, no cliente: o que sobreviver ao retry vira `503` com
  `Retry-After`, e o app decide se tenta de novo.

O anel de fora é o que serve worker e cron tanto quanto HTTP; o de dentro é o que
evita um round trip de 150-300ms para resolver uma disputa de milissegundos.

## 2. Escopo

### Entra

- `infra/observability/logger.ts` — o logger pino extraído do Fastify.
- Retry de `40P01` e `40001` dentro do `TransactionRunner`, com `warn` por
  tentativa.
- `TransientError` como sétima categoria em `shared/errors/app-error.ts`.
- `TransactionConflictError`, concreta, lançada pelo runner.
- `503` + `Retry-After` no error handler.
- Testes: unidade do retry, integração com **deadlock real**, e o mapeamento HTTP.

### Não entra, e por quê

- **Retry de `55P03`** — §3. Ele vira transitório, mas não é retentado.
- **`Retry-After` calculado.** Constante de 1s. Um valor derivado da carga
  exigiria medir a carga, e não há consumidor que se beneficie disso ainda.
- **Métrica de retry.** O `warn` por tentativa já é agregável. Um contador
  Prometheus implica infraestrutura de métricas, que o projeto não tem.
- **Retry configurável por ambiente.** Constantes. Três tentativas e 25ms de base
  não são valores que variem por deploy; se um dia variarem, viram env.
- **Idempotency key na superfície HTTP.** É o anel de fora do anel de fora —
  problema de API, não de transação.

## 3. Três SQLSTATEs, e por que só dois são retentados

| Código | Nome | Transitório | Retentado |
|---|---|---|---|
| `40P01` | `deadlock_detected` | sim | **sim** |
| `40001` | `serialization_failure` | sim | **sim** |
| `55P03` | `lock_not_available` | sim | **não** |

A distinção não é estilística.

**`40P01` e `40001`: o Postgres já resolveu.** Quando o deadlock é detectado, o
servidor **mata uma das transações** justamente para a outra passar. A vítima
chega ao retry com o caminho livre, e quase sempre passa na primeira nova
tentativa. É por isso que a recomendação clássica é um número *pequeno* de
tentativas: não se está chutando como num timeout de rede, está-se re-executando
depois de um desempate que já aconteceu.

**`55P03`: o detentor continua lá.** Ele só existe porque a fatia 5 ligou
`lock_timeout`, e significa "esperei 5 segundos por esta linha e desisti".
Retentar é esperar mais 5 segundos para provavelmente falhar de novo — três
tentativas segurariam uma conexão do pool por até 15 segundos, exatamente quando
a contenção já indica que o pool está sob pressão. É assim que se fabrica um
thundering herd.

Então `55P03` é classificado como transitório — o cliente recebe 503 e pode
tentar mais tarde, quando o detentor tiver soltado — mas o servidor não insiste.

## 4. O logger standalone é pré-requisito, não acessório

Hoje o logger é configurado inline dentro do `Fastify({ logger: {…} })` em
`server.ts`. Quem tem logger, portanto, é a instância HTTP.

Isso não serve a esta fatia por uma razão de arquitetura, não de conveniência: o
runner é construído no composition root, que a **decisão 10** quer compartilhado
entre `http`, `worker` e `cron`. Um worker que precisasse de logger teria de
montar o próprio pino — e duplicaria o `REDACT_PATHS`. Esse `redact` existe
exatamente para senha, hash e token não caírem em log; duplicá-lo é como o
primeiro worker vaza um hash. **A extração é o que impede a divergência.**

O esboço da decisão 15 já previa um `observability/logger.ts`; ele nunca foi
construído porque, até aqui, só o Fastify precisava logar.

**Forma:**

```ts
// src/infra/observability/logger.ts
export const REDACTED_CENSOR = '[REDACTED]'
export type AppLogger = ReturnType<typeof createLogger>

export function createLogger(env: Env, options?: { stream?: Writable }): Logger
```

`redact`, `serializers: { err: serializeError }` e o transport `pino-pretty` de
desenvolvimento mudam de `server.ts` para cá — junto com `REDACTED_CENSOR`, que
o `server.spec.ts` importa.

`server.ts` passa a receber a instância: `Fastify({ loggerInstance, genReqId,
logController })`. Verificado que a opção existe: `fastify.d.ts:142`. O
`genReqId` e o `logController` **não** se mudam — são configuração de requisição,
não de logger.

`buildApp` cria **um** logger e o entrega aos dois lados:

```ts
const logger = createLogger(env, options)
const app = buildServer(env, { ...options, logger })
const container = makeContainer(db, env, logger)
```

## 5. O retry vive no runner, e uma correção vem de graça

Não pode viver no repositório: um deadlock aborta a **transação inteira**, então
só quem é dono do `BEGIN..COMMIT` pode re-executar. O runner é esse dono.

E há uma propriedade que cai no colo por causa do formato escolhido na fatia 4.
A casca do UoW é:

```ts
runner((tx) => work(buildRepos(tx)))
```

O que o runner re-executa é essa função inteira — então `buildRepos(tx)` roda de
novo, com o `tx` **novo**, a cada tentativa. Se os repositórios fossem
construídos fora e capturados, o retry os reusaria ligados à transação morta. O
desenho de duas camadas já estava certo para isso antes de o retry existir.

**Parâmetros:** três tentativas no total, jitter total sobre base de 25ms
dobrando (`rand(0, 25)`, depois `rand(0, 50)`). O jitter evita que duas vítimas
do mesmo deadlock voltem em lockstep e colidam de novo.

**A caixa da guarda é nova a cada tentativa.** O `{ open: boolean }` do
aninhamento fecha no `finally` de cada tentativa, e a seguinte abre a sua — do
contrário a segunda tentativa veria o contexto aberto e se recusaria a si mesma.

**Logging:** um `warn` por tentativa, com o SQLSTATE e o número. O runner recebe
`Pick<AppLogger, 'warn'>` — não conhece pino, e a assinatura documenta que ele
não loga mais nada.

**Detecção:** `findDriverError(error)` de `driver-error.ts`, que já existe e já
alcança o erro do driver por baixo do embrulho do Drizzle. Nenhum código de
detecção novo.

## 6. `TransientError`, a sétima categoria

```ts
// shared/errors/app-error.ts
export abstract class TransientError extends AppError {}
```

Sétima **irmã**, estendendo `AppError` direto — o comentário do
`error-handler.ts` avisa que se uma categoria estendesse outra, a tabela
`STATUS_BY_CATEGORY` passaria a depender da ordem das linhas em silêncio.

A concreta mora ao lado do `NestedTransactionError`, no runner, que é quem a
lança. Infra lançando erro da taxonomia já tem precedente: o
`DrizzleUsersRepository` lança `EmailAlreadyInUseError`.

```ts
export class TransactionConflictError extends TransientError {
  readonly code = TRANSACTION_CONFLICT_CODE   // 'TRANSACTION_CONFLICT'
}
```

**Ela não carrega `cause`**, pela mesma razão que `PersistenceError` não carrega:
o serializer do pino concatena a cadeia de `cause` na mensagem do pai, e o erro
do driver traz os parâmetros ligados da query. Ela carrega o SQLSTATE e a
contagem de tentativas, que é o que diagnostica sem expor payload.

**No handler:** uma linha em `STATUS_BY_CATEGORY` mapeando para `503`, mais o
header. O `Retry-After` é o primeiro header que o handler define — hoje ele só
monta status e corpo —, então é um ramo pequeno e explícito, não uma coluna nova
na tabela.

## 7. A árvore

```
src/
├── shared/errors/
│   └── app-error.ts                      TOCADO  + TransientError
│
├── infra/
│   ├── observability/
│   │   └── logger.ts                     NOVO    createLogger + REDACTED_CENSOR
│   ├── database/
│   │   ├── transaction-runner.ts         TOCADO  retry + TransactionConflictError
│   │   └── transaction-runner.spec.ts    TOCADO
│   └── http/
│       ├── server.ts                     TOCADO  loggerInstance; logger sai daqui
│       ├── server.spec.ts                TOCADO  importa o censor de logger.ts
│       └── errors/
│           ├── error-handler.ts          TOCADO  503 + Retry-After
│           └── error-handler.spec.ts     TOCADO
│
└── main/
    ├── app.ts                            TOCADO  cria o logger, entrega aos dois
    └── container.ts                      TOCADO  repassa ao runner

tests/integration/
└── transaction-retry.spec.ts             NOVO    deadlock real
```

## 8. Testes

### Unidade — `transaction-runner.spec.ts`

Com um `db` dublê que lança erro sintético carregando `code`:

1. **retenta e passa** quando a primeira tentativa lança `40P01` e a segunda
   resolve — contando as execuções do `work`.
2. **retenta `40001` também**.
3. **não retenta `55P03`** — uma execução só, e o erro sai como
   `TransactionConflictError`.
4. **não retenta erro sem SQLSTATE transitório** — um erro comum sai intacto na
   primeira, com identidade preservada (`rejects.toBe`).
5. **desiste depois de três tentativas** e lança `TransactionConflictError`
   carregando a contagem.
6. **loga um `warn` por tentativa**, com o SQLSTATE — dublê de logger contando
   chamadas.
7. **a guarda de aninhamento continua valendo entre tentativas** — a caixa nova
   por tentativa; sem isso a segunda tentativa se auto-recusa.

### Integração — `transaction-retry.spec.ts`

Deadlock **real**, não simulado: duas transações travando duas linhas de `users`
com `SELECT ... FOR UPDATE` em ordem invertida, sincronizadas por barreira. O
Postgres detecta, mata uma, e a vítima retenta e passa. Asserções: as duas
promessas resolvem, e o `work` da vítima executou duas vezes.

É o teste que justifica ter escolhido "os dois anéis agora" em vez de adiar o
retry: ele tem dente sem precisar de dublê.

### Nenhum spec próprio para o logger

Deliberado. Os testes de `redact` do `server.spec.ts` já exercitam o logger pelo
caminho real — `buildServer` monta o servidor e a asserção lê a linha de log
emitida. Uma extração quebrada os derruba. Um spec dedicado repetiria a mesma
prova contra um caminho mais curto e mais fácil de acertar por engano.

### HTTP — `error-handler.spec.ts`

`TransientError` responde **503**, com `Retry-After`, e com o envelope de erro do
projeto — `code`, `message`, `traceId`.

## 9. Custos aceitos

- **Segundo lugar do projeto a conhecer `pino`.** Hoje é só `server.ts`; passa a
  ser `logger.ts`, e `server.ts` recebe a instância. É o preço de worker e cron
  compartilharem o `redact`.
- **O callback do UoW passa a poder rodar mais de uma vez.** Isso torna a regra
  do §8 da fatia 4 — nada de I/O externo dentro do callback — **load-bearing pela
  terceira vez**: antes por latência e por rollback, agora porque um e-mail enviado
  lá dentro seria enviado duas vezes. A regra não muda; o custo de quebrá-la sim.
- **Retry esconde contenção de quem não lê log.** Mitigado pelo `warn` por
  tentativa, não eliminado. Um deadlock resolvido no retry não aparece em métrica
  de erro nenhuma.
- **Três tentativas é um chute informado.** O valor certo depende de carga real,
  que ainda não existe. Constante, e explicitamente revisável quando houver.

## 10. Emendas de documentação

- **Decisão 13** — a taxonomia passa a ter **sete** categorias. O comentário do
  `error-handler.ts` ("uma centena delas ainda cai nestas seis") também muda.
- **Decisão 15** — o logger deixa de ser configuração do Fastify e vira infra
  própria, para que entrypoint sem HTTP herde `redact` e serializers.
- **`ARCHITECTURE.md`** — a seção de logging (§5) descreve `createLogger`; a
  árvore ganha `logger.ts`; a tabela de erro ganha a sétima linha.

## 11. Próxima fatia

**Fatia 7 — refresh token rotativo** (decisões 11 e 12), com tudo o que ela
precisa finalmente pronto: Unit of Work, limites de conexão, retry de deadlock e
uma categoria para falha transitória. É a fatia que fecha a decisão 11 e destrava
`logout`.
