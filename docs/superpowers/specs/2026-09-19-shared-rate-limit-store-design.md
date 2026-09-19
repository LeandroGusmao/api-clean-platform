# Fatia 22 — Store de rate limit compartilhado no Redis, com escopo por rota

## 1. Objetivo

Fechar o item #1 de "Pendências do boilerplate" do [`TODO.md`](../../TODO.md): o
contador do limitador vive na memória de cada processo, então com N réplicas o
teto efetivo do login é N × 10/min, e nenhuma réplica faz nada errado.

O ataque não exige esperteza. O balanceador já reparte as requisições entre as
réplicas, então um único endereço de origem recebe N baldes de graça. E o teto
por endereço não é acessório neste projeto: como o `DECISIONS.md` §6 recusou o
bloqueio de conta por tentativas erradas, o teto por endereço e o custo do
argon2 são as duas únicas defesas contra chute de senha. Multiplicar uma delas
por N corta metade do que sobrou.

A entrega: as rotas que **declaram o próprio teto** passam a contar num Redis
compartilhado por todas as réplicas. O teto global segue por processo.

## 2. Escopo

### Entra

- `createRedis(env)` e as variáveis `REDIS_*`.
- Um store nosso para o `@fastify/rate-limit`, com o contador do teto global em
  memória e o das rotas com teto próprio no Redis.
- O erro `RateLimitStoreUnavailableError` (`TransientError`) e o log dele.
- O check de Redis no `/health`, **apenas informativo**.
- Serviços `redis` e `redis-test` no `docker-compose.yml` e no `ci.yml`.
- Decisão 39 no `DECISIONS.md` e as emendas da §12.

### Não entra, e por quê

| Item | Por quê |
|---|---|
| Fallback para memória quando o Redis cai | A rota sensível **recusa**. Contar em memória durante a queda reintroduz o N× exatamente quando ninguém está olhando |
| Contagem de falha por conta / lockout | Decisão do `DECISIONS.md` §6, intocada por esta fatia |
| `ban`, `continueExceeding` e `exponentialBackoff` do plugin | Não usamos; o script Lua não os implementa |
| Cluster, Sentinel | TLS e senha cabem na própria `REDIS_URL` (`rediss://`); topologia é de quem opera |
| Passar o `store` pela `config` de cada rota | O plugin ignora (§3.1) |

## 3. Fatos verificados que moldaram o desenho

### 3.1 — O plugin já separa os dois grupos, e ignora `store` na rota

Em `@fastify/rate-limit` 11.2.0, rota **sem** `config.rateLimit` usa o store
global diretamente. Rota **com** `config.rateLimit` objeto recebe
`store.child(paramsMesclados)`. Um `store` colocado na config da rota entra na
mesclagem e **nunca é lido**: o store da rota sai sempre do `child` do global.

Consequência: o caminho para dar contadores diferentes a grupos diferentes é o
`child`, e nenhum módulo precisa receber o Redis. A regra é "quem declara o
próprio teto usa o Redis", decidida pelo plugin, e não uma lista de URLs.

### 3.2 — O handler não loga `TransientError`

O [`error-handler.ts`](../../../src/infra/http/errors/error-handler.ts) mapeia
`TransientError` para 503 com `Retry-After`, mas só loga o que tem
`securityEvent === true`. Sem tratamento, uma queda do Redis viraria 503 sem
uma linha de log — a falha silenciosa que o fail-closed existe para evitar.

### 3.3 — Sem `exports`, o `LocalStore` é alcançável por caminho interno

O pacote declara só `main`. `@fastify/rate-limit/store/LocalStore.js` resolve,
mas não é API pública (§11.4).

### 3.4 — A medir na implementação, não assumido

O comportamento padrão do `ioredis` sem cliente conectado (fila de espera e
retentativas) **não foi medido**. A spec parte do que se sabe da biblioteca e o
plano tem uma tarefa que mede antes de fixar os números da §6.

