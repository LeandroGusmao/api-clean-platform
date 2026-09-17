# Fatia 16 — Outbox transacional: design

> Escrito em 2026-09-15, ao fim da fatia 15 (seed do banco de dev). Contexto de
> entrada: [`docs/TODO.md`](../../TODO.md), "o resto em ordem decrescente de
> urgência" — o outbox estava **destravado** desde a fatia 13 (`cron.ts` e o
> registry de jobs já existem) e adiado desde a fatia 10 (§5.3 da
> [`2026-09-03-email-verification-design.md`](2026-09-03-email-verification-design.md)).
> Fecha o furo "crash entre o `COMMIT` e o envio SMTP perde o e-mail em
> silêncio", registrado no `TODO.md` desde então.

## 1. O que esta fatia entrega

Uma tabela nova, `outbox_messages`, e uma escrita transacional: os três
avisos que hoje são enviados **depois** do `commit` de uma transação —
`passwordChangedEmail`, `passwordResetCompletedEmail`, `googleAccountLinkedEmail`
— passam a ser **gravados dentro** da mesma transação que já muda a senha, reseta
a senha ou vincula o provedor. Um `CronJob` novo (`auth:dispatch-outbox-messages`)
lê as linhas pendentes e manda de verdade, fora de qualquer transação de
request. Um segundo `CronJob` (`auth:prune-outbox-messages`) poda as linhas já
despachadas ou desistidas, no mesmo molde dos três de poda da fatia 13.

**Não entrega** outbox para `verificationEmail` nem `passwordResetEmail`. Os
dois carregam segredo em texto claro (código de seis dígitos, token de reset) —
exatamente o motivo que descartou o outbox inteiro na fatia 10 (§5.3): a linha
ficaria em repouso no banco, em texto claro, até o despacho. Essa razão não
mudou. Os dois continuam sendo enviados no fluxo do request, com o thunk
`DeliverVerification` que já existe.

**Não entrega** outbox para `accountAlreadyExistsEmail` (`register-user.ts`).
Esse envio não tem, hoje, uma escrita transacional precedente para tornar
atômica — o ramo "conta já existe" só lê. Sem `commit` para correlacionar, não
há o buraco "crash entre commit e envio" para fechar ali; entra se um dia esse
raciocínio mudar, mas não é esta fatia.

## 2. O buraco que fecha

Em `change-password.ts`, `reset-password.ts` e `sign-in-with-google.ts`, o
`emailSender` (decorado por `BestEffortEmailSender`) é chamado depois do
`await this.uow(...)` resolver. Um crash do processo entre o `COMMIT` da
transação e essa chamada — falta de energia, OOM kill, deploy no meio — perde o
aviso permanentemente e em silêncio: a senha já mudou, a sessão já foi
revogada, o provedor já foi vinculado, e ninguém foi avisado. Para
`passwordChangedEmail` e o disparo de reuso de refresh token que a auditoria de
2026-09-07 já tratou como "a única defesa que sobra quando o atacante já tem a
sessão", esse é o pior lugar possível para perder uma mensagem.

O `BestEffortEmailSender` cobre a falha de **SMTP recusar o envio** — mas não
cobre o processo nunca chegar a tentar.

## 3. Decisões tomadas no brainstorming

1. **Escopo: só os três avisos pós-commit.** Ver §1. `verificationEmail` e
   `passwordResetEmail` seguem fora, `accountAlreadyExistsEmail` também.
2. **Retry: contador simples com teto, sem backoff explícito.** O intervalo do
   scheduler externo que invoca `cron.ts` (decisão 30, §3.1 da spec da fatia
   13) já É o backoff — uma linha que falhou fica pendente e é tentada de novo
   na próxima execução. Ao atingir `OUTBOX_DISPATCH_MAX_ATTEMPTS`, a linha vira
   `failed` e para de ser tentada; não fica retentando para sempre uma conta
   com SMTP permanentemente recusando (bounce).
3. **Estado por timestamp nulável, não enum.** Mesmo idioma de
   `pending_registrations.consumed_at` e `refresh_tokens.revoked_at`:
   `dispatched_at`/`failed_at`, não uma coluna `status`.
4. **A tabela vive no módulo `auth`.** Hoje é o único módulo que manda e-mail;
   o `email-sender` port já vive em `shared/` por ser capacidade técnica
   transversal (R5), mas a linha do outbox é escrita **dentro do `uow` do
   `auth`** — e o `IUnitOfWork<AuthRepos>` é por módulo. Generalizar antes de
   um segundo módulo existir seria abstração sem segundo consumidor para
   validar a forma certa (YAGNI, igual ao §5.2 rejeitado nesta mesma spec de
   verificação de e-mail para o thunk inline).

