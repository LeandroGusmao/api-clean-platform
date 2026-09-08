# Fatia 13 — Poda de tokens expirados (`cron.ts`): design

> Escrito em 2026-09-07, ao fim da fatia 12. Contexto de entrada:
> [`2026-09-07-handoff-password-recovery.md`](../2026-09-07-handoff-password-recovery.md) §8.
> Primeira dívida de manutenção do `auth` a virar fatia: três tabelas crescem
> sem teto desde as fatias 4, 11 e 12.
>
> **Emendado em 2026-09-07**, depois da implementação e antes do merge: a §3.2
> descartava a seleção de alvo por argv, e passou a adotá-la com nome
> qualificado (`módulo:job`). O motivo não é cadência — é que o `cron.ts` é um
> entrypoint **global**, e sem seleção um módulo dita a cadência de todos os
> outros. Ver §3.2 e §5.1.

## 1. O que esta fatia entrega

Três coisas, nesta ordem de importância:

- **O entrypoint `main/cron.ts`** que a decisão 10 reservou e nunca existiu —
  processo **one-shot**: sobe, roda os jobs de manutenção, loga o resultado de
  cada um, `exit 0` se todos passaram e `exit 1` se algum lançou. Quem o agenda
  é a plataforma (Kubernetes `CronJob`, `cron` do SO, Cloud Scheduler), nunca o
  processo.
- **Um registry de jobs por módulo.** Cada módulo publica `jobs: CronJob[]` na
  sua fatia do container; `cron.ts` concatena as listas e roda tudo. Módulo novo
  com job novo não toca `cron.ts`.
- **A poda em si:** três use-cases puros, um por tabela, que apagam linhas
  expiradas há mais de uma **janela de retenção** configurável —
  `refresh_tokens`, `pending_registrations` e `password_reset_tokens`.

Depois desta fatia o `cron.ts` existe com um consumidor real, e o outbox
transacional (§8 do handoff) fica destravado: ele é mais um `CronJob`.

## 2. O buraco que fecha

Três tabelas só crescem:

| Tabela | Desde | Por quê nada apaga |
|---|---|---|
| `refresh_tokens` | fatia 4 | cada refresh insere uma linha; rotação e logout marcam `revoked_at`, nunca deletam. A fatia 9 acelerou: toda troca de senha revoga N e insere 1. |
| `pending_registrations` | fatia 11 | a poda oportunista (`deleteExpiredByEmail`) só limpa endereços que veem tráfego novo; um cadastro abandonado fica para sempre. |
| `password_reset_tokens` | fatia 12 | `ON CONFLICT (user_id)` sobrepõe a linha viva de um endereço, mas nada varre as linhas de contas que nunca mais pedem reset. |

Nenhuma delas é falha de segurança — é volume que só encarece a cada fatia. O
gatilho para resolver agora, e não depois, é que **o mesmo entrypoint destrava o
outbox**, e o custo do entrypoint é pago uma vez.

## 3. Decisões tomadas no brainstorming

### 3.1 — Modelo de execução: one-shot + scheduler externo

`cron.ts` roda uma vez e sai. O agendamento vive na plataforma.

**Por quê:** é o padrão de deploy conteinerizado (k8s `CronJob`, ECS Scheduled
Task, Cloud Run Jobs, Heroku Scheduler), e encaixa com a decisão 16 — Docker só
para infra, aplicação roda como processo. O scheduler da plataforma já entrega
retry, histórico de execução, alerting e timezone; um agendador in-process
reimplementaria tudo isso pior, e dispararia N vezes sob réplicas sem um lock.

**Descartado — processo longo com `node-cron`/`setInterval`:** auto-contido e
roda igual em dev sem infra externa. Perde por trazer dependência nova, um
processo a mais para manter no ar, e o problema de multi-réplica. É o padrão de
monólito pequeno sem orquestrador, não de um boilerplate que "não sabe onde vai
rodar".

**Descartado — `pg_cron`:** o agendamento e o `DELETE` viveriam no Postgres.
Contradiz a decisão 10 (que previu `cron.ts`), exige extensão no banco, e tira a
poda do código versionado e testável em TS.

**Custo aceito:** em `pnpm dev` não há scheduler. A poda só roda quando invocada
à mão (`node --conditions=development --import tsx src/main/cron.ts`) ou em CI.
Poda é manutenção, não corretude — aceitável.

