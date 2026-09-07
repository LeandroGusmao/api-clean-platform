# Handoff — Fatia 12: recuperação de senha

> Escrito em 2026-09-07, ao fim da fatia 11, para uma sessão que começa sem o
> contexto dela.

## 0. Como ler este documento

Cada afirmação de fato carrega uma marca:

- **[medido]** — eu rodei e li a saída. Reproduza se duvidar, mas duvide menos.
- **[lido]** — li o código-fonte e conclui. Provável, não provado.
- **[suposto]** — raciocínio sobre o que ainda não existe. Trate como palpite.

**Qualquer coisa sem marca é opinião.**

A calibração que as fatias 10 e 11 cobraram caro: **uma correção revisada e
aprovada ainda pode não corrigir nada** se o raciocínio por trás dela estiver
errado e nenhum teste testar o raciocínio. Quando a fatia inteira depende de uma
frase em prosa, ataque a frase, não o código.

## 1. O que esta fatia entrega

Os dois últimos endpoints ausentes do fluxo de auth:

- **`POST /auth/password/forgot`** — recebe `{ email }`, responde `202` sempre,
  sem corpo. Se um endereço tem conta, um token de reset vai para a caixa dele.
  Se não tem, nada acontece — e a resposta é **idêntica**, pela mesma razão do
  `register` (§6.1 da spec de verificação de e-mail): ninguém enumera contas por
  aqui.
- **`POST /auth/password/reset`** — recebe `{ email, <token>, newPassword }`,
  troca a senha, **revoga todas as sessões** da conta, e responde. Token
  inexistente / errado / expirado / gasto → um erro só, genérico.

Depois desta fatia o `auth` está completo como boilerplate v1: cadastro,
verificação, login, sessão com rotação, troca de senha **e** recuperação. O
próximo grande bloco é o login social.

## 2. Leia primeiro, nesta ordem

1. [`specs/2026-09-03-email-verification-design.md`](specs/2026-09-03-email-verification-design.md)
   **§6.1** (o `202` genérico e como o e-mail é o canal que diverge sem que a
   resposta HTTP divirja) e **§5.3** (o outbox transacional, adiado — o modo de
   falha "crash entre `COMMIT` e `send`" vale igual aqui).
2. [`specs/2026-09-06-account-pre-hijacking-design.md`](specs/2026-09-06-account-pre-hijacking-design.md)
   **§5.2** e **§6.2** — o contrato do `IPendingRegistrationsRepository`
   (`registerFailedAttempt`/`consume` atômicos) e o `confirm` que hasheia a
   senha **antes** de checar o código, incondicionalmente, para o tempo de
   `match` e `no-match` ser igual. A tabela de reset é o mesmo molde; o `reset`
   é o mesmo padrão de tempo plano.
3. [`specs/2026-09-03-password-change-design.md`](specs/2026-09-03-password-change-design.md)
   — a troca de senha autenticada. O `reset` é ela sem a checagem de senha
   atual e com "revoga **todas** as sessões" no lugar de "revoga as outras".
4. `src/modules/auth/services/email-verification-issuer.ts` — o
   `EmailVerificationIssuer.issue(email)` (cunha código, devolve digest + envio
   diferido, não persiste). O emissor de reset é quase idêntico, com outro
   template.
5. `src/modules/auth/notifications/verification-email.ts` — os três templates de
   e-mail. O de reset entra aqui.

## 3. O que já está pronto e te espera [medido]

| Peça | Onde | Estado |
|---|---|---|
| `IEmailSender` + `SmtpEmailSender` + `BestEffortEmailSender` | `shared/ports/`, `infra/providers/` | pooling, teardown no `onClose`, TLS ≥ 1.2 |
| Thunk de envio diferido | `services/email-verification-issuer.ts` | persiste dentro, envia depois do commit — o padrão do §8 do Unit of Work já resolvido |
| `ITokenGenerator` (`numericCode`, `opaque`) + `ITokenDigest` (sha256 determinístico) | `shared/ports/` | `opaque()` dá 256 bits — se o token de reset for opaco e não código |
| Padrão de tabela hash + expiração + uso único + teto de tentativas | `schema/pending-registrations.ts` e o repo dela | copie a forma; troque `email` por FK `user_id` (a conta existe) |
| `registerFailedAttempt(id, max) → boolean` e `consume(id, at) → boolean` atômicos (UPDATE condicional) | `drizzle-pending-registrations-repository.ts` | à prova de corrida; o teste de integração prova sob concorrência |
| Unit of Work multi-tabela | `repositories/unit-of-work.ts` (`AuthRepos`) | o `reset` escreve senha + revoga refresh tokens numa transação |
| `revokeAllForUser` no repo de refresh tokens | `repositories/refresh-tokens-repository.ts` | já existe, usado pelo `logout-all` |
| Rate limit por rota | `config.ts` + `container.ts` | crie `PASSWORD_FORGOT_*` e `PASSWORD_RESET_*` como os de `register`/`confirm` |
| Mailpit no compose e no CI + cliente de teste | `docker-compose.yml`, `tests/integration/setup/mailpit.ts` | espera por condição, nunca `sleep` |
| `arrangeAccount(db, { email, password, verified? })` | `tests/integration/setup/arrange-account.ts` | insere uma conta verificada direto — todo teste de `reset` precisa de uma |
| Conta **sempre** nasce verificada | `entities/user.ts` (fatia 11) | "reset só para conta verificada" é trivialmente sempre verdade; o check fica como defesa em profundidade |