## 4. O modelo

### 4.1 — Schema `outbox_messages`

```ts
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('outbox_messages_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} is null and ${table.failedAt} is null`),
  ],
)
```

Sem defaults de coluna — mesma razão de sempre (`refresh-tokens.ts`,
`pending-registrations.ts`): `timestamptz` do Postgres é em microssegundos, um
`Date` do JS é em milissegundos, e toda comparação de instante precisa vir da
mesma fonte (`IClock`). Sem foreign key para `users`: o destinatário é um
endereço de e-mail já resolvido no momento do enfileiramento, não uma
referência viva — um `users` deletado depois não deveria impedir o despacho de
um aviso que já fazia sentido quando foi enfileirado.

### 4.2 — Entidade `OutboxMessage`

Mesmo molde de `PendingRegistration`: campos privados (`#`), `Object.freeze`,
`create`/`fromTrusted`, getters que clonam `Date`. Sem lógica de invariante
complexa — carrega estado, não decide nada sozinha; quem decide é o
repositório (via `UPDATE` condicional) e o use case de despacho.

```ts
export interface CreateOutboxMessageProps {
  id: string
  message: EmailMessage
  now: Date
}

export interface TrustedOutboxMessageProps {
  id: string
  to: string
  subject: string
  text: string
  attempts: number
  lastError: string | null
  dispatchedAt: Date | null
  failedAt: Date | null
  createdAt: Date
}
```

`toEmailMessage(): EmailMessage` reconstitui `{ to, subject, text }` para o
`IEmailSender.send` — a entidade não conhece o port, o use case de despacho é
quem faz a ponte.

### 4.3 — `IOutboxMessagesRepository`

```ts
export interface IOutboxMessagesRepository {
  /** Insert simples, chamado DENTRO do `uow` do use case produtor. */
  save(message: OutboxMessage): Promise<void>

  /**
   * `WHERE dispatched_at IS NULL AND failed_at IS NULL ORDER BY created_at
   * LIMIT ?`. FIFO — a ordem em que os avisos foram prometidos é a ordem em
   * que saem.
   */
  findPendingBatch(limit: number): Promise<OutboxMessage[]>

  /** `UPDATE ... SET dispatched_at = ? WHERE id = ?`. */
  markDispatched(id: string, at: Date): Promise<void>

  /**
   * `UPDATE ... SET attempts = attempts + 1, last_error = ?, failed_at = CASE
   * WHEN attempts + 1 >= ? THEN ? ELSE failed_at END WHERE id = ?`.
   * Incondicional na cláusula WHERE — ao contrário de
   * `registerFailedAttempt`, não há corrida a serializar: só o job de
   * despacho escreve nesta linha, uma por vez (§7).
   */
  recordFailure(id: string, at: Date, error: string, maxAttempts: number): Promise<void>

  /**
   * Poda: `DELETE ... WHERE (dispatched_at IS NOT NULL OR failed_at IS NOT
   * NULL) AND coalesce(dispatched_at, failed_at) <= ?`. Espelha
   * `deleteExpiredBefore`. Nunca toca uma linha ainda pendente.
   */
  deleteDispatchedOrFailedBefore(cutoff: Date): Promise<number>
}
```

`AuthRepos` ganha `outboxMessages: IOutboxMessagesRepository`.

## 5. Lado produtor — os três use cases

`change-password.ts`, `reset-password.ts`, `sign-in-with-google.ts`: o envio
que hoje acontece depois do `uow` resolver passa para dentro do callback.
Exemplo (`change-password.ts`):

```ts
await this.uow(async ({ users, refreshTokens, outboxMessages }) => {
  await users.updatePasswordHash(user.id, passwordHash, now)
  await refreshTokens.revokeAllForUser(user.id, now)
  await refreshTokens.save(issued.entity)
  await outboxMessages.save(
    OutboxMessage.create({
      id: this.idGenerator.generate(),
      message: passwordChangedEmail(user.email),
      now,
    }),
  )
})
```

A ordem dentro do callback segue a mesma normatividade dos comentários já
existentes ali (revogar antes de inserir o token novo, §... do design da
fatia 8/9) — o `outboxMessages.save` entra por último, sem mudar a ordem das
escritas que já havia.

`BestEffortEmailSender` sai da injeção desses três use cases: não há mais um
envio ali para decorar. `emailSender`/`bestEffortEmailSender` continuam
servindo `EmailVerificationIssuer` e o `NO_DELIVERY`/`accountAlreadyExistsEmail`
de `register-user.ts`, que ficam fora de escopo (§1).

## 6. Lado consumidor — `DispatchOutboxMessagesUseCase`

