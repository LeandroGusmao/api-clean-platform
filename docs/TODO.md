# O que falta

> Atualizado em 2026-09-07, ao fim da fatia 13 (poda de tokens no `cron.ts`).
> Reescrito ao fim da fatia 12: a versão anterior, do fim da fatia 11,
> recomendava a recuperação de senha como próximo passo — a fatia 12 a fechou,
> e com ela o `auth` está completo como boilerplate v1. Quem abrisse a versão
> anterior começaria por algo que já está entregue.
>
> Aquela versão já havia corrigido as anteriores: uma que listava o account
> pre-hijacking como o único **buraco aberto** (fechado pela fatia 11), e outra
> que dava rate limiting, troca de senha e verificação de e-mail como pendentes
> — as três entregues nas fatias 8, 9 e 10.
>
> **Auditoria de 2026-09-07** (posterior à fatia 13) acrescentou duas seções: um
> furo aberto — a detecção de reuso não produz log — e o que falta para um app
> que trate dado sensível. Nada nelas invalida o acima; elas somam.

## ✅ Sequestro de conta antes da verificação — fechado pela fatia 11

Era o único item da lista que era **falha**, não ausência. A fatia 11 moveu a
criação da conta para a confirmação: `POST /auth/register` recebe só o e-mail e
grava um registro pendente **sem senha**; `POST /auth/email/verify` recebe a
senha e cria a conta já verificada **com a senha daquele request**. Quem completa
a confirmação — só quem recebeu o código na caixa — é quem define a senha, então
não há mais senha do atacante para ser aplicada.

Decisões 27 e 28 no [`DECISIONS.md`](DECISIONS.md); desenho completo em
[`superpowers/specs/2026-09-06-account-pre-hijacking-design.md`](superpowers/specs/2026-09-06-account-pre-hijacking-design.md);
contexto de continuação em
[`superpowers/2026-09-05-handoff-account-pre-hijacking.md`](superpowers/2026-09-05-handoff-account-pre-hijacking.md).

## ✅ Recuperação de senha — fechada pela fatia 12

`POST /auth/password/forgot` e `POST /auth/password/reset` entregues. O fluxo de
`auth` está completo como boilerplate v1: cadastro, verificação, login, sessão
com rotação, troca de senha **e** recuperação. O próximo grande bloco é o login
social.

Decisão 29 no [`DECISIONS.md`](DECISIONS.md); desenho completo em
[`superpowers/specs/2026-09-07-password-recovery-design.md`](superpowers/specs/2026-09-07-password-recovery-design.md).

## 🔴 Detecção de reuso de refresh não produz log — o **furo aberto**

Achado da auditoria de 2026-09-07. É **falha**, não ausência, e por isso vem
antes da lista: o mecanismo mais forte do desenho de sessão dispara, revoga a
família inteira, e não deixa rastro nenhum.

O `error-handler.ts` devolve todo `AppError` da taxonomia **sem chamar log** —
`request.log.error` só existe no ramo genérico de 500. Verificado ponta a ponta,
lançando um `RefreshTokenReusedError` contra um servidor real:

```text
HTTP status: 401 | body code: REFRESH_TOKEN_REUSED
{"level":30,…,"res":{"statusCode":401},"responseTime":1.94,"msg":"request completed"}
contém REFRESH_TOKEN_REUSED no log?  NAO
```

Um token roubado sendo replayado e um token expirado comum são **a mesma linha
de log**. Sem alerta, sem investigação, e sem resposta para "quando começou?".

**Dois documentos afirmam o contrário, e os dois se emendam junto com o
conserto:**

- `src/modules/auth/errors/refresh-token-reused-error.ts` — *"folding the two
  together would erase from the logs the only trace that reuse detection ever
  fired"*. Esse rastro não existe hoje.
- [`DECISIONS.md`](DECISIONS.md), decisão 15, tabela de cobertura — *"Error
  handler (13) → erro completo + `traceId`"*. Só vale para o 500.

Conserto: `warn` no ramo de `AppError` para uma lista de códigos de segurança
(`REFRESH_TOKEN_REUSED` primeiro), ou `warn` em todo 401/403. Horas de trabalho
— e nada mais desta lista é observável enquanto ele não existir.

## O resto, em ordem decrescente de urgência