### 3.2 — Registry de jobs por módulo

O container de cada módulo expõe `jobs: CronJob[]`. `cron.ts` itera os módulos e
roda cada job, logando nome + duração + métricas por job.

**Por quê:** coerente com o boilerplate — "módulo novo = registra job novo,
`cron.ts` não muda". É acesso a propriedade da fatia injetada do container
(`container.auth.jobs`), o mesmo mecanismo de `verifyAccessToken`: nenhum import
entre módulos, nada que o lint de fronteira precise excetuar.

**Descartado — método único `container.auth.pruneExpired()`:** `cron.ts` chamaria
uma linha e pronto. Perde porque não generaliza: o segundo módulo com job, ou o
job de dispatch do outbox, força o formato de lista de qualquer jeito — melhor
nascer com ele.

**Adotado (emenda) — alvo por argv, qualificado pelo módulo.**
`node dist/main/cron.js [módulo | módulo:job]`; sem argumento roda tudo. O
descarte original dizia "se algum app precisar de cadências diferentes, o
scheduler filtra depois" — e isso não se sustenta: **o `cron.ts` é global**. Com
um segundo módulo publicando jobs, uma invocação única obriga `billing` a rodar
na cadência de `auth`, um job lento atrasa a manutenção de um módulo que não tem
relação com ele, e o exit code vira um bit para todos.

A qualificação (`auth:prune-expired-refresh-tokens`) é feita pelo `run-cron.ts`
ao concatenar as listas, não pelos módulos: no módulo o prefixo seria convenção
esquecível e a colisão entre módulos voltaria; no ponto de concatenação é
estrutural.

**Custo aceito (era o motivo do descarte):** agendar por job significa N entradas
no scheduler, cada uma documentada pelo app derivado. E "sem argumento roda
tudo" convive com entradas por job — se as duas coisas existirem, as tabelas são
varridas duas vezes (idempotente, mas confuso no log). Produção nomeia o alvo.

**Descartado — variável de ambiente** (`CRON_JOB=… node cron.js`): menos visível
no `ps` e nos logs do ECS, e viraria mais uma chave no schema de config para não
violar R6.

**Descartado — multi-seleção** (`cron.js a b`): precisa de dois, roda duas vezes.
Argumento extra é recusado, não ignorado.

### 3.3 — Camada da poda: use-case puro por tabela

`PruneExpiredRefreshTokensUseCase`, `PruneExpiredPendingRegistrationsUseCase`,
`PruneExpiredPasswordResetTokensUseCase`. Cada um recebe o contrato do repo +
`IClock` + a janela de retenção em ms; calcula o cutoff; chama
`repo.deleteExpiredBefore(cutoff)`; devolve `{ rowsDeleted }`.

**Por quê:** idêntico em forma ao resto do módulo, testável com repo in-memory +
fake clock. A aritmética `now − retention` é lógica de domínio e fica no
use-case, fora do composition root.

**Descartado — um use-case para as três:** um arquivo, um job, devolvendo
`{ refreshTokens, pendingRegistrations, passwordResetTokens }`. Perde por acoplar
o use-case a três contratos e impedir cadências separadas por tabela.

**Descartado — só método de repo + thunk no `container.ts`:** menos arquivos, mas
a aritmética de cutoff cairia no composition root, não-testável isolada, e
destoando dos outros use-cases.

### 3.4 — Critério de deleção: janela de retenção por tabela

`DELETE ... WHERE expires_at <= $cutoff`, com `cutoff = now − retention` e uma
retenção própria por tabela, cada uma env var do módulo `auth`.

**Por quê a retenção, e não deletar no instante da expiração:** os três schemas
já carregam `created_at` imutável "para ordenação de poda e auditoria". Uma linha
morta continua investigável por uma janela quando um bug de sessão/reset acabou
de acontecer.

**Por quê retenção por tabela, e não uma global:** sete dias de tokens de reset
mortos é muito mais lixo do que os 15–60 min de TTL justificam; a janela de
`refresh_tokens` quer ser bem maior. Três números, três env vars.

**Por quê só `expires_at`, sem tocar `revoked_at`/`consumed_at`:** um predicado
único, simétrico, sobre a coluna `NOT NULL` que as três tabelas têm. Qualquer
leitor entende "expirado há mais de uma retenção".