Sem `uow`: cada linha do lote é seu próprio autocommit implícito, pelo mesmo
motivo de `runJobs` isolar falha por job — uma falha de SMTP na linha 3 não
pode reverter nem bloquear a 1 e a 2.

```ts
export class DispatchOutboxMessagesUseCase {
  constructor(
    private readonly outboxMessages: IOutboxMessagesRepository,
    private readonly emailSender: IEmailSender, // o cru — não o best-effort
    private readonly clock: IClock,
    private readonly maxAttempts: number,
    private readonly batchSize: number,
  ) {}

  async execute(): Promise<{ dispatched: number; failed: number }> {
    const pending = await this.outboxMessages.findPendingBatch(this.batchSize)
    let dispatched = 0
    let failed = 0

    for (const message of pending) {
      const now = this.clock.now()
      try {
        await this.emailSender.send(message.toEmailMessage())
        await this.outboxMessages.markDispatched(message.id, now)
        dispatched++
      } catch (error) {
        await this.outboxMessages.recordFailure(
          message.id,
          now,
          error instanceof Error ? error.message : String(error),
          this.maxAttempts,
        )
        failed++
      }
    }

    return { dispatched, failed }
  }
}
```

O `emailSender` cru, não o `BestEffortEmailSender`: aqui o catch **é** a lógica
de best-effort — decidir a próxima tentativa, não engolir e esquecer.

### 6.1 — `CronJob`s novos em `container.ts`

Mesmo molde dos três de poda:

```ts
{
  name: DISPATCH_OUTBOX_MESSAGES_JOB,
  run: async () => {
    const { dispatched, failed } = await dispatchOutboxMessages.execute()
    return { dispatched, failed }
  },
},
{
  name: PRUNE_OUTBOX_MESSAGES_JOB,
  run: async () => {
    const { rowsDeleted } = await pruneOutboxMessages.execute()
    return { rowsDeleted }
  },
},
```

