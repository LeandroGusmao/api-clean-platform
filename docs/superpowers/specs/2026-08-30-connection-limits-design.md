# Fatia 5 — Pool e timeouts de conexão

> **Status:** desenho aprovado em 2026-08-30, pronto para implementação.
> **Fatia anterior:** [`2026-08-29-unit-of-work-design.md`](2026-08-29-unit-of-work-design.md)
> **Consome as decisões:** 05 (Postgres), 06 (Drizzle), 14 (env por módulo), 22 (atomicidade)
> **Tamanho:** fatia *bounded* — cinco variáveis e um repasse. A spec existe pelo
> que ela **registra**, não pelo que ela desenha: a aritmética do §4 é o que
> decide topologia de deploy, e não cabe num comentário de código.

## 1. Objetivo

A fatia 4 tornou `db.transaction` alcançável pela primeira vez, e isso muda o
caráter de uma conexão: ela deixa de ser retida pela duração de uma **query** e
passa a ser retida pela duração de um **callback**.

Com os defaults de hoje isso é perigoso em três frentes ao mesmo tempo:

- `client.ts` não define `max`, então o pool tem as **10 conexões** default do
  `pg`. Dez transações simultâneas saturam a API inteira — health check e login
  incluídos, porque disputam as mesmas vagas.
- `statement_timeout`, `lock_timeout` e `idle_in_transaction_session_timeout`
  estão todos em `0` (desligados, default do Postgres). Um callback que trave —
  rede pendurada, promise que nunca resolve — segura conexão **e locks** para
  sempre, e nada quebra o impasse.
- Nada disso é ajustável sem editar código.

Esta fatia põe os cinco limites, todos por ambiente.

## 2. Escopo

### Entra

- `DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT_MS`,
  `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS` e
  `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` no schema core (decisão 14).
- Repasse em `createDatabase`, mais `application_name` (§6).
- `.env.example` e os testes do §8.

### Não entra, e por quê

- **Retry de `40P01`, `TransientError`, resposta 503** — fatia 6. São
  tratamento de falha transitória, assunto diferente de limite de conexão.
- **Logger standalone** — fatia 6, onde o retry precisa dele para não ser
  silencioso.
- **`lock_timeout` sobrescrito por transação.** Aqui ele nasce como default de
  conexão. A rotação de refresh token pode querer um valor próprio, e isso chega
  com ela.
- **Pooler externo (PgBouncer, RDS Proxy, Supavisor).** É decisão de deploy, não
  de código. O §4 documenta quando ele passa a ser obrigatório e o que o
  boilerplate já faz certo para ser compatível.
- **`max` por instância calculado dinamicamente.** Exigiria a aplicação saber
  quantas réplicas existem, que é conhecimento do orquestrador.

## 3. As cinco variáveis

Todas em `coreEnvSchema`: banco é infra global sem dono, então não pertencem ao
schema de módulo nenhum.

| Variável | Default | Por quê esse valor |
|---|---|---|
| `DATABASE_POOL_MAX` | `10` | É o próprio default do `pg`. Subir aqui é a alavanca errada — ver §4. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Já é o valor fixo de hoje; entra só para o conjunto ficar uniforme e ajustável. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `10000` | Query de API que passa de 10s já é requisição perdida; o cliente desistiu antes. |
| `DATABASE_LOCK_TIMEOUT_MS` | `5000` | **Metade** do statement, de propósito: quem espera lock demais falha com `55P03` (`lock_not_available`), que nomeia o problema, em vez de `57014` genérico. |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `10000` | A rede contra callback travado. O §8 da fatia 4 proíbe I/O dentro da transação, então toda transação legítima é sub-segundo — 10s é folga larga e ainda assim finito. |

Os defaults servem desenvolvimento e são **conservadores de propósito**.
Produção afina, e a instrução de como afinar é o §4.

## 4. A aritmética que decide a topologia

É a seção que justifica a spec existir. O instinto ao ver "10 conexões" é subir
o número; num sistema de escala global isso é a alavanca errada, porque o custo
é **multiplicativo pelo número de instâncias**:

```
instâncias × DATABASE_POOL_MAX  ≤  max_connections − reserva
```