## 4. Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Redis como store compartilhado | Postgres traria toda enxurrada anônima para a primária; dividir o teto por réplica quebra quando o número de réplicas muda |
| D2 | **Fail-closed** nas rotas com teto próprio | Numa rota de senha, degradar para "sem teto" é o pior lugar; e sem teto cada tentativa custa um argon2 (7,3 ms, 19 MB), o que expõe a CPU |
| D3 | Teto global **em memória**, por réplica | Tira a ida ao Redis das rotas comuns e evita que manutenção do Redis derrube a API inteira |
| D4 | Store próprio, com script Lua próprio | O erro precisa virar `TransientError`; o `RedisStore` do plugin não é exportado e traz recursos que não usamos |
| D5 | Cliente `ioredis`, versão exata | Convenção do projeto; `defineCommand` cobre o script |
| D6 | O erro é `securityEvent = true` | É o mecanismo existente (decisão 15) para tornar um controle de segurança indisponível visível no log |
| D7 | `/health` mostra o Redis mas **não** decide o 503 | Se ficasse vermelho, o orquestrador tiraria todas as réplicas de circulação e a API inteira cairia |

## 5. Componentes

```text
src/infra/redis/client.ts                          createRedis(env) -> Redis
src/infra/http/rate-limit-store.ts                 store escopado (memória + Redis)
src/infra/http/rate-limit-store-unavailable-error.ts
src/infra/health/checks/redis-check.ts             mesmo molde de database-check.ts
```

`buildApp` chama `createRedis(env)` e registra `onClose` com `quit()`, como faz
com o pool do Postgres.

### O store escopado

Uma classe fábrica recebe o cliente e devolve o construtor que o plugin espera
em `store`:

- `incr` (rotas **sem** teto próprio) delega ao `LocalStore` do plugin.
- `child(params)` (rotas **com** teto próprio) devolve um store de Redis cujo
  prefixo de chave é `<prefixo>:<método>:<url>-`, para o balde ser por rota,
  como no store em memória de hoje.
- O store de Redis executa um único script:

```lua
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
```

Atômico de propósito: `INCR` e `PEXPIRE` em comandos separados, com uma queda
no meio, deixariam uma chave sem validade e aquele endereço bloqueado para
sempre. O `ttl < 0` também cura uma chave que já tenha perdido o prazo.

Qualquer erro do cliente vira `RateLimitStoreUnavailableError`, **sem `cause`**,
pelo mesmo motivo do `TransactionConflictError`: o serializador do pino
concatena a cadeia de causas, e o erro do driver pode carregar o endereço do
servidor.

`registerRateLimit(app, env, redis?)`: o terceiro parâmetro é opcional. Sem ele
o plugin usa a memória e o [`rate-limit.spec.ts`](../../../src/infra/http/rate-limit.spec.ts)
continua subindo um servidor sem Redis. O tipo estreito `RateLimitEnv`
(decisão 23) não muda.

## 6. Configuração

| Variável | Default | Nota |
|---|---|---|
| `REDIS_URL` | nenhum (obrigatória) | Sem default, como `DATABASE_URL`: dois deploys não devem compartilhar um Redis por acidente |
| `REDIS_CONNECT_TIMEOUT_MS` | 1000 (inicial) | Valor a confirmar na medição da §3.4 |
| `REDIS_COMMAND_TIMEOUT_MS` | 250 (inicial) | Idem. Precisa ser bem menor que o timeout de requisição, senão o fail-closed vira requisição pendurada |

O cliente sobe com a fila de comandos offline **desligada**: comando sem
conexão falha na hora em vez de esperar, e é isso que faz a recusa ser rápida.
A reconexão automática continua ligada, com intervalo limitado, para recuperar
sozinha ao fim de uma manutenção.

## 7. O 503 e o log

Falha do store → `RateLimitStoreUnavailableError` (`TransientError`,
`securityEvent = true`, `code = RATE_LIMIT_STORE_UNAVAILABLE`) → 503 com
`Retry-After`, pelo mapeamento que já existe no `error-handler.ts`, sem
alteração nele. O `securityEvent` faz o handler emitir um `warn` com o `code`.