Nada muda em `cron.ts`/`run-cron.ts` — o registry já foi desenhado na fatia 13
antecipando exatamente este caso (comentário em `cron-job.ts`: "a future
outbox-dispatch job returns its own counters").

## 7. Erros e casos de borda

- **Falha de infraestrutura no `recordFailure`/`markDispatched` em si** (ex.:
  banco fora do ar) não é capturada pelo `catch` do laço — só a falha do
  `emailSender.send` é local à linha. Uma falha ali propaga e derruba o
  `execute()` inteiro, que o `runJobs` já registra como job com `error`.
- **Duas execuções concorrentes do dispatch job** podem pegar a mesma linha em
  `findPendingBatch` e mandar o aviso duas vezes. Aceito: é um aviso ("sua
  senha mudou"), não um segredo — duplicar é inofensivo, ao contrário de
  duplicar um código de verificação. `SELECT ... FOR UPDATE SKIP LOCKED`
  fecharia isso, mas é complexidade real para um risco baixo (a janela é a
  duração de um `execute()`) e sem custo caso aconteça. Mesma aceitação que o
  "sem lock de instância" da poda (§8 da spec da fatia 13).
- **`outboxMessages.save` falhando dentro do `uow`** reverte a transação
  inteira — a senha não muda, a sessão não é revogada, nada é enviado. Correto:
  mesmo "um fato, ou tudo ou nada" que já rege os outros repositórios ali
  dentro.
- **Linha `failed` (teto atingido) não gera alerta dedicado.** `{ dispatched,
  failed }` já vai para a linha de log do `cron.ts` a cada execução; um
  `failed` sustentado ao longo de execuções é visível em qualquer leitura de
  log. Alerta dedicado é uma pendência de observabilidade mais ampla (auditoria
  de 2026-09-07), não desta fatia.
- **Migração:** tabela nova, sem coluna nova em tabela existente. Sem backfill.

## 8. Config

`authEnvSchema` ganha três chaves, estilo `z.coerce.number().int().positive().default(...)`
das vizinhas, cada uma com `DEFAULT_*` exportado:

| Env var | Default (`const`) | = |
|---|---|---|
| `OUTBOX_DISPATCH_MAX_ATTEMPTS` | `5` | — |
| `OUTBOX_DISPATCH_BATCH_SIZE` | `100` | — |
| `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS` | `604_800` | 7 dias |

`.int().positive()` pela mesma razão já comentada em `config.ts`: um valor
vazio coagido a `0` faria `OUTBOX_DISPATCH_MAX_ATTEMPTS=0` marcar toda linha
`failed` na primeira falha, e retenção `0` apagaria uma linha recém-despachada
antes de qualquer chance de auditoria manual.

`config.spec.ts`, `.env.example` e `src/infra/config/fixtures/test-env.ts`
acompanham.

## 9. Testes

**Unit — entidade** (`entities/outbox-message.spec.ts`): `create`/`fromTrusted`,
congelamento, `toEmailMessage()`.

**Unit — `DispatchOutboxMessagesUseCase`** (repo in-memory, `IEmailSender`
fake, fake clock):

- lote vazio → `{ dispatched: 0, failed: 0 }`, nenhuma chamada de envio;
- envio ok → `markDispatched` chamado, `recordFailure` não;
- envio falha → `recordFailure` chamado com `maxAttempts`, `markDispatched`
  não;
- **falsificação de isolamento:** um lote de três linhas onde a do meio falha
  no `send` — as outras duas ainda são processadas. Teste de ordem completa
  (`callLog`), mesmo formato do §5.4 da spec de verificação de e-mail: um
  `toContain` não mataria uma reordenação que despachasse a linha errada;
- erro do `recordFailure`/`markDispatched` em si (não do `send`) propaga e
  interrompe o `execute()` — as linhas restantes do lote não são tentadas.

**Unit — `PruneOutboxMessagesUseCase`**: mesmo teste de retenção dos três
primos (linha dentro da janela sobrevive, fora da janela é apagada; linha
ainda pendente nunca é tocada, dentro ou fora da janela).

**Unit — os três use cases produtores** (`change-password.spec.ts`,
`reset-password.spec.ts`, `sign-in-with-google.spec.ts`): troca a asserção "o
`emailSender.send` foi chamado depois do `uow` resolver" por "o
`outboxMessages.save` foi chamado **dentro** do callback do `uow`, antes dele
resolver" — mesmo teste de ordem completa (`callLog`) que cada um já tem para
o envio antigo, agora mirando `outboxMessages.save` na posição certa da
sequência.

**Integração — repositório real** (`drizzle-outbox-messages-repository.spec.ts`):

- `findPendingBatch` respeita `dispatched_at IS NULL AND failed_at IS NULL` e a
  ordem por `created_at`;
- `recordFailure` incrementa `attempts` e só seta `failed_at` ao atingir o
  teto — chamada abaixo do teto deixa `failed_at` null;
- `deleteDispatchedOrFailedBefore` apaga só despachada/desistida dentro da
  janela; linha pendente sobrevive independentemente da idade.

**Integração — `tests/integration/cron.spec.ts`** (arquivo já existente da
fatia 13): novo caso cobrindo os dois jobs novos, no mesmo molde dos três de
poda — roda com alvo qualificado (`auth:dispatch-outbox-messages`), semeia
linhas pendentes, confere `dispatched`/`failed` batendo com o semeado e que
outras tabelas/jobs não foram tocados.

## 10. Custos aceitos

- **Duplicidade em corrida entre execuções concorrentes do dispatch job** (§7).
  Inofensivo para avisos sem segredo.
- **`DELETE` sem batching na poda**, mesmo custo aceito da fatia 13 — volume de
  boilerplate não justifica `LIMIT` em laço agora.
- **Sem lock de instância** no dispatch nem na poda — mesmo raciocínio da
  fatia 13: one-shot agendado pela plataforma não sobrepõe execução; um
  agendador que sobreponha é problema do agendador.
- **`accountAlreadyExistsEmail` fora do outbox** (§1) — sem escrita
  transacional a correlacionar, não há buraco de atomicidade ali para este
  desenho fechar.
- **`verificationEmail`/`passwordResetEmail` seguem fora** — mesma razão da
  fatia 10, ainda válida: texto claro em repouso no banco.

## 11. Emendas de documentação

- **`DECISIONS.md`** — nova decisão (33): outbox transacional escopado aos três
  avisos pós-commit; estado por timestamp nulável; retry com teto simples, sem
  backoff explícito (o intervalo do scheduler já cumpre esse papel); tabela
  vive no módulo `auth`. Registra os rejeitados: outbox genérico em `shared/`
  antes de um segundo módulo existir; worker de longa duração com
  LISTEN/NOTIFY em vez de poll pelo `cron.ts`.
- **`STRUCTURE.md`** — entra `outbox_messages` no schema do `auth`,
  `dispatch-outbox-messages.ts`/`prune-outbox-messages.ts` em `use-cases/`, o
  novo repositório em `repositories/`.
- **`TODO.md`** — risca "Outbox transacional" da lista de urgência decrescente;
  reescreve o parágrafo de abertura apontando o próximo bloco genérico.

## 12. Próxima fatia

Com o outbox fechado, o `TODO.md` (antes desta fatia) aponta o throttle de
`confirm` por e-mail como próximo item de urgência — nenhuma dependência
pendente, item isolado. "Listar sessões ativas" e "invalidar sessões +
notificar o dono na verificação" seguem logo depois, ambos já destravados por
`family_id` e pela infraestrutura de e-mail que já existe.
