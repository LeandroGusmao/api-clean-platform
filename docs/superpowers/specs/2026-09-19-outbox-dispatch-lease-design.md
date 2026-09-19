# Fatia 23 — Outbox: etiqueta com prazo no dispatch

## 1. Objetivo

Fechar o item #2 de "Pendências do boilerplate" do [`TODO.md`](../../TODO.md):
o dispatch do outbox não tem trava. `findPendingBatch` é um `SELECT` comum e o
`markDispatched` só roda **depois** do `send`, então duas execuções que se
sobreponham leem as mesmas linhas e mandam o mesmo e-mail duas vezes. A janela
de duplicidade é a duração da execução inteira: até `batchSize` envios seguidos.

A [spec do outbox](2026-09-15-transactional-outbox-design.md) aceitou isso (§7 e
§10) apoiada em uma premissa: "one-shot agendado pela plataforma não sobrepõe
execução". Essa premissa depende de onde o app roda, e isso ainda não está
decidido; um `CronJob` do Kubernetes, por exemplo, permite sobreposição por
padrão. O boilerplate não deve depender dela.

A entrega: cada mensagem ganha uma **etiqueta com prazo** (`claimed_until`) no
instante em que uma execução a pega. Execuções concorrentes trabalham em
mensagens diferentes, e se uma some no meio, a etiqueta vence e outra assume.

## 2. Escopo

### Entra

- Coluna `claimed_until` em `outbox_messages`, com migration.
- `claimNext(now, leaseUntil)` no lugar de `findPendingBatch`, nos dois
  repositórios (Drizzle e memória).
- O laço do `DispatchOutboxMessagesUseCase` passa a pegar uma mensagem por vez.
- `OUTBOX_DISPATCH_LEASE_SECONDS`.
- Timeouts explícitos no transporte SMTP, porque a etiqueta só é confiável se o
  envio tem limite.
- Decisão 40 no `DECISIONS.md` e as emendas da §11.

### Não entra, e por quê

| Item | Por quê |
|---|---|
| "Exatamente uma vez" | Impossível com e-mail: se o processo morre entre o `send` e o `markDispatched`, a mensagem é reenviada. O que esta fatia garante é não duplicar **por concorrência** |
| Trava de instância por advisory lock | Foi a alternativa recusada (§4): quebra atrás de um pooler em modo transação e um envio pendurado bloquearia todas as execuções seguintes |
| `FOR UPDATE SKIP LOCKED` numa transação que engloba o `send` | Segura uma conexão do pool parada durante o SMTP, e o `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (10 s) mataria a transação de um envio lento. A §8 do desenho da unit of work proíbe I/O externo (e-mail, HTTP) dentro de transação |
| Incrementar `attempts` no momento de pegar | Protegeria contra uma mensagem que derruba o processo antes do `recordFailure`, mas muda a semântica de `attempts` e não é pedido por nenhum consumidor. Igual a hoje |
| Lock na poda | Idempotente: a segunda execução apaga zero linhas. Custo aceito da fatia 13, intocado |
| Intervalo de retry separado | A etiqueta já serve de intervalo entre tentativas (§6) |

## 3. Fatos verificados que moldaram o desenho

### 3.1 — O Drizzle expressa a instrução única, e ela não duplica sob concorrência

`db.update(t).set({ claimedUntil }).where(eq(t.id, <subselect com .for('update', { skipLocked: true }).limit(1)>)).returning()`
gera **uma** instrução:

```sql
update "t" set "claimed_until" = $1
where "t"."id" = (
  select "id" from "t"
  where dispatched_at is null and failed_at is null
    and (claimed_until is null or claimed_until <= $2)
  order by created_at limit $3 for update skip locked)
returning ...
```

Contra o Postgres de teste, 6 carteiros concorrentes sobre 60 linhas fizeram 60
claims, **60 linhas distintas** (9 a 11 cada); depois de tudo pego, um claim novo
devolveu 0 linhas; e três linhas cuja etiqueta foi vencida a mão voltaram a ser
pegas.

### 3.2 — O envio SMTP não tem limite hoje, e as opções o limitam

`smtpTransportOptions` não passa nenhum timeout, então valem os padrões do
nodemailer 9.1.1: 2 min para conectar, 30 s para a saudação e **10 min** de
inatividade no socket. Uma etiqueta de 2 min venceria com o envio ainda
pendurado, e outra execução reenviaria a mesma mensagem.

Medido: com `greetingTimeout: 1000` um servidor mudo é cortado em 1005 ms; com
`socketTimeout: 2000` um servidor que saúda e trava é cortado em 2004 ms.

### 3.3 — O estado atual

`DispatchOutboxMessagesUseCase.execute()` seleciona o lote uma vez e depois, por
linha, faz `send` e `markDispatched` ou `recordFailure`. `recordFailure` já é uma
única instrução condicional em SQL, correta sob concorrência. A entidade
`OutboxMessage` guarda o estado em campos `#` privados e não conhece a etiqueta.