| Item | Depende de | Nota |
|---|---|---|
| ~~Poda de tokens expirados~~ | — | **fechada pela fatia 13.** `cron.ts` one-shot + registry de jobs por módulo; três use-cases de poda com janela de retenção por tabela varrem `refresh_tokens`, `pending_registrations` e `password_reset_tokens`. Decisão 30; spec `2026-09-07-token-pruning-cron-design.md` |
| Login social / OAuth (Google) | decisão em aberto | três sub-perguntas já resolvidas — ver `DECISIONS.md` §6. **Não** haverá troca de e-mail, por causa disto. Interage com a recuperação de senha (conta ligada ao Google não tem senha para "recuperar") |
| Throttle de `confirm` por e-mail | nada | um anônimo pode manter um endereço não-confirmável queimando o teto de cinco tentativas do código a cada cooldown — o teto por IP não segura. Conserto: throttle por conta/e-mail |
| CORS | primeiro front web | sem ele o modo cookie não funciona cross-origin |
| Outbox transacional | **destravado** pela fatia 13 | o `cron.ts` e o registry de jobs existem — o dispatch do outbox é mais um `CronJob`. Falta a tabela e a escrita transacional. Um crash entre o `COMMIT` e o envio SMTP perde o e-mail em silêncio; custos aceitos no §11 da spec da fatia 11 e §5.3 da fatia 10 |
| Listar sessões ativas | nada | cai quase de graça agora que há `family_id` |
| Invalidar sessões + notificar o dono na verificação | nada | defesa em profundidade que a literatura recomenda por cima da correção estrutural (§4.4 do handoff da fatia 11) |
| RBAC / permissões | decisão em aberto | acoplada à 11: role no JWT significa até 1h de latência para revogar permissão |
| Deleção de conta | não existe | quando existir, tem que varrer os `pending_registrations` do endereço — um código vivo remanescente confirmaria uma conta nova |
| Revogação por usuário deletado/banido | não existe deleção | a rotação é o lugar certo quando existir |

## Auditoria de 2026-09-07 — o que falta para dado sensível

Escopo: `src/modules/auth`, `src/infra`, `src/shared`. Scanner de arquitetura em
**0 achados**; `pnpm lint`, `typecheck` e `test:unit` verdes (372 testes). Tudo
abaixo é do que o scanner não prova.

A pergunta que a motivou foi se este `auth` serviria a um app de controle
financeiro. **Nada aqui declara que o produto é esse** — é o cenário contra o
qual os itens estão avaliados, e é o mesmo cenário que a §6 do
[`DECISIONS.md`](DECISIONS.md) já nomeia como gatilho.

### Achados que não estavam rastreados em lugar nenhum

| Item | Depende de | Nota |
|---|---|---|
| Headers de segurança (`helmet`) | nada | não está nas dependências nem no código. Sem HSTS, `X-Content-Type-Options` nem `Referrer-Policy` — e o modo cookie da decisão 12 é justamente quem mais depende de HSTS |
| Contexto de dispositivo em `refresh_tokens` | nada | sem `ip`, `user_agent` e `last_used_at`, "listar sessões ativas" (abaixo) mostra só UUID opaco e o dono não consegue responder "fui eu?". Migration de graça enquanto não há usuário; depois é backfill sem dado para preencher |
| Notificar o dono quando a detecção de reuso dispara | o log do furo acima | troca e recuperação de senha já mandam e-mail; roubo de sessão detectado não manda nada — e é a única defesa que sobra quando o atacante já tem a sessão |
| `iss` / `aud` / `kid` no JWT | nada | sem `kid` não há rotação de `JWT_SECRET` com janela de duas chaves: trocar o segredo desloga todo mundo de uma vez. Em app financeiro rotação de chave é rotina, não incidente |
| Trilha de auditoria | nada | não existe tabela nem evento de login, troca de senha ou revogação. É o que a LGPD art. 37 cobra, e o que decide disputa depois |
| Checagem de senha vazada | nada | o piso é 8 caracteres e não há blocklist. Como o lockout foi recusado, o custo do argon2 e a qualidade da senha são as duas únicas defesas contra força bruta — e uma delas está no piso |
| Custo do argon2 acima do mínimo | máquina alvo | 7,3 ms / 19 MB é o **mínimo** recomendado pela OWASP; o comentário do adapter já registra que tunar é "hardening, once there is a target machine" |
| Step-up / reautenticação | decisão em aberto | o access token não carrega `auth_time` nem `amr`, então operação de valor alto não tem em que se apoiar. Sentar o claim agora é barato; depois é migração de token |
| MFA / TOTP | decisão em aberto | não aparece em nenhum documento do repositório. É a maior ausência de produto para financeiro |
| Criptografia em repouso | fora do `auth` | nada de column-level nem `pgcrypto` no projeto. O `auth` não guarda o dado sensível, mas estabelece o precedente para o módulo que guardar |

