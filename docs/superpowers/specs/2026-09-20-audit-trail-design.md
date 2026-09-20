# Fatia 26 — Trilha de auditoria: o mecanismo e os cinco avisos de segurança

## 1. Objetivo

Fechar o item #6 de "Pendências do boilerplate" do [`TODO.md`](../../TODO.md). Hoje
os eventos de segurança do `auth` deixam três tipos de rastro, e nenhum é uma
trilha: o aviso por e-mail (vai para o dono e é podado em 7 dias), a linha de log
(`securityEvent`, sem retenção garantida e sem consulta por conta) e o próprio
estado (uma senha trocada não diz quando nem de onde). Não há um lugar onde se
responda "o que aconteceu com esta conta, quando e a partir de onde", que é o que
a LGPD art. 37 cobra de quem opera dados pessoais.

A entrega é o **encanamento**, com cinco consumidores reais: uma tabela
`audit_events`, uma porta, e a gravação de um evento em cada um dos cinco pontos
onde o `auth` já grava um aviso de segurança no outbox, na mesma transação. *O que*
mais registrar e por quanto tempo guardar seguem sendo decisão de produto; o
padrão de retenção é uma variável de ambiente.

## 2. Escopo

### Entra

- Tabela `audit_events` e a migration.
- `AuditEvent` (entidade) e `AuditEventType` (conjunto fechado, cinco valores).
- `IAuditEventsRepository` (`save`, `deleteOccurredBefore`), adapters Drizzle e em
  memória; `auditEvents` no `AuthRepos`, no `authRepositories` e no
  `noopAuthRepos`.
- `PruneAuditEventsUseCase` e o job no registro do cron, ao lado da poda do outbox.
- `AUDIT_EVENT_PRUNE_RETENTION_SECONDS` (padrão 1 ano).
- Um evento gravado em cada um dos cinco use cases (§6), na transação existente.
- `device` nos comandos de `ResetPasswordUseCase` e `DeleteAccountUseCase`, e os
  dois endpoints chamando `buildDeviceContext`.
- Decisão 43 e as emendas da §11.

### Não entra, e por quê

| Item | Por quê |
|---|---|
| Endpoint para o dono ou um admin ler a trilha | Quem consulta hoje é o operador, por SQL. Uma rota é decisão de produto (quem lê, com que filtro), e a porta não ganha método de leitura sem consumidor |
| Eventos de login e logout | Volume alto, e a decisão de quanto guardar deixa de ser trivial. A escolha foi pelos cinco avisos que já existem |
| Qualquer coisa em `shared/` | A decisão 33 recusou o outbox genérico em `shared/` antes de um segundo módulo, e o `token-signer.ts` diz que um contrato nasce com o que tem consumidor. Sobe quando um segundo módulo precisar |
| Coluna JSON livre de metadados | Sem consumidor, não há forma validada. Cada evento novo que precise de um dado ganha uma coluna, com migration |
| E-mail do usuário na linha | É dado pessoal que sobreviveria à conta. O `user_id` basta para a consulta |
| Gravar o replay do reuso | O evento marca a **transição**, como o aviso da decisão 41 (§6.4) |
| Trilha para `pending_registrations` e o cadastro | Não são "eventos de segurança de uma conta que existe" |

## 3. Fatos verificados que moldaram o desenho

### 3.1 — Os cinco pontos já têm o lugar certo

Cada um já grava um aviso de segurança no outbox, dentro de `uow`, na transação da
mudança que descreve:

| Evento | Use case | Onde |
|---|---|---|
| Senha alterada | `change-password.ts` | `outboxMessages.save(… passwordChangedEmail …)` |
| Senha redefinida | `reset-password.ts` | `outboxMessages.save(… passwordResetCompletedEmail …)` |
| Google vinculado | `sign-in-with-google.ts` | ao vincular a conta existente (`googleAccountLinkedEmail`) |
| Reuso detectado | `refresh-token.ts` | no ramo `revoked > 0` (decisão 41) |
| Conta deletada | `delete-account.ts` | `outboxMessages.save(… accountDeletedEmail …)` |