O grosso da infra desta fatia foi pago pelas fatias 10 e 11. O que resta é
desenho de domínio e dois endpoints.

## 4. As decisões que esta fatia tem que tomar

Nenhuma é óbvia. São o brainstorming.

### 4.1 — Token: código de 6 dígitos ou link opaco?

A verificação de e-mail escolheu **código de 6 dígitos** (digitável no celular,
§6.2 da spec dela), atrás de TTL curto + teto de 5 tentativas. Recuperação de
senha classicamente é **link** — a pessoa está no computador, clica no e-mail.

- **Código** — consistência com o resto do `auth`; reusa `numericCode`,
  `registerFailedAttempt`, o padrão de tempo plano do `confirm`. Precisa de TTL
  curto e teto apertado, porque 6 dígitos atrás de um endpoint que **troca a
  senha** é grau-de-takeover.
- **Link opaco** (`opaque()`, 256 bits) — sem teto de tentativas necessário, TTL
  pode ser mais longo, UX melhor no fluxo web. Muda a forma do endpoint
  (`token` no corpo ou na query) e destoa do resto.
- **Híbrido** — link que carrega um `opaque` e o e-mail também mostra um código;
  comum, mas é as duas superfícies.

Recomendo abrir o brainstorming por aqui — decide a tabela, o repo e o formato
dos dois endpoints.

### 4.2 — Um token vivo por conta, ou coexistentes?

O pre-hijacking exigiu pendentes coexistentes **porque o pendente carregava
senha**. Aqui não carrega: o token de reset só prova controle da caixa para uma
conta **que já existe**. Então **um token vivo por conta**, invalidando o
anterior a cada `forgot` (como o `email_verification_tokens` fazia antes da fatia
11), é seguro e mais simples. O cooldown do `forgot` segura o flood.

### 4.3 — O que acontece com as sessões, e o cliente sai logado?

Best practice: **revogar todas as sessões** no reset (a pessoa esqueceu a senha;
assuma comprometimento). Depois:

- **emitir um par novo** (auto-login, como o `change-password` faz) — menos
  atrito;
- **não emitir nada** (manda para o login) — mais seguro, e o login logo em
  seguida prova a senha nova.

Decisão de produto. O `change-password` escolheu auto-login porque o chamador já
estava autenticado; aqui o chamador **não** está.

### 4.4 — Anti-enumeração no `forgot`, e o e-mail "não há conta"