## 4. Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Etiqueta com prazo por mensagem (`claimed_until`) | Independe do scheduler e do pooler; a recuperação de um carteiro que some é o vencimento da etiqueta, sem depender de uma conexão morrer |
| D2 | **Uma mensagem por viagem**, não um lote | A etiqueta só precisa cobrir um envio, e uma execução que some prende no máximo uma mensagem. Um lote exigiria uma etiqueta de `batchSize` envios (mais de uma hora no pior caso) ou venceria no meio do lote |
| D3 | A instrução única do §3.1 | Atômica, sem transação aberta durante o `send` |
| D4 | Falha **mantém** a etiqueta | Se fosse solta, o mesmo laço pegaria a mensagem de volta na hora (é a mais antiga) e gastaria as tentativas em segundos. O prazo da etiqueta vira o intervalo entre tentativas |
| D5 | A etiqueta não vai para a entidade | É detalhe de persistência. O mapper deixa de exigir a coluna (§5.3) em vez de inventar um literal |
| D6 | Timeouts explícitos no SMTP | Sem limite no envio, o prazo da etiqueta não é confiável (§7) |

## 5. O modelo

### 5.1 — Schema

`claimed_until timestamp with time zone`, **nulável e sem default**, como as
outras colunas de tempo: o instante vem do `IClock`. O índice parcial existente
(`created_at` onde `dispatched_at is null and failed_at is null`) continua
servindo; o filtro por etiqueta é residual. Migration gerada por
`pnpm db:generate --name=outbox_claimed_until`, em pasta nova (R4).

### 5.2 — O repositório

```ts
/**
 * Picks the oldest message that is pending and not currently claimed, sets its
 * `claimed_until`, and returns it — or null when there is none. One statement,
 * so two callers never receive the same row.
 */
claimNext(now: Date, leaseUntil: Date): Promise<OutboxMessage | null>
```

Sai `findPendingBatch`. O critério de "pendente e sem etiqueta vigente" é
`dispatched_at is null and failed_at is null and (claimed_until is null or
claimed_until <= now)`. FIFO por `created_at`.

O repositório em memória guarda as etiquetas num `Map<string, Date>` ao lado das
mensagens (a entidade não as carrega) e implementa a mesma regra. O comentário
dele, que diz "não modela lock de linha", passa a dizer que modela a etiqueta.

### 5.3 — O mapper

`toPersistenceOutboxMessage` devolve hoje `Omit<OutboxMessageRow, 'id'> & { id }`,
a linha inteira. Com a coluna nova o tipo exigiria `claimedUntil`, e a entidade
não tem o que informar. O retorno passa a excluir a coluna:
`Omit<OutboxMessageRow, 'id' | 'claimedUntil'> & { id }`. O `INSERT` a omite, e o
banco grava `NULL`: uma mensagem nasce sem etiqueta. `toDomainOutboxMessage`
ignora a coluna.

## 6. O laço do use case

```ts
for (let handled = 0; handled < this.batchSize; handled++) {
  const now = this.clock.now()
  const message = await this.outboxMessages.claimNext(
    now,
    new Date(now.getTime() + this.leaseMs),
  )
  if (message === null) break
  // send -> markDispatched, or recordFailure: exactly as today
}
```

`batchSize` continua sendo o teto de mensagens tratadas por execução. O
construtor ganha `leaseMs`, que o container converte de segundos como já faz com
a retenção das podas.

- **Sucesso:** `markDispatched`. A mensagem sai do conjunto de pendentes, então a
  etiqueta deixa de importar.
- **Falha do envio:** `recordFailure` conta a tentativa e **não toca a etiqueta**
  (D4). A mensagem só volta a ser pega quando a etiqueta vence, então o prazo
  serve de intervalo entre tentativas. Com o padrão de 120 s e
  `OUTBOX_DISPATCH_MAX_ATTEMPTS = 5`, uma mensagem que sempre falha desiste em
  cerca de 8 minutos.
- **Processo que some:** a etiqueta vence e outra execução assume. A mensagem
  pode ter sido enviada (§10).
- **Falha de infraestrutura** (o banco cai em `claimNext`, `markDispatched` ou
  `recordFailure`): propaga e derruba o `execute()`, como hoje. Uma mensagem já
  enviada cujo `markDispatched` falhou é reenviada depois do prazo.

## 7. O prazo e o transporte SMTP

`smtpTransportOptions` passa a incluir três constantes nomeadas:

| Opção | Valor | O que corta |
|---|---|---|
| `connectionTimeout` | 10 s | Conexão que não estabelece |
| `greetingTimeout` | 10 s | Servidor que conecta e não saúda |
| `socketTimeout` | 30 s | Servidor que trava no meio da conversa |