**Custo aceito:** um `refresh_token` revogado cedo (logout, troca de senha) com
`expires_at` ainda no futuro fica até `expires_at + retention` — teto ~60 d + a
janela. É limitado pelo TTL, e o `replaced_by` sem FK (decisão 11) garante que um
`DELETE` sem ordem de deleção funciona. A alternativa
(`COALESCE(revoked_at, expires_at) <= cutoff`, e o equivalente com `consumed_at`)
varreria mais cedo ao custo de um predicado que o leitor precisa destrinchar.
Simplicidade ganha; fica registrado.

### 3.5 — Fora de escopo: outbox transacional

Esta fatia entrega o entrypoint, o registry e a poda. O outbox vira fatia
própria, reusando o registry.

**Por quê:** o §5.3 da fatia 10 adiou o outbox de propósito — ele põe o corpo do
e-mail (com o código de verificação) em texto claro **em repouso no banco** até o
dispatch, e o modo de falha que ele resolve (crash entre `COMMIT` e `send`) tem
conserto barato via reenvio. Nada disso mudou. Emparelhá-lo aqui só porque os
dois querem um `cron.ts` dobraria a fatia e reabriria uma decisão fechada.

## 4. O modelo

### 4.1 — `CronJob` (puro, transversal)

```ts
// src/shared/ports/cron-job.ts
export interface CronJob {
  /** Stable id the scheduler and the run log key on. kebab-case. */
  readonly name: string
  /**
   * Structured metrics merged into the run log line. A prune job returns
   * `{ rowsDeleted }`; a future outbox-dispatch job returns
   * `{ dispatched, failed }`. The runner does not read the shape — it spreads
   * it into the log.
   */
  run(): Promise<Record<string, number>>
}
```

Mora em `shared/ports/` junto de `IClock` e `ITokenGenerator`: contrato
transversal, sem dono de módulo, sem saber de poda.

### 4.2 — Os três use-cases

Forma idêntica; muda o contrato injetado e o `const` do nome.

```ts
// src/modules/auth/use-cases/prune-expired-refresh-tokens.ts
export const PRUNE_EXPIRED_REFRESH_TOKENS_JOB = 'prune-expired-refresh-tokens'

export class PruneExpiredRefreshTokensUseCase {
  constructor(
    private readonly repo: IRefreshTokensRepository,
    private readonly clock: IClock,
    private readonly retentionMs: number,
  ) {}

  async execute(): Promise<{ rowsDeleted: number }> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionMs)
    const rowsDeleted = await this.repo.deleteExpiredBefore(cutoff)
    return { rowsDeleted }
  }
}
```

- Sem DTO de entrada — comando sem argumento.
- `retentionMs` já convertido: o `container.ts` faz
  `SECONDS * MILLISECONDS_PER_SECOND` antes de passar, como já faz com os
  cooldowns.
- O `const` do nome mora aqui porque o `cron.spec.ts` casa o log contra ele —
  deixa de "aparecer exatamente uma vez", então vira constante (regra do
  `CLAUDE.md`).
- Os outros dois: `PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB` e
  `PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB`, com `IPendingRegistrationsRepository`
  e `IPasswordResetTokensRepository`.

### 4.3 — O método novo nos três contratos

```ts
/**
 * Full sweep for the cron. Deletes every row whose `expires_at` is at or before
 * `cutoff` — the use case passes `clock.now() - retention`, so a dead row
 * lingers one retention window and stays available for a post-mortem. Returns
 * the deleted-row count, for the run log.
 *
 * A plain unconditional `DELETE`: no transaction, no lock, no ordering. The
 * three tables have no cross-table invariant, and `replaced_by` carries no FK
 * (decision 11) precisely so a chain need not be deleted in order.
 */
deleteExpiredBefore(cutoff: Date): Promise<number>
```

Adicionado a `refresh-tokens-repository.ts`,
`pending-registrations-repository.ts` e `password-reset-tokens-repository.ts`.

### 4.4 — As seis implementações

**Drizzle** (`infra/drizzle/*-repository.ts`), as três iguais a menos da tabela:

```ts
async deleteExpiredBefore(cutoff: Date): Promise<number> {
  const result = await this.db
    .delete(refreshTokens)
    .where(lte(refreshTokens.expiresAt, cutoff))
  return result.rowCount ?? NO_ROW_AFFECTED
}
```

`result.rowCount ?? NO_ROW_AFFECTED` é o padrão que `issueOrRefresh` e `consume`
do módulo já usam — o tipo do `node-postgres` é `number | null`, e `null` conta
como "nada apagado". `refresh-tokens` ganha o `const NO_ROW_AFFECTED = 0` que as
outras duas já têm.

**In-memory** (`infra/in-memory/*-repository.ts`), sobre o array que cada uma já
mantém:

```ts
async deleteExpiredBefore(cutoff: Date): Promise<number> {
  const before = this.tokens.length
  const kept = this.tokens.filter((t) => t.expiresAt > cutoff)
  this.tokens.length = 0
  this.tokens.push(...kept)
  return before - kept.length
}
```

Fronteira `<=`: `expiresAt > cutoff` sobrevive, `expiresAt === cutoff` é apagado —
casa com o `lte` do Drizzle.

### 4.5 — `container.ts` do `auth`

Monta os três use-cases (repos já vêm de `authRepositories(db)`, `clock` já
existe) e adiciona **um** campo ao retorno:

```ts
const pruneExpiredRefreshTokens = new PruneExpiredRefreshTokensUseCase(
  refreshTokensRepository,
  clock,
  config.REFRESH_TOKEN_PRUNE_RETENTION_SECONDS * MILLISECONDS_PER_SECOND,
)
// ...os outros dois, iguais...

const jobs: CronJob[] = [
  { name: PRUNE_EXPIRED_REFRESH_TOKENS_JOB,        run: () => pruneExpiredRefreshTokens.execute() },
  { name: PRUNE_EXPIRED_PENDING_REGISTRATIONS_JOB, run: () => pruneExpiredPendingRegistrations.execute() },
  { name: PRUNE_EXPIRED_PASSWORD_RESET_TOKENS_JOB, run: () => pruneExpiredPasswordResetTokens.execute() },
]

return { /* ...tudo que já retorna... */, jobs }
```

`{ rowsDeleted: number }` satisfaz `Record<string, number>` — sem adaptador.

## 5. O entrypoint

### 5.1 — `main/run-cron.ts`, a função testável

Cinco funções puras mais `runCron`, que é a única que toca o mundo:

| Export | O que faz |
|---|---|
| `qualify(módulo, jobs)` | prefixa `módulo:` em cada job, no ponto da concatenação |
| `jobArgFrom(argv)` | lê o alvo opcional de `process.argv`; arg extra → lança |
| `selectJobs(jobs, alvo?)` | sem alvo → todos; `auth` → o módulo; `auth:x` → um; nada casou → lança |
| `runJobs(jobs)` | o laço: série, isola job que lança, devolve `JobOutcome[]` |
| `cronExitCode(outcomes)` | `0` / `1` sobre a lista |
| `runCron(env, logger, alvo?)` | abre pool, monta o grafo, `qualify` → `selectJobs` → `runJobs`, fecha o pool |

`CronInvocationError` acompanha: é o tipo que faz `cron.ts` responder `exit 2`
para alvo inválido e manter `exit 1` para tudo o mais que pode falhar no
caminho — um banco que recusa conexão não é task definition quebrada.

Separar as puras do `runCron` é o que torna a ordem, "um job que lança não
derruba os outros", a seleção e o exit code testáveis **sem banco** — `runCron`
lê `container.auth.jobs` e não aceita job falso injetado.

`qualify` e `selectJobs` moram no mesmo arquivo de propósito: são as duas
metades de um formato — uma escreve `módulo:job`, a outra faz o parse. Separadas,
o `JOB_NAME_SEPARATOR` e o formato derivam.