Com os defaults do Postgres — `max_connections` 100, 3 reservadas para
superuser — **9 instâncias × 10 já flerta com o teto**. Vinte instâncias com
`max` 50 pedem 1000 conexões e o servidor recusa.

E conexão do Postgres não é thread: cada uma é um **processo backend**, com
memória própria e contenção em estruturas compartilhadas. Passado o ponto em
que os cores do banco saturam, aumentar o pool só troca "fila no app" por
"thrash no banco" — pior, porque o banco é compartilhado entre todas as
instâncias enquanto a fila é local.

**Onde a resposta deixa de ser esta fatia.** Quando `instâncias × max` encosta
no teto, a saída é um **pooler em transaction mode** entre app e Postgres, com
pool modesto por instância. E aqui o boilerplate já está do lado certo, por
acidente feliz:

> **Verificado em `drizzle-orm@1.0.0-rc.4`, `node-postgres/session.js:39`:**
> `queryName` só é definido quando alguém pede `.prepare()` explicitamente. Por
> default o Drizzle manda **prepared statements anônimos**, que é exatamente o
> que sobrevive a um pooler em transaction mode.
>
> **A armadilha que isso cria:** quem "otimizar" uma query com `.prepare()` um
> dia quebra o pooler, e a falha aparece longe da causa. Se o `.prepare()` for
> necessário, o pooler precisa sair de transaction mode — ou a query volta a ser
> anônima.

## 5. String vazia não pode desligar a rede de segurança

`z.coerce.number()` transforma `''` em `0`, e para os três timeouts do Postgres
`0` significa **desligado**. Então um `DATABASE_STATEMENT_TIMEOUT_MS=` largado
num `.env` — alguém apagou o valor e não notou — desligaria a proteção em
silêncio. Falha **aberta**, que é a pior direção.

O projeto já conhece essa classe de bug e já escolheu como tratá-la: o teste
`rejects an empty PORT instead of coercing it to zero`, em `env.spec.ts`, é
exatamente isso. Esta fatia segue o precedente em vez de inventar outro.

**Comportamento exigido, nas três entradas:**

| Entrada | Resultado |
|---|---|
| variável ausente | default da tabela do §3 |
| variável vazia (`VAR=`) | **erro no boot**, junto das demais violações (decisão 14) |
| `VAR=0` explícito | aceito — **não** sobrescreve; deixa valer o que o servidor já tem |

O `0` explícito precisa continuar válido, mas o que ele significa **não** é o
que parece:

> **Verificado em `pg@8.23.0`, `lib/client.js:558-566`:** os três timeouts são
> enviados sob `if (params.x)` — checagem de veracidade. Um `0` é falsy, então o
> driver simplesmente **não manda o parâmetro**, e o valor que vale passa a ser o
> do servidor. Num Postgres vanilla isso coincide com "desligado", porque o
> default do servidor é 0. Num Postgres gerenciado cujo parameter group defina
> `statement_timeout = 30s`, quem configurar `0` esperando desligar fica com 30s.
>
> A semântica honesta de `0` é portanto **"não sobrescrever"**, e é assim que ela
> está documentada no código e na mensagem de erro. É até útil — dá uma forma de
> deixar a política inteira a cargo da infraestrutura —, mas seria uma armadilha
> se documentada como "desliga".

O que não pode, em nenhuma das duas leituras, é isso acontecer **por acidente**
com um valor em branco.

> **Descartado — tratar vazio como ausente e aplicar o default.** Mais
> tolerante, e erra por segurança em vez de por perigo. Perdeu por contradizer o
> `PORT` na mesma tela: duas variáveis do mesmo arquivo se comportando
> diferente diante da mesma entrada é pior do que qualquer uma das duas
> escolhas isoladamente.

## 6. O repasse, e o `application_name`

Verificado em `@types/pg` (linhas 21-51): `max`, `statement_timeout`,
`lock_timeout`, `idle_in_transaction_session_timeout` e `application_name` são
opções **nativas** de config do `pg`. Nenhum `SET` manual, nenhum hook de
conexão, nenhuma dependência nova — o driver as envia no startup da conexão.

O `application_name` não estava no pedido original e entra por um motivo
prático: sem ele, toda conexão aparece em `pg_stat_activity` como
`node-postgres`. Com ele, a consulta que diagnostica exatamente a exaustão de
pool que esta fatia previne fica legível — dá para ver quais conexões são desta
API e quais são de migration, seed ou psql. É uma linha, e é o que torna as
outras cinco depuráveis.

