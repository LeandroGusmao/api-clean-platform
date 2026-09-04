# Handoff — Fatia 9: troca de senha

> ⚠️ **Corrigido em 2026-09-03 pela fatia que ele descreve.** Três afirmações
> deste documento foram medidas e refutadas — o `$onUpdate` do §4.1, o
> trade-off da sessão preservada no §5 e o estado do repositório no §7. As
> medições estão no §3 de
> [`specs/2026-09-03-password-change-design.md`](specs/2026-09-03-password-change-design.md).
> Leia aquela seção antes de agir sobre qualquer parte deste handoff.

> Escrito em 2026-09-03, ao fim da fatia 8, para uma sessão que começa sem o
> contexto dela. O objetivo é te poupar de reaprender o que já foi decidido —
> **não** de reler as decisões. Elas são a autoridade.

## 1. O que esta fatia entrega

`POST /auth/password` (ou o nome que a fatia decidir): o usuário autenticado
troca a própria senha, apresentando a senha atual.

Ela foi escolhida como próxima por ser **a menor que fecha um laço já
construído**: o `logout-all` foi entregue na fatia 7 **sem nenhum consumidor**,
e trocar a senha é o gatilho natural dele.

É também **o primeiro use case a escrever em `users`** — e isso importa mais do
que parece; ver o §4.

## 2. Leia primeiro, nesta ordem

1. `docs/superpowers/specs/2026-08-29-unit-of-work-design.md` **§8** — a tabela
   do que não pode entrar no callback. As duas primeiras linhas (**I/O externo**
   e **CPU pesada — argon2**) governam o desenho inteiro desta fatia.
2. `docs/DECISIONS.md` **11** — revogação, e por que um access token já emitido
   sobrevive à troca de senha por até 1h.
3. `docs/superpowers/specs/2026-08-27-login-design.md` **§15.1** — o teste que
   protege a equalização de timing. A mesma lição (*assertar a chamada, não só o
   resultado*) se aplica aqui.
4. `ARCHITECTURE.md` **§11**, *"Bibliotecas que falham em silêncio"* — ganhou
   duas armadilhas novas na fatia 8, e você vai encontrar uma terceira (§4).

## 3. O que já está pronto e te espera

| Peça | Onde | Estado |
|---|---|---|
| `LogoutAllUseCase` | `use-cases/logout-all.ts` | pronto, **sem consumidor** — é o laço que esta fatia fecha |
| `IAuthUnitOfWork` | `repositories/unit-of-work.ts` | carrega `users` **e** `refreshTokens` na mesma transação |
| `revokeAllForUser` | `repositories/refresh-tokens-repository.ts` | pronto |
| `IHashProvider` | `ports/hash-provider.ts` | `hash` e `compare`, argon2id medido em 7,3 ms / 19 MB |
| Guard de autenticação | `infra/http/auth-guard.ts` | `preHandler: guard` + `getPrincipal` |
| Teto de rate limit por rota | `infra/http/rate-limit.ts` | **uma linha** — `config: { rateLimit: {...} }` |
| Auditoria de arquitetura | `.claude/skills/architecture-audit/` | `--base main`; pega comentário que mente |

## 4. As três armadilhas que esta fatia é a primeira a encontrar

### 4.1 — `$onUpdate` vai sobrescrever o seu `IClock`, em silêncio

`infra/drizzle/schema/users.ts` declara:

```ts
updatedAt: timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date()),
```

**Não existe nenhum `UPDATE` em `users` hoje** — verificado em 2026-09-03. Esta
fatia é a primeira a disparar esse `$onUpdate`, e ele chama `new Date()` do
relógio do sistema. Ou seja: o `updatedAt` que o seu use case calcular pelo
`IClock` injetado **será descartado** e substituído pelo relógio real, sem erro
e sem aviso.

O sintoma é cruel: em produção ninguém nota, porque os dois relógios coincidem.
Quem nota é o **teste** que avança um relógio falso e assere o `updatedAt` — ele
fica vermelho, e o instinto errado é culpar o teste.