```ts
export interface JobOutcome {
  name: string
  durationMs: number
  metrics?: Record<string, number>   // on success
  error?: unknown                    // on failure
}

export const CRON_EXIT_OK = 0
export const CRON_EXIT_JOB_FAILED = 1
export const CRON_EXIT_BAD_INVOCATION = 2

export const JOB_NAME_SEPARATOR = ':'
export const AUTH_MODULE = 'auth'

export class CronInvocationError extends Error { /* name = 'CronInvocationError' */ }

export function qualify(moduleName: string, jobs: readonly CronJob[]): CronJob[] {
  return jobs.map((job) => ({
    ...job,
    name: `${moduleName}${JOB_NAME_SEPARATOR}${job.name}`,
  }))
}

export function jobArgFrom(argv: readonly string[]): string | undefined {
  if (argv.length > MAX_ARGV_LENGTH) throw new CronInvocationError(TOO_MANY_ARGS)
  return argv[SELECTOR_ARG_INDEX]
}

export function selectJobs(jobs: readonly CronJob[], selector?: string): CronJob[] {
  if (selector === undefined) return [...jobs]

  const selected = selector.includes(JOB_NAME_SEPARATOR)
    ? jobs.filter((job) => job.name === selector)
    : jobs.filter((job) => job.name.startsWith(`${selector}${JOB_NAME_SEPARATOR}`))

  if (selected.length === 0) {
    // The message is what an operator reads after a typo in a task definition.
    throw new CronInvocationError(`${UNKNOWN_TARGET} "${selector}" — known targets: …`)
  }
  return selected
}

export async function runJobs(jobs: readonly CronJob[]): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = []
  for (const job of jobs) {
    const start = performance.now()
    try {
      const metrics = await job.run()
      outcomes.push({ name: job.name, durationMs: performance.now() - start, metrics })
    } catch (error) {
      outcomes.push({ name: job.name, durationMs: performance.now() - start, error })
    }
  }
  return outcomes
}

export function cronExitCode(outcomes: readonly JobOutcome[]): number {
  return outcomes.some((o) => o.error !== undefined)
    ? CRON_EXIT_JOB_FAILED
    : CRON_EXIT_OK
}

export async function runCron(
  env: Env,
  logger: AppLogger,
  selector?: string,
): Promise<JobOutcome[]> {
  const { db, pool } = createDatabase(env)
  try {
    const container = makeContainer(db, env, logger)
    const jobs = qualify(AUTH_MODULE, container.auth.jobs)
    return await runJobs(selectJobs(jobs, selector))
  } finally {
    await pool.end()
  }
}
```

- **Jobs em série.** One-shot, sem pressa; série mantém a carga no banco
  previsível e o log em ordem. Paralelo seria `Promise.allSettled` — troca
  trivial se algum dia precisar.
- **Um job que lança não derruba os outros.** Coleta `outcomes` e segue: um
  prune de `pending` quebrado não pode bloquear o de `refresh`. O scheduler
  repete no próximo ciclo.
- **Sem `process.exit` aqui.** `runCron` devolve dados; `cronExitCode` é função
  pura sobre eles. As duas testáveis sem subprocesso.
- `pool.end()` no `finally`, espelhando o `onClose` do `app.ts`.
- `performance.now()` é medição de parede para o log, não tempo de domínio — não
  passa pelo `IClock` de propósito.
- `runCron` recebe `logger` porque `makeContainer` exige (o
  `BestEffortEmailSender`), mesmo não logando nada ele próprio.
- **`AUTH_MODULE` é listado à mão**, como o `AUTH_PREFIX` do `app.ts`. Um módulo
  que registre jobs e seja esquecido aqui nunca roda — por isso a linha tem de
  aparecer no diff. A alternativa (iterar `Object.entries(container)`) exigiria
  que toda fatia de container tivesse `jobs`, e isso fecharia de esguelha a §11
  do `STRUCTURE.md`, que está em aberto.
- **`selectJobs` roda depois do `makeContainer`.** O container é a fonte única de
  verdade sobre quais alvos existem; validar antes exigiria uma segunda lista
  para manter em sincronia, e um typo pagar a abertura de um pool é ruído.
- **Alvo que não casa nada lança**, em vez de rodar zero jobs e reportar sucesso:
  um typo no schedule pareceria uma execução saudável para sempre.

### 5.2 — `main/cron.ts`, a casca

