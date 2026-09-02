# Handoff — Fatia 8: rate limiting no login

> Escrito em 2026-09-01, ao fim da fatia 7, para uma sessão que começa sem o
> contexto dela. O objetivo é te poupar de reaprender o que já foi decidido —
> **não** de reler as decisões. Elas são a autoridade.

## 1. O que esta fatia entrega

A única decisão em aberto do `DECISIONS.md` §6 que a auditoria classificou como
**"branco arquitetural, não wishlist"**. Hoje `POST /auth/login` aceita
tentativas de senha infinitas.

O `/auth/refresh` **não** tem o mesmo problema e não precisa da mesma proteção:
adivinhar 32 bytes de `randomBytes` não acontece. É o login que está aberto, e é
o login que tem senha humana do outro lado.

## 2. Leia primeiro, nesta ordem

1. `docs/DECISIONS.md` — a entrada de rate limiting no **§6**, que é o enunciado
   do problema. Leia também a **13** (taxonomia de erro), porque `429` não é
   nenhuma das sete categorias e isso é a primeira pergunta da fatia.
2. `docs/superpowers/specs/2026-08-27-login-design.md` **§14.3** — a política
   proposta, tabela de três linhas. E o §14 inteiro, que é curto e diz o que
   ficou de fora do login e por quê.
3. `docs/superpowers/specs/2026-08-29-unit-of-work-design.md` **§8** — a tabela
   do que não pode entrar no callback. A terceira linha, *"escrita que precisa
   sobreviver a uma falha"*, é sobre contador de brute force e **esta fatia é a
   primeira a exercê-la**.
4. `ARCHITECTURE.md` **§8** — as quatro coisas que não são da taxonomia, e o §11,
   *"Bibliotecas que falham em silêncio"*, que ganhou três armadilhas novas na
   fatia 7.

## 3. O que já está pronto e te espera

| Peça | Onde | Estado |
|---|---|---|
| Envelope de erro + `traceId` | `infra/http/errors/error-handler.ts` | o **único** lugar que conhece status HTTP |
| Taxonomia (sete categorias) | `shared/errors/app-error.ts` | `429` não cabe em nenhuma — ver §5 |
| `IClock` | `shared/ports/clock.ts` | injetado; toda janela de tempo testável |
| Logger compartilhado | `infra/observability/logger.ts` | `createLogger`, um por processo |
| `REDACT_PATHS` | `infra/observability/redact-paths.ts` | já cobre `password`, `token`, cookie |
| Auditoria de arquitetura | `.claude/skills/architecture-audit/` | `--base main`, e ela **pega comentário que mente** |
| Custo do argon2, medido | spec do login §14.3 | **7,3 ms e 19 MB por tentativa** |

Esse último número importa: o endpoint **não nasce nu**. O argon2 já é um freio.
Ele não substitui throttle — ataque distribuído ignora, e o próprio custo é vetor
de DoS — mas dimensiona a urgência com honestidade.

## 4. As restrições que esta fatia herda, e que não são óbvias

**O contador não pode viver dentro de uma transação.** É a terceira linha do §8
da fatia 4, e ela nunca tinha sido exercida até agora: um rollback apagaria
justamente o registro da falha que o contador existe para lembrar. Contador de
brute force é **autocommit por desenho**. O login hoje não abre transação
nenhuma — mantenha assim.

**`429` não é uma das sete categorias da taxonomia.** `TooManyRequestsError`
não existe, e criar uma oitava irmã é uma decisão, não um detalhe. Alternativa:
tratar como o `ARCHITECTURE.md` §8 já trata "4xx do próprio Fastify" — status
preservado, `code` do projeto. Ver §5.

**O login não pode virar oráculo de existência de conta.** Ele foi construído
com cuidado explícito para que e-mail inexistente e senha errada sejam
indistinguíveis — mesma classe, mesmo código, mesma mensagem, e um `dummyHash`
para o tempo de resposta bater. **Throttle por e-mail é exatamente onde isso
volta a vazar:** se o e-mail inexistente nunca é bloqueado e o existente é, a
diferença de resposta enumera contas. Há um teste que fixa a
indistinguibilidade — `answers an unknown email exactly like a wrong password`,
em `tests/integration/login.spec.ts`. Ele vai brigar com uma implementação
ingênua, e **está certo**.

**A política é por IP + e-mail, e os dois sozinhos falham.** Só IP pune NAT
corporativo e prédio inteiro atrás de um endereço; só e-mail permite ataque
distribuído por botnet. A spec do login já decidiu o par.

**`IClock` existe para a janela ser testável.** Não use `Date.now()` no contador
— a fatia inteira é sobre tempo, e sem o relógio injetado não há teste de
fronteira de janela.