Isso limita uma conexão **parada**, não um servidor que responde devagar a cada
comando: dentro de cada resposta o `socketTimeout` reinicia. Por isso a etiqueta
tem folga sobre a soma dos três (50 s), e não é uma garantia estrita (§10).

O adapter também serve os caminhos de requisição (cadastro, reenvio de código).
Um SMTP pendurado passa a segurar uma requisição por 30 s em vez de até 10 min:
é uma mudança de comportamento fora do outbox, e é boa, mas é decisão registrada
na §11.

Um teste unitário garante que o padrão de `OUTBOX_DISPATCH_LEASE_SECONDS` é maior
que a soma dos três timeouts, para os dois números não se afastarem em silêncio.

## 8. Config

| Variável | Default | Nota |
|---|---|---|
| `OUTBOX_DISPATCH_LEASE_SECONDS` | 120 | Quanto a etiqueta vale. Precisa exceder o pior envio (§7); abaixo disso, duas execuções voltam a duplicar. `.positive()`, como as vizinhas |

Mora em `config.ts` do módulo `auth`, com as outras `OUTBOX_*`, e entra em
`.env.example`, na fixture `TEST_ENV` e no teste de defaults do `env.spec.ts`.

## 9. Testes

**Unidade**
- Repositório em memória: `claimNext` devolve a mais antiga (FIFO); ignora
  mensagens despachadas, falhadas e com etiqueta vigente; devolve `null` sem
  candidata; uma etiqueta vencida volta a ser pegável.
- Use case: para no primeiro `null`; respeita `batchSize`; sucesso chama
  `markDispatched`; falha chama `recordFailure` e não solta a etiqueta;
  **duas execuções entrelaçadas** (um enviador controlável, que deixa a segunda
  execução rodar enquanto a primeira está no meio do envio) nunca enviam a mesma
  mensagem duas vezes.
- `smtpTransportOptions` carrega os três timeouts; o padrão da etiqueta é maior
  que a soma deles.
- Mapper: a coluna de etiqueta não faz parte do `INSERT`.

**Integração** (Postgres real)
- Repositório: seis pegadores concorrentes sobre um conjunto de mensagens pegam
  cada uma exatamente uma vez; uma etiqueta vencida volta a ser pegável; despachada
  e falhada nunca voltam.
- **A prova do problema:** várias execuções concorrentes do
  `DispatchOutboxMessagesUseCase` sobre o mesmo repositório, com um enviador lento,
  e cada mensagem enviada exatamente uma vez. Antes desta fatia o teste falha.

## 10. Custos aceitos

1. **Uma execução que morre entre o `send` e o `markDispatched` reenvia** depois
   do prazo. Inerente a e-mail; a fatia elimina a duplicata por concorrência, não
   a por queda.
2. **O timeout não é um teto estrito.** Ele corta uma conexão parada, mas um
   servidor que responde devagar a cada comando pode passar de 120 s e a etiqueta
   vence com o envio em curso. Nesse caso outra execução reenvia.
3. **A etiqueta compara relógios de réplicas diferentes.** Quem pega grava
   `now + lease` pelo relógio da sua réplica, e quem verifica compara com o
   relógio da dele. Um desvio de segundos é irrelevante frente a 120 s; um desvio
   de minutos encurta ou alonga a etiqueta.
4. **Uma mensagem que derruba o processo antes do `recordFailure` nunca soma
   tentativas** e é retomada a cada vencimento. Igual a hoje.
5. **O intervalo entre tentativas passa de "a próxima execução do scheduler" para
   "o prazo da etiqueta".** Com um scheduler de 1 a 2 minutos, é o mesmo
   comportamento.
6. **Timeouts do SMTP valem para os caminhos de requisição também** (§7).
7. **O filtro por etiqueta é residual no índice parcial.** Mensagens que esperam
   o vencimento continuam no índice e são puladas pela consulta: irrelevante no
   volume de boilerplate.

## 11. Emendas de documentação

- [`DECISIONS.md`](../../DECISIONS.md): decisão 40, com o §4, o que foi recusado
  e por quê (advisory lock; `SKIP LOCKED` numa transação com o `send`), e os
  custos do §10.
- [`2026-09-15-transactional-outbox-design.md`](2026-09-15-transactional-outbox-design.md):
  §7 e §10 ganham uma emenda; o §6 tem o laço antigo, e continua como registro do
  desenho original.
- [`TODO.md`](../../TODO.md): riscar o item #2 e atualizar o cabeçalho.
- `dispatch-outbox-messages.ts` e o repositório em memória: comentários que
  descreviam o lote ou "nenhum lock" passam a descrever a etiqueta.

## 12. Próxima fatia

Item #3 da fila: notificar o dono quando a detecção de reuso de refresh dispara.
Com o outbox sem duplicidade por concorrência, ele é o primeiro consumidor natural
de um aviso que precisa sair uma vez só.