Gravar o evento ao lado do aviso mantém a garantia que já existe: ou a mudança, o
aviso e o evento existem, ou nenhum.

### 3.2 — Só três dos cinco recebem o contexto do cliente

`change-password` e `sign-in-with-google` recebem `device: SessionDevice` no
comando; o reuso tem o `ip` da requisição e o rótulo na linha do token gasto.
`reset-password` recebe só `{ token, newPassword }` (o endpoint passa
`request.body` direto) e `delete-account` recebe `{ userId, password? }`; nenhum dos
dois endpoints chama `buildDeviceContext`. Para a trilha dizer de onde veio cada
evento, esses dois comandos ganham `device`.

### 3.3 — A trilha tem de sobreviver à conta

A cascata do schema apaga `refresh_tokens`, `federated_identities` e
`password_reset_tokens` quando o `users` some, e a decisão 37 deixou o aviso de
deleção sem FK justamente para ele sobreviver. O `audit_events.user_id` segue o
mesmo caminho: `uuid NOT NULL`, **sem** `references`. O evento `ACCOUNT_DELETED` é
o caso que prova isso.

### 3.4 — `device-context.ts` é a única porta de entrada do contexto

`buildDeviceContext(request)` devolve `{ ip: string | null, label: string }`, com o
IP já validado (`null` se não parseia) e o rótulo já derivado e limitado a 64
caracteres. A trilha reaproveita esses valores como estão, e por isso não guarda o
`User-Agent` cru (decisão 38).

### 3.5 — A poda segue o molde do outbox

`PruneOutboxMessagesUseCase` calcula `cutoff = now - retention` e chama
`deleteDispatchedOrFailedBefore`; o `container.ts` monta o use case com
`config.OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS * 1000` e o registra como um job
com `name` exportado. A nova poda repete a forma, com nome e variável análogos.

## 4. Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Mora **dentro do `auth`**, não em `shared/` | Decisão 33 e `token-signer.ts`: nenhum segundo módulo consome ainda |
| D2 | Escopo: os **cinco avisos de segurança** | Cinco consumidores reais sem inventar evento; uma tabela sem consumidor não valida a forma (decisão 37) |
| D3 | Cada evento é gravado **na mesma transação** que o aviso do outbox | Mesma garantia dos quatro avisos existentes: ou tudo existe, ou nada |
| D4 | `user_id` **sem FK** | A trilha sobrevive à conta apagada (§3.3) |
| D5 | Conjunto fechado `AuditEventType`, coluna `text` | Cinco valores conhecidos; um enum do Postgres exigiria migration a cada evento novo, e a validação fica no tipo |
| D6 | `ip` e `device_label` nos **cinco** eventos, nuláveis | Uma trilha que não diz de onde veio a deleção é fraca para o que a LGPD cobra. Nulos porque o IP pode não parsear |
| D7 | Sem e-mail e sem coluna JSON na linha | Dado pessoal que sobreviveria à conta; sem consumidor, sem forma validada |
| D8 | `occurred_at` vem do `IClock`, sem default no banco | Mesmo critério de todas as colunas de tempo do módulo |
| D9 | Retenção por `AUDIT_EVENT_PRUNE_RETENTION_SECONDS`, padrão **1 ano** | O nome segue `OUTBOX_MESSAGE_PRUNE_RETENTION_SECONDS`. O número é **marcador**, não conselho jurídico: quanto guardar é decisão de produto e de compliance |
| D10 | O reuso grava só na **transição** (`revoked > 0`) | Decisão 41: os replays seguem só no log `securityEvent` |
| D11 | A porta não tem método de leitura | Sem consumidor. O operador consulta por SQL; os testes leem a tabela direto |