```ts
import { env } from '#infra/config/env'
import { createLogger } from '#infra/observability/logger'
import { cronExitCode, runCron } from './run-cron.js'

const logger = createLogger(env)

let selector: string | undefined
let outcomes: JobOutcome[]
try {
  selector = jobArgFrom(process.argv)
  outcomes = await runCron(env, logger, selector)
} catch (error) {
  logger.error({ err: error, selector }, 'cron run aborted')
  process.exit(
    error instanceof CronInvocationError ? CRON_EXIT_BAD_INVOCATION : CRON_EXIT_JOB_FAILED,
  )
}

for (const outcome of outcomes) {
  if (outcome.error) {
    logger.error(
      { job: outcome.name, durationMs: outcome.durationMs, err: outcome.error },
      'cron job failed',
    )
  } else {
    logger.info(
      { job: outcome.name, durationMs: outcome.durationMs, ...outcome.metrics },
      'cron job done',
    )
  }
}

const exitCode = cronExitCode(outcomes)
logger.info({ jobs: outcomes.length, selector, exitCode }, 'cron run complete')
process.exit(exitCode)
```

O `catch` existe para o operador ler **uma linha** em vez de um stack de
unhandled rejection, e — mais importante — para os dois modos de falha saírem com
códigos diferentes: alvo inválido é `CRON_EXIT_BAD_INVOCATION` (task definition
quebrada), qualquer outra coisa que estoure antes dos jobs rodarem (pool, grafo)
é `CRON_EXIT_JOB_FAILED`. Conflatá-los pagina a pessoa errada. `selector` entra
no log das duas saídas, para o operador saber o que foi pedido.

### 5.3 — Fronteira

| Arquivo | Elemento | Confere? |
|---|---|---|
| `main/cron.ts`, `main/run-cron.ts` | `composition` (`src/main/**`) | importa qualquer coisa — ok |
| `shared/ports/cron-job.ts` | `pure` (`src/shared/**`) | só tipo, importa nada — ok |
| `use-cases/prune-expired-*.ts` | `pure` | depende de `IClock` + contrato de repo — ok |
| `infra/{drizzle,in-memory}/*-repository.ts` | `module-infra` | já são — ok |

`check:boundaries` não precisa de exceção nova.

## 6. Config

`authEnvSchema` ganha três chaves, no estilo `z.coerce.number().int().positive().default(...)`
das TTL vizinhas, cada uma com um `DEFAULT_*` `const` exportado:

| Env var | Default (`const`) | = |
|---|---|---|
| `REFRESH_TOKEN_PRUNE_RETENTION_SECONDS` | `604_800` | 7 dias |
| `PENDING_REGISTRATION_PRUNE_RETENTION_SECONDS` | `86_400` | 24 h |
| `PASSWORD_RESET_TOKEN_PRUNE_RETENTION_SECONDS` | `86_400` | 24 h |

`.int().positive()` pela mesma razão comentada no arquivo: `z.coerce.number()` nu
transforma valor vazio em `0` em silêncio, e retenção `0` apaga tudo que acabou
de expirar — inclusive a linha que um investigador ia querer ver.

`config.spec.ts`, `.env.example` e a fixture de config
(`src/infra/config/fixtures/test-env.ts`) acompanham.

## 7. Testes

**Unit — 3 arquivos colocados** (`use-cases/prune-expired-*.spec.ts`): repo
in-memory semeado com linhas em vários `expires_at`, fake clock. Assere:

- `deleteExpiredBefore` recebe `now − retention`;
- retorno `{ rowsDeleted: n }` com o `n` certo;
- **falsificação:** linha com `expires_at` exatamente no cutoff é apagada (`<=`);
  linha expirada mas ainda dentro da janela **sobrevive**; linha viva
  **sobrevive**.

**Integração — 3 repos tocados** (`drizzle-*-repository.spec.ts`): caso novo de
`deleteExpiredBefore` contra Postgres real — insere expiradas + vivas, chama,
confere a contagem **e que a linha viva continua lá** (deleção antes da troca).

**Integração — 1 arquivo novo** (`tests/integration/cron.spec.ts`): usa
`runCron(testEnv, logger)` real contra o banco de teste (mesmo setup
`migrate-test-database` / `test-database-url` dos vizinhos). Semeia as três
tabelas com expiradas + frescas, roda, assere:

- **sem alvo:** 3 `outcomes` sem `error`, `rowsDeleted` por job bate com o
  semeado, expiradas sumiram, frescas intactas, `cronExitCode === CRON_EXIT_OK`;
