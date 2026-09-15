# O que falta

> **Fatia 15 (2026-09-14) entregou o seed do banco local** (`pnpm db:seed`,
> decisão 32) e os scripts `db:up`/`db:down`/`db:logs`/`db:studio`. É tooling de
> desenvolvimento: não fecha nenhum item abaixo, e a ordem de urgência não muda.
>
> **Fatia 14 (2026-09-08) entregou o login com Google client-driven.** `POST
> /auth/google` verifica o ID token contra o JWKS do Google, sem client secret;
> tabela `federated_identities`; `users.password_hash` nulável para contas
> federadas. Fecha os três itens de "Login social" da §6 do `DECISIONS.md`
> (decisão 31). O próximo grande bloco genérico é o **outbox transacional** —
> `cron.ts` e o registry já existem, falta a tabela e a escrita transacional.
>
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
> furo aberto — a detecção de reuso não produzia log — e o que falta para um
> app que trate dado sensível. Nada nelas invalida o acima; elas somam. O furo
> foi fechado em 2026-09-08.

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

## ✅ Detecção de reuso de refresh sem log — fechado em 2026-09-08

Era **falha**, não ausência, achada pela auditoria de 2026-09-07: o mecanismo
mais forte do desenho de sessão disparava, revogava a família inteira, e não
deixava rastro nenhum. Verificado ponta a ponta, não deduzido — lançando um
`RefreshTokenReusedError` contra um servidor real, o `code` nunca aparecia no
log; só a resposta ao cliente.

**O conserto:** `AppError` ganhou `securityEvent: boolean` (`false` por
padrão, decisão 15 emendada), que o `error-handler.ts` lê para emitir um `warn`
com o `code` antes de responder — sem o use case logar, sem quebrar a regra da
decisão. `RefreshTokenReusedError` é o primeiro caso marcado. Mesmo probe de
antes, depois do conserto:

```text
HTTP status: 401 | body code: REFRESH_TOKEN_REUSED
{"level":40,…,"code":"REFRESH_TOKEN_REUSED","traceId":"…","msg":"security event"}
{"level":30,…,"res":{"statusCode":401},"msg":"request completed"}
contém REFRESH_TOKEN_REUSED no log?  SIM
```

Os dois documentos que afirmavam o contrário — o comentário em
`refresh-token-reused-error.ts` e a tabela de cobertura da decisão 15 — foram
emendados junto, para não voltar a ler como coberto.

## O resto, em ordem decrescente de urgência

| Item | Depende de | Nota |
|---|---|---|
| ~~Poda de tokens expirados~~ | — | **fechada pela fatia 13.** `cron.ts` one-shot + registry de jobs por módulo; três use-cases de poda com janela de retenção por tabela varrem `refresh_tokens`, `pending_registrations` e `password_reset_tokens`. Decisão 30; spec `2026-09-07-token-pruning-cron-design.md` |
| ~~Login social / OAuth (Google)~~ | — | **fechado pela fatia 14** (client-driven `POST /auth/google`, decisão 31). Falta: listar provedores vinculados no `/me`. Descartados: fluxo redirect/BFF (o front já lida com o redirect), desvincular provedor, definir a primeira senha numa conta só-Google, restrição de domínio `hd` (produto é global, não B2B/Workspace) |
| Throttle de `confirm` por e-mail | nada | um anônimo pode manter um endereço não-confirmável queimando o teto de cinco tentativas do código a cada cooldown — o teto por IP não segura. Conserto: throttle por conta/e-mail |
| ~~CORS~~ | — | **já existe** em `src/infra/http/cors.ts` (lista de origens permitidas, registrado no `buildApp`). Entrou sem decisão no `DECISIONS.md` — registrar quando o primeiro front web definir a política |
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
propõe esta: ~~(1) log de evento de segurança — sem ele nada mais é
observável~~ fechado em 2026-09-08; (2) `helmet` e TTL do access token; (3)
colunas de dispositivo e notificação de reuso, enquanto a migration ainda é de
graça; (4) reabrir o lockout; (5) trilha de auditoria e teto absoluto de
sessão; (6) MFA. Para o boilerplate genérico, segue valendo o que está abaixo.

~~Login social / OAuth com Google~~ — **entregue pela fatia 14** (decisão 31).
O `auth` agora tem identidade federada: cadastro, verificação, login por senha
**ou com Google**, sessão com rotação, troca e recuperação de senha.

O próximo grande bloco genérico é o **outbox transacional**. O `cron.ts` e o
registry de jobs já existem (fatia 13) — é só mais um `CronJob` de dispatch, mais
a tabela e a escrita transacional nos use-cases que mandam e-mail. Fecha o furo
de "crash entre o `COMMIT` e o envio SMTP perde o e-mail em silêncio".

Miúdo que ficou da fatia 14: listar provedores vinculados no `/me`.

Descartados, não pendências: fluxo redirect/BFF do Google (o front já lida com o
redirect, não há BFF neste desenho), desvincular provedor e definir a primeira
senha numa conta só-Google (nicho — a maioria dos apps com login social nem
oferece isso; reabrir se aparecer pedido concreto), restrição de domínio `hd`
(só faz sentido pra produto B2B/Workspace-only; este é um produto global).