## 5. O modelo

### 5.1 — Schema (`infra/drizzle/schema/audit-events.ts`)

```ts
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    userId: uuid('user_id').notNull(), // no references: outlives the account
    ip: text('ip'),
    deviceLabel: text('device_label'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('audit_events_user_id_occurred_at_idx').on(table.userId, table.occurredAt),
    index('audit_events_occurred_at_idx').on(table.occurredAt),
  ],
)
```

Nomes de tabela, coluna e índice inline: é arquivo de schema, isento pelo
`CLAUDE.md`. Sem default em nenhuma coluna de tempo. O primeiro índice responde "o
que aconteceu com esta conta"; o segundo serve a poda.

### 5.2 — A entidade e o tipo

```ts
export const AuditEventType = {
  PasswordChanged: 'PASSWORD_CHANGED',
  PasswordResetCompleted: 'PASSWORD_RESET_COMPLETED',
  GoogleAccountLinked: 'GOOGLE_ACCOUNT_LINKED',
  RefreshTokenReuseDetected: 'REFRESH_TOKEN_REUSE_DETECTED',
  AccountDeleted: 'ACCOUNT_DELETED',
} as const
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType]
```

`AuditEvent.create({ id, type, userId, device, now })`, com estado em campos `#`
privados e `Object.freeze`, como `OutboxMessage` e `RefreshToken`; `device` é
`{ ip: string | null, label: string | null }`. Só `create`: sem `fromTrusted`,
porque nada lê a linha de volta (D11).

### 5.3 — A porta

```ts
export interface IAuditEventsRepository {
  /** Plain insert, called INSIDE the `uow` of the use case that made the change. */
  save(event: AuditEvent): Promise<void>

  /** Deletes every event that occurred at or before `cutoff`; returns how many. */
  deleteOccurredBefore(cutoff: Date): Promise<number>
}
```

O adapter Drizzle mapeia entidade → linha; o em memória guarda em
`events: AuditEvent[]`. `AuthRepos`, `authRepositories` e `noopAuthRepos` ganham
`auditEvents`.

## 6. A gravação, evento a evento

Todos dentro do `uow` que já grava o aviso, com `id` de `IIdGenerator` e `now` do
`IClock` já lido pelo use case.

### 6.1 — Senha alterada e Google vinculado

`AuditEvent.create({ type, userId: user.id, device: command.device → { ip, label }, now })`.

### 6.2 — Senha redefinida

O comando ganha `device: SessionDevice`; o endpoint passa
`{ ...request.body, device: buildDeviceContext(request) }`. O `userId` é o do dono
do token, que o use case já tem.

### 6.3 — Conta deletada

O comando ganha `device: SessionDevice`; o endpoint o preenche com
`buildDeviceContext(request)`. O evento é gravado **antes** do `users.deleteById`
dentro do mesmo `uow`, com `userId: user.id`. Como a coluna não tem FK, a cascata
não o alcança.

### 6.4 — Reuso detectado

Dentro do `if (revoked > 0)`, ao lado do aviso:
`type: RefreshTokenReuseDetected`, `userId: current.userId`, `ip: command.ip`,
`label: current.deviceLabel`. Fica **fora** do `if (owner !== null)`, e é gravado
antes da busca do dono: o aviso precisa do e-mail, o evento não, então ele não
mora sob uma condição que é sobre o e-mail. O `owner === null` é só a guarda de
tipo de `users.findById` (a FK com cascata e o `FOR UPDATE` da rotação garantem que
o dono existe), e por isso não há caso de teste para ele.

## 7. Config e poda

