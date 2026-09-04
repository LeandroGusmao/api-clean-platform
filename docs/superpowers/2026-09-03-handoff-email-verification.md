# Handoff — Fatia 10: verificação de e-mail

> Escrito em 2026-09-03, ao fim da fatia 9, para uma sessão que começa sem o
> contexto dela.

## 0. Como ler este documento

O handoff da fatia 9 tinha **três afirmações erradas**, e uma delas quase me fez
mexer no schema do banco à toa. Não foi descuido de quem escreveu: foi o efeito
normal de um documento que descreve o futuro e depois envelhece.

Então, aqui, cada afirmação de fato carrega uma marca:

- **[medido]** — eu rodei e li a saída. Reproduza se duvidar, mas duvide menos.
- **[lido]** — eu li o código-fonte e concluí. Provável, não provado.
- **[suposto]** — raciocínio meu sobre o que ainda não existe. Trate como palpite.

**Qualquer coisa sem marca é opinião.** E o §6 do handoff anterior continua
valendo, agora com mais uma evidência: *verifique, não presuma* — inclusive isto
aqui.

## 1. O que esta fatia entrega

O usuário prova que controla o endereço que cadastrou. Concretamente, ela
destrava quatro coisas que hoje estão paradas:

| O que | Estado hoje |
|---|---|
| Escrever `emailVerifiedAt` | a coluna existe, `GET /auth/me` já a publica e `get-user-profile.ts` já a lê **[medido]** — o que falta é alguém que a **escreva** |
| O gate do login | `login-user.ts:31` diz, em comentário, que não checa porque *"nothing can verify an email yet"* **[medido]** |
| Fechar a enumeração do `register` | hoje ele responde `201 { id }`, e um e-mail tomado responde `409 EMAIL_ALREADY_IN_USE` **[medido]** — que é um oráculo de contas |
| A notificação *"sua senha mudou"* | a fatia 9 a deixou pendurada; é a defesa real do §11.1 da spec dela |

É também a primeira fatia a mandar **I/O externo** — e é isso que a torna
perigosa, não o tamanho.

## 2. Leia primeiro, nesta ordem

1. `docs/superpowers/specs/2026-08-29-unit-of-work-design.md` **§8** — a primeira
   linha da tabela (**I/O externo**) governa esta fatia inteira, do mesmo jeito
   que a segunda (**argon2**) governou a fatia 9.
2. `docs/superpowers/specs/2026-09-03-password-change-design.md` **§3** — três
   afirmações do handoff anterior, medidas e refutadas. Leia pelo *método*, não
   pelo conteúdo.
3. `docs/DECISIONS.md` **13** — a taxonomia de erros. Esta fatia provavelmente
   ganha `EmailNotVerifiedError`, e a categoria dele é decisão, não detalhe.
4. `ARCHITECTURE.md` **§11**, *"Bibliotecas que falham em silêncio"* — ganhou
   duas armadilhas na fatia 9.

## 3. O que já está pronto e te espera

| Peça | Onde | Estado |
|---|---|---|
| `ITokenGenerator.opaque(bytes?)` | `shared/ports/token-generator.ts` | pronto; o token de verificação reusa **como está** **[lido]** |
| `ITokenDigest.hash()` | `shared/ports/token-digest.ts` | sha256 determinístico e indexável; mesmo motivo do refresh |
| `IAuthUnitOfWork` | `repositories/unit-of-work.ts` | `users` + `refreshTokens` na mesma transação |
| `updatePasswordHash` | `repositories/users-repository.ts` | o molde do `UPDATE` estreito que `markEmailVerified` deve seguir |
| `BusinessRuleError` → 422 | `shared/errors/app-error.ts` | **agora tem duas subclasses concretas** e `UNPROCESSABLE_ENTITY_STATUS` já está em `infra/http/constants.ts` |
| `sessionTokensSchema` | `infra/http/session-tokens.ts` | se esta fatia emitir sessão, use este |
| Teto de rate limit por rota | `config.ts` + `container.ts` | o par `PASSWORD_CHANGE_RATE_LIMIT_*` é o molde a copiar |
| `TransactionRunner` | `infra/database/transaction-runner.ts` | `MAX_ATTEMPTS = 3`, backoff 25 ms × 2ⁿ, retentando `40P01` e `40001` **[medido]** |

## 4. As armadilhas que esta fatia é a primeira a encontrar

