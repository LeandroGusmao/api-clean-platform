# Handoff — Fatia 7: refresh token rotativo

> Escrito em 2026-08-30, ao fim das fatias 4, 5 e 6, para uma sessão que começa
> sem o contexto delas. O objetivo deste arquivo é te poupar de reaprender o que
> já foi decidido — **não** de reler as decisões. Elas são a autoridade.

## 1. O que esta fatia entrega

A decisão 11 inteira: `POST /auth/refresh` com rotação, janela de graça de 30s,
detecção de reuso revogando a família, trava de linha, e `logout`. É a maior
fatia restante do projeto, e a própria spec do login (§3) avisa que *"errar a
rotação é bug de segurança sutil"*.

## 2. Leia primeiro, nesta ordem

1. `docs/DECISIONS.md` — decisões **11** (auth) e **12** (transporte). São a
   autoridade da fatia. Leia também as emendas recentes em **13**, **15**, **21**
   e **22**, que mudaram o terreno.
2. `docs/superpowers/specs/2026-08-29-unit-of-work-design.md` — a primitiva de
   atomicidade que a rotação consome. O §4 explica por que aninhar transação é
   proibido, e o §8 lista o que não pode entrar no callback.
3. `docs/superpowers/specs/2026-08-30-connection-limits-design.md` §4 — a
   aritmética de pool, e o `lock_timeout` de 5s que a rotação vai encontrar.
4. `docs/superpowers/specs/2026-08-30-transient-failures-design.md` §3 e §5 — o
   retry de deadlock que roda **por baixo** da rotação, e o `TransientError`.
5. `ARCHITECTURE.md` §11 "Bibliotecas que falham em silêncio" — três armadilhas
   já pagas uma vez.

## 3. O que já está pronto e te espera

| Peça | Onde | Estado |
|---|---|---|
| Unit of Work | `container.auth.uow` | **publicado e sem nenhum consumidor** — você é o primeiro |
| `TransactionRunner` | `infra/database/transaction-runner.ts` | com guarda de aninhamento e retry de `40P01`/`40001` |
| `AuthRepos` | `modules/auth/repositories/unit-of-work.ts` | um repositório só; cresce com o seu |
| `authRepositories` | `modules/auth/infra/drizzle/auth-repositories.ts` | **o único arquivo** que conhece o conjunto |
| Limites de conexão | `infra/database/client.ts` | pool, statement/lock/idle timeouts por env |
| `TransientError` → 503 | `shared/errors/app-error.ts` | sétima categoria, com `Retry-After` |
| Logger compartilhado | `infra/observability/logger.ts` | `createLogger`, um por processo |

Acrescentar `refreshTokens` custa **um tipo e uma fábrica** — foi o que a fatia 4
existiu para tornar barato.

## 4. As restrições que a rotação herda, e que não são óbvias

**O callback do `uow` pode rodar mais de uma vez.** O runner retenta deadlock
sozinho. Consequência dura: nada de I/O externo, nada de argon2 e nada de escrita
que precise sobreviver a uma falha dentro do callback — um e-mail enviado lá
dentro seria enviado duas vezes. A tabela está no §8 da spec do UoW.

**Use case que recebe o `uow` não recebe repositório direto.** O singleton
injetado escreve em conexão autocommit; chamá-lo dentro do callback compila,
passa no teste unitário e quebra a atomicidade em produção.

**`token_hash` é sha256, nunca argon2.** A decisão 11 explica: argon2 usa salt
aleatório, então `WHERE token_hash = ?` nunca casaria e a busca degeneraria em
varrer a tabela rodando argon2 por linha — vetor de DoS de CPU num endpoint de
alta frequência.

**Não use `defaultNow()` em coluna que a rotação compara.** O Postgres guarda
`timestamptz` em microssegundos e o `Date` do JS tem milissegundos; a decisão 11
registra a assimetria. `IClock` preenche `expires_at`, `revoked_at` e
`created_at`.

**O endpoint precisa declarar `503`.** Isso é novo e a decisão 11 é anterior a
ele: como a rotação usa o `uow`, ela pode produzir `TransientError` quando o
retry se esgota. O §7 do `ARCHITECTURE.md` exige que todo endpoint declare todo
status que ele mesmo produz — e hoje **nenhum** endpoint declara 503, porque até
agora nenhum podia produzi-lo.

## 5. Perguntas que a fatia precisa decidir, e que eu deixei em aberto de propósito

- **O token opaco é gerado dentro ou fora do callback?** Gerado fora, um retry
  reusa o mesmo valor; gerado dentro, cada tentativa cria um e só o commitado
  sobrevive. Os dois funcionam. O §8 do UoW empurra para fora ("calcula antes"),
  mas `randomBytes(32)` é microssegundos — o argumento de custo não decide, e o
  de clareza pode decidir ao contrário.
- **`logout-all` entra?** O gatilho real dele é troca de senha, que não existe.
- **A rotação quer `lock_timeout` próprio?** O default de conexão é 5s. Esperar
  5s por uma linha de refresh token provavelmente é longo demais.
- **`55P03` no endpoint.** Ele já é `TransientError`, mas a rotação é onde ele
  passa a ser alcançável de verdade.

## 6. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução. As fatias 4 a 6 seguiram isso e vale
repetir, mas duas práticas importam mais que o formato:

**Verifique, não presuma.** Todo achado registrado nas specs foi obtido rodando
— lendo o fonte do Drizzle, do `pg`, do Fastify. Três afirmações minhas
*escritas numa spec aprovada* estavam erradas e só caíram quando o código rodou.

**Falsifique todo teste.** Um teste que nunca falhou não provou nada. Quebre a
fiação de propósito, confirme quais casos ficam vermelhos, restaure. Foi assim
que o teste de isolamento do UoW e o de deadlock ganharam dente — e foi assim
que se descobriu que a primeira guarda de aninhamento derrubava o processo.

## 7. Estado do repositório

`main`, limpa e sincronizada com `origin` até `dda2e00`. Há dois commits locais
de documentação depois disso. `pnpm lint`, `typecheck`, `test:unit` e
`test:integration` verdes — 214 testes. Postgres sobe com `docker compose up -d`.