Decida conscientemente qual das duas manda, e escreva a decisão:
remover o `$onUpdate` (o comentário do próprio schema já diz *"a aplicação é a
fonte da verdade"*), ou aceitar que o banco é quem carimba — e aí o `IClock` não
tem o que fazer com esse campo.

### 4.2 — Argon2 **duas vezes**, e nenhuma delas dentro da transação

A troca de senha roda argon2 duas vezes: `compare` para conferir a senha atual e
`hash` para a nova. São ~15 ms e 38 MB somados. O §8 da fatia 4 proíbe isso
dentro do callback do Unit of Work — uma conexão do pool (que tem **10**) parada
por 15 ms de CPU.

Ordem obrigatória: **compare → hash → abre transação → escreve as duas
tabelas**. Se você se pegar chamando o `hashProvider` de dentro do `uow(...)`,
pare.

### 4.3 — `User` é imutável, e `IUsersRepository` não tem update

A entidade tem **só campos `#` privados `readonly`**, `Object.freeze` no
construtor e nenhum setter. Não existe `withNewPassword`. E o contrato do
repositório tem apenas `save` (insert), `findByEmail` e `findById`.

Então a fatia **tem que criar as duas coisas**, e as duas são decisão de desenho,
não detalhe:

- na entidade: um método que devolve uma **nova** `User` com o hash trocado,
  preservando o resto — coerente com a imutabilidade que a classe já defende;
- no repositório: `updatePasswordHash(...)` estreito, ou um `update(user)` amplo.
  O estreito não deixa ninguém trocar e-mail por acidente; o amplo não precisa
  de um método novo a cada campo. **Escolha e justifique.**

## 5. Perguntas que a fatia precisa decidir, e que ficaram em aberto de propósito

- **A sessão atual sobrevive à troca?** Revogar *tudo* desloga o próprio
  aparelho que acabou de trocar a senha, o que é UX ruim e faz o usuário achar
  que deu errado. Preservar a família atual exige que o endpoint saiba qual é —
  e ela chega por cookie ou corpo, não pelo access token. A saída comum é
  *"revoga todas menos a atual"*, e ela tem custo: se o atacante é quem trocou a
  senha, a sessão dele é a preservada.
- **Reusar `LogoutAllUseCase` ou chamar o repositório direto?** Reusar mantém um
  só lugar sabendo revogar, mas ele abre a **própria** transação — e a troca de
  senha precisa da dele. Compor use cases que abrem transação é exatamente o que
  o §4.2 da fatia 4 faz lançar.
- **O erro de senha atual errada é qual categoria?** `UnauthorizedError` (401)
  diz "você não é quem diz"; mas o usuário **está** autenticado, e o que falhou
  foi uma regra. `BusinessRuleError` (422) descreve melhor. Não é cosmético: o
  `code` é contrato público e o app mobile ramifica nele.
- **A nova senha passa pela mesma política do registro?** O `Password` value
  object existe. Vale exigir que a nova seja diferente da atual?
- **Teto de rate limit próprio?** É endpoint que carrega palpite de senha, como
  o login. Hoje ele herdaria só o teto global de 300/min.

## 6. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução. Duas práticas importam mais que o formato:

**Verifique, não presuma.** Na fatia 8, **quatro** afirmações escritas em spec
aprovada estavam erradas e só caíram quando o código rodou — entre elas
`allowList: ['/health']`, que não isenta nada porque compara com a chave e não
com o path, e `trustProxy: 1`, que o Fastify aceita e depois ignora.

**Falsifique todo teste.** A fatia 8 falsificou sete. Uma delas revelou que o
teste da isenção provava o *mecanismo* e não que a rota o usava — a mutação
passava verde, e o teste teve de ser reescrito.

## 7. Estado do repositório

Branch `feat/rate-limiting`, **8 commits** à frente de
`feat/refresh-token-rotation`, que por sua vez está **26 commits** à frente da
`main`. Nada mergeado — a decisão de integração é do dono, e ela é sobre as
duas fatias juntas.

`pnpm lint`, `typecheck`, `test` e `build` verdes; **325 testes**. Auditoria de
arquitetura em **0 achados** nos dois escopos. Postgres sobe com
`docker compose up -d`.

> ⚠️ **Duas armadilhas de ambiente que não são do repositório.** A store do pnpm
> mora sob a revisão do snap do VS Code, então `pnpm add` recusa depois que o
> snap atualiza — o contorno é `--store-dir` apontando para a revisão que a
> própria mensagem de erro nomeia (em 2026-09-02 foi a 255, com o pnpm querendo
> a 259). E `pnpm lint | tail -1` devolve o status do `tail`: rode cada portão
> sozinho e leia o exit code. Mesma família: `pnpm test:unit -- <arquivo>`
> **não filtra** — roda a suíte inteira.

## 8. O roteiro de auth depois desta

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Verificação de e-mail** | provedor de e-mail | `emailVerifiedAt`, o gate do login, e o `202` que fecha a enumeração no `register`; primeira vez que *"persista dentro, envie depois do commit"* sai do papel — e-mail dentro do callback com retry de deadlock **envia duas vezes** |
| **Recuperação de senha** | verificação de e-mail | reusa `ITokenGenerator` e `ITokenDigest` **como estão** |
| **Poda de `refresh_tokens`** | entrypoint `cron.ts` | a tabela cresce sem limite hoje |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |

**Três decisões continuam sem dono**, registradas no `DECISIONS.md` §6: RBAC
(acoplada à decisão 11 — role no JWT significa até 1h de latência para revogar
permissão), a sessão sem teto absoluto, e a colisão de nome de tabela entre
módulos.