Só as rotas com teto próprio chegam aqui. As outras não tocam o Redis.

## 8. `/health`

Ganha um campo `redis: 'up' | 'down'`, alimentado por um `PING` com o timeout de
comando. **O status HTTP continua dependendo só do banco.** O `PING` não pode
demorar mais que o timeout de comando, para não segurar a probe.

## 9. Infra

- `docker-compose.yml`: `redis` (volume) e `redis-test` (`tmpfs`, porta própria
  em `127.0.0.1`), imagem com versão exata, no molde de `postgres` e
  `postgres-test`.
- `ci.yml`: serviço equivalente ao de `redis-test`.
- `REDIS_URL` em `.env.example`, `vitest.config.ts` (fixture, R6) e no CI.

**Arranque.** Com a fila offline desligada, um comando emitido antes de a
conexão ficar pronta falha. `buildApp` aguarda o `ready` limitado pelo timeout
de conexão; se não vier, **segue** e loga um `warn`: o serviço sobe em
fail-closed nas rotas sensíveis, em vez de recusar subir.

## 10. Testes

**Unidade**
- Store de Redis com cliente falso: incremento devolve `{ current, ttl }`; o
  balde é por rota; toda falha vira `RateLimitStoreUnavailableError`, sem
  `cause`.
- Store escopado: `incr` vai à memória; `child` vai ao Redis.

**Integração** (Redis real, `redis-test`)
- **A prova do problema:** duas instâncias de `buildApp` sobre o mesmo Redis;
  dez logins repartidos entre elas, e o 11º leva 429 em qualquer uma. Antes
  desta fatia o teste falha.
- **Resiliência:** app apontado para uma porta morta. Login responde 503 com
  `Retry-After`, dentro do orçamento de timeout; uma rota de produto responde
  200; o `warn` do evento aparece no log.
- O teto global continua por réplica (garante que o `LocalStore` interno segue
  resolvendo após uma troca de versão do plugin).
- `/health` com Redis morto: 200, `redis: 'down'`.

## 11. Custos aceitos

1. **O teto global é N×.** 300/min com 3 réplicas são 900/min. Não é o teto que
   defende contra chute, é uma rede de segurança grossa.
2. **As nove rotas com teto próprio caem juntas** quando o Redis cai: login,
   cadastro, confirmação e reenvio de e-mail, esquecer e redefinir senha,
   trocar senha, deletar conta e Google. É a consequência escolhida do D2.
3. **Um `warn` por requisição bloqueada** durante a queda. Ruído aceito em troca
   de a queda ser visível.
4. **Importação de um arquivo interno do plugin** (`LocalStore`). A alternativa é
   reescrever um contador com despejo. A versão do plugin é fixa e o teste da
   §10 quebra se uma troca de versão o remover.
5. **Uma ida de rede a mais** nas nove rotas.
6. **O endereço do cliente fica no Redis** pelo tempo da janela. É dado pessoal,
   com validade de segundos.
7. **A premissa que sustenta o fail-closed**: o Redis é gerenciado por quem
   opera o app, e cai só em manutenção programada. **Reabre a decisão** um
   app derivado num ambiente onde o Redis não seja confiável, ou que exija
   disponibilidade de login acima da proteção contra chute: aí a opção é
   fail-open por rota, com alerta.

## 12. Emendas de documentação

- [`DECISIONS.md`](../../DECISIONS.md): decisão 39, com a premissa do item 7.
- [`TODO.md`](../../TODO.md): riscar o item #1 e atualizar o cabeçalho.
- [`2026-09-02-rate-limiting-design.md`](2026-09-02-rate-limiting-design.md)
  §10.2: o store por processo passa a valer só para o teto global.
- `rate-limit.ts`: remover o parágrafo "The store is in-process".
- `STRUCTURE.md`: os arquivos novos da §5.

## 13. Próxima fatia

Item #2 da fila: o dispatch do outbox sem trava. É o vizinho natural: também é o
boilerplate deixando de cumprir uma promessa na segunda réplica.