`forgot` responde `202` sempre. Para um endereço com conta, manda o token. Para
um endereço **sem** conta — manda alguma coisa ("alguém pediu reset para este
endereço e não há conta aqui"), ou silêncio total?

O `register` manda o e-mail "você já tem conta" de propósito (§6.1), para não
deixar quem esqueceu num limbo. O `forgot` para um endereço sem conta é
diferente: mandar e-mail para um endereço que não pediu nada é ruído e é
disparável por anônimo. Recomendo **silêncio total** para o endereço
desconhecido — o `202` já é a resposta, e o §12.9 da spec de verificação mostra
o custo de manter e-mails sem cooldown por endereço.

### 4.5 — O `reset` paga argon2 no `no-match`?

Sim, pelo mesmo motivo do `confirm` (§6.2 da spec do pre-hijacking): se o argon2
só rodasse no token válido, o tempo de resposta diria "esse token era válido".
`Password.create(newPassword)` → `hashProvider.hash(...)` **antes** de checar o
token, incondicional. Custo aceito: um martelo de token errado paga ~7 ms/19 MB
por tentativa, contido pelo teto + rate limit por IP.

## 5. As armadilhas

### 5.1 — O `reset` é grau-de-takeover [suposto]

Quem resgatar um token de reset válido **troca a senha da conta**. É a mesma
classe do `confirm` da fatia 11, mas o alvo é uma conta que já tem dono e
sessões. O que segura: o token só chega na caixa do dono, o teto de tentativas
(se for código), o TTL, e o espaço do digest. Se for código de 6 dígitos, o TTL
tem que ser **curto** (na casa do da verificação, 15 min) e o teto **apertado**.
Se for `opaque` de 256 bits, o brute-force sai de cena.

### 5.2 — Revogar sessões e trocar a senha é UM fato [lido]

Numa transação só: `updatePasswordHash` + `revokeAllForUser`. Se a senha muda e
as sessões não, um token roubado continua vivo com a senha nova. O `AuthRepos` +
Unit of Work já suportam isso — é o mesmo shape do `change-password`.

### 5.3 — Interação com o login social, ainda não construído [suposto]

Quando o Google entrar, uma conta ligada só ao Google **não tem senha para
recuperar**. O `forgot` para esse endereço deve responder `202` e não mandar
nada (ou mandar "sua conta usa login com Google"). Não construa isso agora —
mas deixe o `forgot` não assumir que toda conta tem senha. `DECISIONS.md` §6.

### 5.4 — O outbox continua adiado

`forgot` herda os custos do §5.3 da spec de verificação: um crash entre o
`COMMIT` e o `send` perde o e-mail em silêncio, e o ramo que envia é
distinguível por latência. Não conserte aqui; registre nos custos aceitos.

### 5.5 — `POST /auth/password` já existe

A troca de senha **autenticada** é `POST /auth/password` (fatia 9). A
recuperação são caminhos **novos** — `POST /auth/password/forgot` e
`POST /auth/password/reset` —, não uma variante daquele. Não os empilhe no
mesmo handler.

## 6. Estado do repositório [medido]

Branch `feat/account-pre-hijacking`, PR #5 (draft) contra `main`. Assim que ele
mergear, parta de `main`.

`pnpm lint`, `typecheck` e `build` verdes; **317 testes unitários** (35
arquivos), **126 de integração** (17 arquivos), rodados separadamente.
Auditoria de arquitetura em **0 achados**. `docker compose up -d` sobe Postgres
(5432), Postgres de teste (5433) e Mailpit (1025 SMTP, 8025 UI).

Migrations: `users → refresh_tokens → pending_registrations`. A tabela de reset
é a quarta.

Regras que a fatia 11 mudou e você herda:

- **`register` responde `{ email }` e `.strict()`** — um cliente antigo mandando
  `password` toma `400`.
- **`confirm` recebe `{ email, code, password }`** — a conta nasce ali.
- **`register` e `resend` não abrem transação** e não declaram `503`.
- **`User.create` nasce verificado.**
- **`EmailVerificationIssuer` não tem mais `issueFor`** — só `issue(email)`.
- **`AuthRepos` não tem mais `emailVerifications`** — tem `pendingRegistrations`.
- **`arrangeAccount`** é o helper de setup de conta nos testes de integração.

> ⚠️ **Armadilhas de ambiente.** `pnpm lint | tail -1` devolve o status do
> `tail` — rode cada portão sozinho e leia o exit code. `pnpm test:unit --
> <arquivo>` **não filtra**: use `pnpm vitest run --project unit <arquivo>`. O
> `node` do PATH pode ser mais velho que o `engines` — `export
> PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"`.

## 7. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução por fatias com checkpoint. Três práticas que
as fatias 10 e 11 cobraram:

**Verifique, não presuma.** Suposições marcadas `[suposto]` são medidas e
confirmadas antes de virarem base de decisão.

**Falsifique todo teste, e a DELEÇÃO antes da troca.** `toEqual` no log de
chamadas inteiro mata deleção, reordenação e realocação de uma vez; `toContain`
não mata nenhuma.

**Desconfie de revisão limpa em raciocínio novo.** Quando a fatia depende de uma
frase em prosa ("o dono da caixa não distingue de qual cadastro veio o código"),
ataque a frase.

## 8. O roteiro depois desta

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Poda** (`cron.ts`) | entrypoint novo | `refresh_tokens`, `pending_registrations` e agora `password_reset_tokens` crescem sem limite |
| **Login social / Google** | esta e a poda | o `auth` fica completo primeiro; o merge federado é a parte que os apps erram |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |
| **Throttle de `confirm`/`reset` por e-mail** | nada | o teto por IP não segura um anônimo mantendo um endereço travado |

Três decisões continuam sem dono, no `DECISIONS.md` §6: RBAC, a sessão sem teto
absoluto, e a colisão de nome de tabela entre módulos.