`AUDIT_EVENT_PRUNE_RETENTION_SECONDS`: `z.coerce.number().int().positive()`, padrão
`DEFAULT_AUDIT_EVENT_PRUNE_RETENTION_SECONDS = 31_536_000`; `.positive()` pela razão
de todo o arquivo (zero apagaria tudo a cada execução, e rejeitar zero rejeita o
vazio). `PruneAuditEventsUseCase(auditEvents, clock, retentionMs)` calcula
`cutoff = now - retentionMs` e devolve `{ rowsDeleted }`. O job
`PRUNE_AUDIT_EVENTS_JOB` entra no registro do `container.ts`. O fixture de teste, o
`env.spec.ts` e o `.env.example` ganham a variável.

## 8. Testes

**Unidade**
- `AuditEvent.create`: guarda tipo, usuário, contexto e instante; estado
  imutável e não enumerável.
- Cada um dos cinco use cases grava **exatamente um** evento, com `type`,
  `userId`, `ip` e rótulo certos, na mesma chamada do aviso.
- Reuso: um replay contra a família já morta não grava evento.
- Poda: calcula o corte e devolve a contagem; a config tem o padrão de 1 ano e
  rejeita vazio.
- Repositório em memória: `deleteOccurredBefore` respeita o corte, inclusive na
  borda.

**Integração** (Postgres real)
- Repositório: `save` grava a linha; `deleteOccurredBefore` apaga só o que é
  anterior ou igual ao corte.
- **A prova do problema:** deletar a conta deixa o evento `ACCOUNT_DELETED` vivo
  depois que a cascata apaga o `users`.
- Atomicidade: uma troca de senha cuja transação falha não deixa evento; uma que
  passa deixa exatamente um.
- Os dois endpoints novos (`reset-password`, `DELETE /auth/me`) gravam `ip` e
  rótulo na linha.
- A poda pelo `cron`: um evento antigo some e um recente fica.

## 9. Custos aceitos

1. **O `user_id` continua na trilha depois da conta apagada.** É identificador
   pseudonimizado, e a trilha existe justamente para provar o que aconteceu.
2. **IP e aparelho ficam em repouso pelo tempo da retenção**, que é maior que os 7
   dias do outbox. O mesmo dado já vive 60 dias em `refresh_tokens` (decisão 38).
3. **O reuso registra só a primeira detecção**; os replays seguem só no log.
4. **Sem leitura pela API.** Uma rota é o próximo passo natural, e é decisão de
   produto.
5. **O padrão de 1 ano é um marcador**, não uma resposta de compliance.
6. **O banco não impede escrever um `type` fora do conjunto.** A validação está
   no tipo da entidade; a coluna é `text`. Um `CHECK` fica de fora
   pelo custo de migration a cada evento novo.

## 10. Riscos de execução

- Adicionar `device` a dois comandos obriga a atualizar seus specs de unidade e de
  integração; o compilador aponta cada ponto.
- Adicionar `auditEvents` ao `AuthRepos` obriga a atualizar todo `makeUow` de spec
  que monta o conjunto de repositórios à mão (o `noopAuthRepos` cobre os demais).

## 11. Emendas de documentação

- [`DECISIONS.md`](../../DECISIONS.md): decisão 43, com D1 a D11, o que foi recusado
  (`shared/`, tabela sem consumidor, JSON livre, e-mail na linha) e os custos da §9.
- [`TODO.md`](../../TODO.md): riscar o item #6, atualizar o cabeçalho e a "Próxima
  fatia"; na linha do #6, apontar a decisão 43.
- Decisão 37 (deleção de conta): nota curta de que o evento `ACCOUNT_DELETED` passou
  a existir, fechando o "é um dos eventos a capturar".
- Comentários de `unit-of-work.ts` e `outbox-message.ts` não mudam: a trilha é um
  repositório novo, não um aviso novo.

## 12. Próxima fatia

Depois do #6, resta o #7 (`kid` no JWT), que compra pouco. O #5 (senha vazada)
segue adiado com gatilho. A fila do boilerplate fica sem item desbloqueado de
alto valor: o que sobe a partir daí depende da escolha do app derivado.