- **alvo qualificado** (`auth:prune-expired-refresh-tokens`): 1 `outcome`, com o
  nome qualificado; `refresh_tokens` podada — **e a falsificação:** as outras
  duas tabelas continuam com as DUAS linhas, provando que os outros jobs não
  rodaram. Sem essa asserção, um seletor que silenciosamente rodasse tudo passa;
- **alvo de módulo** (`auth`): volta aos 3 `outcomes`;
- **alvo inexistente:** a promise rejeita com `CronInvocationError`, em vez de
  resolver com lista vazia.

**Unit — 1 arquivo novo** (`src/main/run-cron.spec.ts`): `runJobs`, `cronExitCode`,
`qualify`, `jobArgFrom` e `selectJobs` com jobs falsos e `outcomes` montados à
mão — inclusive um `billing:reconcile` fictício, para exercitar a seleção com
mais de um módulo antes de existir um segundo módulo de verdade.

**O negativo do laço:** um `CronJob` que lança na lista → o `outcome` dele
carrega `error`, o job seguinte ainda roda, e `cronExitCode` devolve
`CRON_EXIT_JOB_FAILED`. Fica aqui e não no `cron.spec.ts` porque `runCron` lê
`container.auth.jobs` e não aceita job falso injetado.

**Os negativos da invocação:** argumento extra e alvo desconhecido lançam
`CronInvocationError` — o **tipo** é asserido, não só o throw, porque é ele que
decide entre `exit 2` e `exit 1`. E um prefixo parcial (`aut`) não casa `auth:…`.

## 8. Custos aceitos

- **Poda não roda em `pnpm dev`** sem invocação à mão (§3.1). Manutenção, não
  corretude.
- **Um `refresh_token` revogado cedo com `expires_at` futuro fica até
  `expires_at + retention`** (§3.4). Limitado pelo TTL.
- **`DELETE` sem batching.** A primeira poda de uma tabela grande é uma
  instrução só: trava as linhas que casam e incha o WAL proporcionalmente. Em
  volume de boilerplate, aceitável. A saída, se um app derivado sentir, é um
  `DELETE ... WHERE ... LIMIT n` em laço — documentado, não construído.
- **Sem lock de instância.** Duas execuções simultâneas do `cron.ts` rodariam os
  `DELETE` em paralelo — idempotente (a segunda apaga zero linhas), só desperdício.
  One-shot agendado pela plataforma não sobrepõe execução; um agendador que
  sobreponha é problema do agendador.
- **O count vem do `rowCount` do driver** (§4.4), cujo tipo é `number | null`;
  `null` é lido como zero. Mesmo padrão de `issueOrRefresh`/`consume`.

## 9. Emendas de documentação

- **`DECISIONS.md`** — decisão 30: `cron.ts` one-shot + scheduler externo;
  registry de jobs por módulo; poda com janela de retenção por tabela. Registra
  os rejeitados: processo longo com `node-cron`, `pg_cron`, método único de poda,
  deleção no instante da expiração, predicado com `revoked_at`/`consumed_at`.
- **`STRUCTURE.md`** — §2: `cron.ts` e `run-cron.ts` deixam de ser aspiracionais
  na árvore; `shared/ports/cron-job.ts` entra. §4 intacta (os globs já cobrem os
  caminhos novos — conferido em §5.3).
- **`TODO.md`** — risca "Poda de tokens expirados"; anota que o outbox segue
  pendente mas **destravado** (o registry de jobs existe, o outbox é mais um
  `CronJob`).
- **Como agendar em produção** vai na decisão 30 do `DECISIONS.md` (exemplos: k8s
  `CronJob` chamando `node dist/main/cron.js`; linha de `crontab`) e a forma de
  rodar em dev (`node --conditions=development --import tsx src/main/cron.ts`)
  numa nota do `STRUCTURE.md` §2, junto da árvore. Não há `README.md` na raiz do
  repo hoje e esta fatia não cria um — se o plano decidir criar, é o lugar
  natural para migrar as duas.

## 10. Próxima fatia

Com o `cron.ts` e o registry existindo, os candidatos são **outbox transacional**
(agora é um `CronJob` de dispatch + a tabela + a escrita transacional nos
use-cases que mandam e-mail) e **login social / OAuth Google** — que o
`DECISIONS.md` §6 já tem três sub-decisões tomadas para. O handoff da fatia 12
coloca o OAuth como o de maior valor; o outbox é o de menor risco.