### 4.1 — E-mail dentro do callback é enviado **até três vezes** [medido]

O `TransactionRunner` reexecuta o callback inteiro em cada tentativa, e
`MAX_ATTEMPTS` é **3**. Então:

```ts
await uow(async ({ users }) => {
  await users.save(user)
  await emailProvider.send(...)   // ← deadlock aqui reexecuta TUDO
})
```

Um `40P01` na segunda escrita reexecuta o callback, e o e-mail sai de novo. O
usuário recebe dois. Não há erro, não há log, e em desenvolvimento nunca
acontece, porque deadlock exige concorrência.

**E há um segundo estrago, independente do retry:** se a transação der rollback
depois do envio, você mandou um e-mail de boas-vindas para uma conta que não
existe.

A regra do §8 é *"persista dentro, envie **depois** do commit"*. Ela é fácil de
escrever e fácil de esquecer, porque o código errado é mais curto e funciona no
laptop.

> **Simetria com a fatia 9, que vale entender.** Lá o proibido era **CPU** dentro
> da transação, e bastou tirar de dentro. Aqui é **I/O externo**, e tirar de
> dentro não basta: tem de ser *depois do commit*, porque só o commit garante que
> o motivo do e-mail existe de verdade.

### 4.2 — Ligar o gate do login tranca **todas** as contas existentes [medido]

`User.create` sempre grava `emailVerifiedAt: null` (`entities/user.ts:84`), e não
existe nada que escreva outro valor. Logo, **toda linha em `users` hoje tem
`email_verified_at` nulo.**

No instante em que o login passar a exigir verificação, todo mundo que já tem
conta é trancado do lado de fora — inclusive quem estava usando o sistema
normalmente. Não é bug, é o gate funcionando; e é exatamente o tipo de coisa que
passa em toda a suíte de testes, porque os testes criam contas novas dentro do
mesmo cenário.

As saídas são decisão, não detalhe: backfill marcando as contas existentes como
verificadas (honesto para um boilerplate sem usuários reais, desonesto num
sistema em produção), ou o gate valer só para contas criadas depois de uma data.
**Escolha e escreva a decisão.**

### 4.3 — Fechar a enumeração muda um contrato público já publicado [lido]

O `register` responde `201 { id }` hoje, e `409 EMAIL_ALREADY_IN_USE` quando o
e-mail está tomado. O `409` é o oráculo: qualquer um descobre se um endereço tem
conta.

A correção usual é responder **`202`, sempre**, sem corpo que distinga — e mandar
o e-mail que diverge (*"crie sua conta"* vs *"você já tem conta"*). Mas isso:

- remove o `id` da resposta, que é contrato que algum cliente pode estar lendo;
- remove o `409`, que está declarado no schema do endpoint;
- e o `EmailAlreadyInUseError` fica sem consumidor HTTP, embora o repositório
  continue precisando dele para o `23505`.

Nada disso impede a mudança. Só significa que ela é **uma decisão de contrato**, e
merece estar na spec, não aparecer no diff.

## 5. Perguntas que ficaram em aberto de propósito

Estas são o começo do brainstorming, não coisas para decidir sozinho.

- **Qual provedor de e-mail, e como testar sem enviar?** É a decisão que
  bloqueia todas as outras. O contrato vai para `ports/`, o adapter para
  `infra/providers/` (decisão 21) — isso é padrão do repo. O que não é padrão: se
  dá para ter teste de integração honesto, ou se o provedor só é exercitável por
  fake. **[suposto]** um provedor com modo sandbox muda o que a fatia consegue
  provar.
- **Link (`GET`) ou código (`POST`)?** Link é o padrão de mercado e um clique;
  mas `GET` que muda estado é verbo errado, e pré-fetchers de e-mail corporativo
  consomem links sozinhos — o usuário recebe "já verificado" antes de clicar.
  Código curto digitado no app não tem esse problema e serve mobile melhor.
- **Tabela nova ou coluna em `users`?** Um token de verificação tem hash,
  expiração e uso único, exatamente como o refresh. Tabela nova custa migration;
  coluna em `users` não guarda histórico nem permite reenvio limpo.
- **Reenviar é possível? Com que teto?** É endpoint que dispara e-mail para
  terceiro a partir de request anônima — ou seja, um amplificador de spam se não
  tiver teto próprio.