Valor: o nome da aplicação, constante. **Não** varia por instância: identificar
réplica é trabalho de `hostname` no log, e um `application_name` por réplica
quebraria justamente o agrupamento que torna a consulta útil.

## 7. Onde estes timeouts não chegam

Verificado, porque um `statement_timeout` que matasse migration seria um
desastre silencioso:

- `drizzle.config.ts` monta a conexão a partir de `dbCredentials`, própria e
  separada.
- `tests/integration/setup/migrate-test-database.ts` monta o próprio `new Pool`.

Nenhum dos dois passa por `createDatabase`. **Migration nunca é atingida** — nem
local, nem em CI. Só conexões da aplicação recebem os limites, que é o que se
quer: uma migration longa é normal, uma query de API longa não é.

## 8. Testes

### Unitário — `src/infra/config/env.spec.ts`

Estende o arquivo que já existe, seguindo o caso do `PORT`:

1. **defaults aplicados quando as cinco estão ausentes** — pega um default
   escrito errado.
2. **variável vazia é rejeitada** — o §5, o caso que falha aberto se passar.
3. **`0` explícito é aceito** — prova que a rejeição do vazio não custou a
   capacidade de desligar de propósito.
4. **valor negativo é rejeitado**.

### Integração — o teste que pega a falha silenciosa

O risco real não é errar o nome da opção — essas cinco são propriedades tipadas
do `PoolConfig`, e o compilador pega um typo. É a opção ser aceita pelo driver e
**não chegar à sessão**: um pooler na frente que descarte parâmetros de startup,
uma mudança de comportamento do `pg`, um `DATABASE_URL` que já traga
`?options=` conflitante. Nesses casos o sistema fica sem timeout achando que
tem, e nenhum teste de unidade nota. Um teste que dorme para provar que o
timeout dispara seria lento e frágil; um que **pergunta ao banco** é rápido e
direto:

```sql
select current_setting('statement_timeout'),
       current_setting('lock_timeout'),
       current_setting('idle_in_transaction_session_timeout'),
       current_setting('application_name')
```

Sobre uma conexão vinda de `createDatabase`, conferindo que os quatro chegaram à
sessão. Uma ida ao banco, determinístico, e é a única forma de distinguir
"configuramos" de "está em vigor".

## 9. Custos aceitos

- **Cinco variáveis a mais na superfície de configuração.** Um `.env` mínimo
  continua funcionando — todas têm default —, mas a lista do `.env.example`
  cresce e passa a exigir leitura.
- **Defaults conservadores exigem afinação em produção.** Deliberado: um default
  generoso esconde o problema até a escala em que ele é caro. A aritmética do §4
  é a instrução, e ela mora na spec, não no `.env.example`.
- **`application_name` fixo.** Não distingue réplicas (§6).
- **`idle_in_transaction_session_timeout` mata a conexão, não só a transação.**
  Quando dispara, o `pg` perde aquela conexão e reconecta. É o comportamento do
  Postgres, não uma escolha — mas quem ler um erro de conexão perdida logo após
  uma transação lenta precisa saber que a causa pode ser esta.

## 10. Emendas de documentação

- **`ARCHITECTURE.md` §6 (Banco de dados)** — a aritmética do §4 e a armadilha
  do `.prepare()`. É o lugar onde quem for dimensionar deploy vai procurar.
- **`.env.example`** — as cinco, com os defaults como valor.
- **Decisão 05** — nota curta apontando para esta spec quanto a limites de
  conexão. A decisão em si não muda: o banco continua sendo Postgres.

## 11. Próxima fatia

**Fatia 6 — falha transitória:** logger standalone extraído do Fastify
(`loggerInstance`, verificado disponível no Fastify 5), retry de `40P01` e
`40001` dentro do runner com logging por tentativa, `TransientError` como
sétima categoria da taxonomia da decisão 13, e resposta `503` com `Retry-After`.

O `55P03` (`lock_not_available`), que o `DATABASE_LOCK_TIMEOUT_MS` desta fatia
passa a tornar possível, entra na mesma classificação transitória — e é mais um
motivo para as duas fatias ficarem nesta ordem.