## 5. Perguntas que a fatia precisa decidir, e que ficaram em aberto de propósito

- **`429` entra na taxonomia ou não?** Oitava categoria `TooManyRequestsError`
  em `shared/errors/`, ou ramo próprio no handler junto do 4xx do Fastify? A
  primeira é coerente com a decisão 13 e faz o mapa crescer; a segunda mantém as
  sete e trata rate limit como o que ele é — infra de transporte, não conceito de
  domínio. Note que o handler já tem precedente de ramo com header próprio: o
  `Retry-After` do `TransientError`, que `429` também quer.
- **`@fastify/rate-limit` ou implementação própria?** O plugin traz store,
  headers (`RateLimit-*`) e `Retry-After` prontos, ao custo de o formato de erro
  dele ter que ser dobrado no envelope do projeto. Escrever à mão é ~40 linhas e
  controle total. A decisão 13 avisa que o envelope é **contrato público**.
- **O throttle é middleware global ou colaborador do use case?** Global é
  transporte puro e não toca a camada pura; no use case ele é testável sem HTTP
  e serve worker/cron (decisão 10) — mas aí o use case ganha uma porta nova.
- **Bloqueio conta ou só atrasa?** Lockout temporário de conta é vetor de DoS
  contra usuário legítimo: quem souber o e-mail tranca a vítima de fora.
- **O contador conta tentativa falha, ou toda tentativa?** Contar sucesso também
  pune quem tem vários dispositivos legítimos.

## 6. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução. Vale repetir, mas duas práticas importam
mais que o formato:

**Verifique, não presuma.** Todo achado registrado nas specs foi obtido rodando.
Na fatia 7, **quatro** afirmações escritas em spec aprovada estavam erradas e só
caíram quando o código rodou — uma delas teria embarcado uma sessão roubada
viva. Uma foi minha sobre browsers: *"browsers treat localhost as a trustworthy
origin"*, no comentário onde alguém depurando ia cair. O Safari recusa.

**Falsifique todo teste.** Teste que nunca ficou vermelho não provou nada. A
fatia 7 falsificou sete: cada uma produziu vermelho no alvo previsto e em nenhum
outro. Uma delas revelou que o teste de concorrência HTTP **não** provava o
`SELECT ... FOR UPDATE` — ficava verde com o lock removido —, e a prova teve de
descer para o nível do repositório.

## 7. Estado do repositório

Branch `feat/refresh-token-rotation`, **26 commits** à frente da `main` contando
este arquivo, empurrada para `origin`. Não mergeada — a decisão de integração é
do dono.

`pnpm lint`, `typecheck`, `test` e `build` verdes; **299 testes**. Auditoria de
arquitetura em **0 achados** nos dois escopos. Postgres sobe com
`docker compose up -d`.

> ⚠️ **Duas armadilhas de ambiente que não são do repositório.** A store do pnpm
> mora sob a revisão do snap do VS Code, então `pnpm add` recusa depois que o
> snap atualiza — contorno é `--store-dir` apontando para a revisão de onde o
> `node_modules` está linkado. E `pnpm lint | tail -1` devolve o status do
> `tail`: rode cada portão sozinho e leia o exit code.

`docs/DECISIONS.md` **passou a ser rastreado** em 2026-09-01. Antes disso era
gitignored, e as emendas que cada fatia fazia nele não chegavam a review nem a
clone novo.

## 8. O roteiro de auth depois desta

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Troca de senha** | nada | dá gatilho ao `logout-all`, que foi entregue **sem consumidor**; é o primeiro use case a escrever em `users` **e** `refresh_tokens` na mesma transação — o caso que `AuthRepos` carrega os dois para servir |
| **Verificação de e-mail** | provedor de e-mail | destrava `emailVerifiedAt`, assento reservado em cinco arquivos e sempre `null`; e é a primeira vez que *"persista dentro, envie depois do commit"* sai do papel — e-mail dentro do callback com retry de deadlock **envia duas vezes** |
| **Recuperação de senha** | verificação de e-mail | reusa `ITokenGenerator` e `ITokenDigest` **como estão** |
| **Poda de `refresh_tokens`** | entrypoint `cron.ts` | a tabela cresce sem limite hoje |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |

A ordem recomendada é essa. **Troca de senha é a menor** e fecha um laço já
construído; verificação de e-mail é a cara, porque traz o provedor de e-mail, e
com ele a recuperação fica barata.

**Uma decisão de produto continua sem dono**, registrada no §6: a sessão não tem
teto absoluto. Os 60 dias são deslizantes, então quem der refresh toda semana
nunca reautentica. Não é furo — rotação e detecção de reuso cobrem roubo —, mas
ninguém decidiu.