- **`EmailNotVerifiedError` é qual categoria?** `ForbiddenError` (403) diz "sei
  quem você é, mas não pode"; `BusinessRuleError` (422) diz que uma regra falhou.
  A fatia 9 escolheu 422 para senha errada por causa do laço de refresh do
  interceptor mobile — **o mesmo argumento pode não valer aqui**, porque este
  erro acontece *no login*, onde não há token a refrescar. Pense de novo, não
  copie.
- **A notificação "sua senha mudou" entra nesta fatia ou na seguinte?** Ela é o
  custo aceito no §11.1 da spec da fatia 9, e depende só do provedor — não da
  verificação em si.

## 6. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução. Duas práticas importam mais que o formato,
e as duas cobraram preço na fatia 9:

**Verifique, não presuma.** Três afirmações do handoff anterior caíram na
medição, e uma delas (*"o `$onUpdate` sobrescreve o seu `IClock`"*) teria levado
a uma mudança de schema desnecessária. Bastaram dez minutos lendo
`node_modules/drizzle-orm/pg-core/dialect.js` e imprimindo o SQL gerado.

**Falsifique todo teste — e falsifique a DELEÇÃO, não só a troca.** A fatia 9
falsificou dezesseis mutações. A revisão ainda achou quatro que passavam verdes,
e a causa da pior delas vale decorar:

```ts
// VAZIO: indexOf devolve -1 quando a chamada nunca aconteceu,
// e -1 é menor que qualquer índice real.
expect(callLog.indexOf(A)).toBeLessThan(callLog.indexOf(B))

// Mata deleção, troca e realocação de uma vez:
expect(callLog).toEqual([A, B, C])
```

Deletar a revogação inteira deixava os dez testes unitários verdes, incluindo o
cujo nome prometia justamente aquilo.

**E desconfie da auto-revisão do plano.** A do plano da fatia 9 afirmou que a §10
da spec estava coberta. Dois testes que a spec declarava — o `sub` do access
token e o teto de rate limit da rota — não existiam. Uma auto-revisão que declara
cobertura falsa é pior que nenhuma.

## 7. Estado do repositório [medido]

Branch `feat/password-change`, **10 commits** à frente de `main`. PR em aberto —
a fatia 9 entra na `main` por ele.

`pnpm lint`, `typecheck`, `test` e `build` verdes, rodados **separadamente**;
**351 testes**. Auditoria de arquitetura em **0 achados** contra `main`. Postgres
sobe com `docker compose up -d`.

Regras que a fatia 9 mudou e você herda:

- **§9 do Unit of Work** agora proíbe **escrita** direta, não posse: um use case
  pode receber o UoW e um repositório para **ler**, desde que declare o
  repositório como `Pick<IUsersRepository, 'findById'>`. Assim a escrita direta é
  erro de compilação, não comentário. **[medido]**
- **`$onUpdate` preenche a ausência, nunca sobrescreve a presença.** Todo `UPDATE`
  manda `updated_at` explicitamente. **[medido]**
- **Validação de schema roda antes do `preHandler`**, então rota protegida com
  corpo responde 400 a chamador anônimo com corpo inválido. **[medido]**

> ⚠️ **Três armadilhas de ambiente que não são do repositório.**
> `pnpm lint | tail -1` devolve o status do `tail` — rode cada portão sozinho e
> leia o exit code. `pnpm test:unit -- <arquivo>` **não filtra**: roda a suíte
> inteira. E a porta **3000 pode estar ocupada** por outro processo desta
> máquina — em 2026-09-03 um serviço Python respondia nela, e os `404` dele
> passaram por "a rota não foi registrada" até eu olhar o `ss -ltnp`. Use outra
> porta ao testar à mão.

## 8. O roteiro depois desta

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Recuperação de senha** | esta | reusa `ITokenGenerator` e `ITokenDigest` como estão; fluxo sem senha atual a apresentar |
| **Poda de `refresh_tokens`** | entrypoint `cron.ts` | a tabela cresce sem limite — e a fatia 9 **acelerou** isso: toda troca de senha revoga N linhas e insere mais uma, sem apagar nada |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |

**Três decisões continuam sem dono**, no `DECISIONS.md` §6: RBAC (acoplada à
decisão 11 — role no JWT significa até 1h de latência para revogar permissão), a
sessão sem teto absoluto, e a colisão de nome de tabela entre módulos.