### O que a auditoria promove de "decisão aceita" para "pendência"

Nenhum destes é deslize — todos estão escritos e justificados. O que muda é o
contexto, não a análise:

- **Contagem de falha / lockout.** A §6 do `DECISIONS.md` define o gatilho para
  reabrir como *"o primeiro app derivado que trate dado sensível (saúde,
  financeiro)"*. O custo aceito está lá com todas as letras: mil IPs somam dez
  mil tentativas por minuto e **nada no servidor nota**.
- **Store do rate limit é in-process.** Com N réplicas o teto real do login é
  N × 10/min. Precisa de store compartilhado, ou de teto de borda de verdade.
- **Teto absoluto de sessão, mais idle timeout.** Os 60 dias deslizantes viram
  sessão perpétua — ver a pergunta registrada logo abaixo.
- **TTL do access token.** 1h é a latência de revogação do `logout-all`. Em
  financeiro o usual é 5–15 min, e aqui é só variável de ambiente.

## Perguntas registradas, não pendências

**A sessão não tem teto absoluto.** Os 60 dias são deslizantes: um cliente que dê
refresh toda semana fica logado para sempre sem nunca reautenticar. A rotação e a
detecção de reuso cobrem roubo, então não é furo — é decisão de produto que
ninguém tomou. A saída usual é um `max_lifetime` por família.
**Promovida a pendência** pela auditoria de 2026-09-07, junto com um idle
timeout, se o alvo tratar dado sensível.

**Contagem de falha de autenticação / lockout.** Decisão tomada de **não** fazer
no app: delegado à borda (Cloudflare/WAF) e ao custo do argon2. Gatilho para
reabrir: primeiro app derivado que trate dado sensível, ou primeiro incidente de
conta comprometida por força bruta. `DECISIONS.md` §6.
**O primeiro gatilho foi levantado** pela auditoria de 2026-09-07 — ver a seção
acima antes de tratar isto como decidido.

**Custos aceitos das fatias 10 e 11.** §12 da spec de verificação de e-mail
(treze), §11 da spec do pre-hijacking (os que sobrevivem e os novos). Os que mais
valem reler antes da próxima fatia: o `resend`/`confirm` é distinguível por
**latência**, e um pendente que perdeu a corrida do `users.save` fica
permanentemente não-resgatável.

**Colisão de nome de tabela entre módulos.** Arquitetural, não só do `auth`.
`DECISIONS.md` §6. **Multi-tenancy** idem.

## O que eu faria a seguir

**Se o alvo tratar dado sensível, a ordem muda**, e a auditoria de 2026-09-07
propõe esta: (1) log de evento de segurança — sem ele nada mais é observável;
(2) `helmet` e TTL do access token; (3) colunas de dispositivo e notificação de
reuso, enquanto a migration ainda é de graça; (4) reabrir o lockout; (5) trilha
de auditoria e teto absoluto de sessão; (6) MFA, antes do login social. Para o
boilerplate genérico, segue valendo o que está abaixo.

Login social / OAuth com Google. Com a recuperação de senha fechada, o `auth`
está completo como boilerplate v1 e o próximo grande bloco de valor é entrar sem
senha — as sub-perguntas de design já estão resolvidas (`DECISIONS.md` §6), e ele
encosta na recuperação: conta ligada ao Google não tem senha para "recuperar".

A poda de tokens expirados que estava aqui **foi entregue pela fatia 13** — o
`cron.ts` e o registry de jobs existem. O ganho de tabela é o **outbox
transacional**: agora é só mais um `CronJob` de dispatch, mais a tabela e a
escrita transacional nos use-cases que mandam e-mail.
