# O que falta

> **Reorganizado em 2026-09-19.** A fila viva agora é "Pendências do
> boilerplate", logo abaixo, e vem antes do histórico de propósito: quem abre
> este arquivo quer saber o que fazer, não o que já foi feito. O critério da
> separação está na própria seção.
>
> **Fatia 25 (2026-09-19) entregou o teto absoluto de sessão** (decisão 42).
> Fecha o item #4 de "Pendências do boilerplate". Todo refresh token novo vence
> no menor entre o TTL deslizante e o início da sessão mais 90 dias
> (`REFRESH_TOKEN_MAX_LIFETIME_SECONDS`), sem coluna nova: o início é o
> `session_started_at` da decisão 38. O "idle timeout junto" que o item pedia já
> existia, era o próprio TTL deslizante.
>
> **Fatia 24 (2026-09-19) entregou o aviso ao dono quando a detecção de reuso
> dispara** (decisão 41). Fecha o item #3 de "Pendências do boilerplate". A
> revogação da família e o aviso vão na mesma transação, pelo outbox, e o aviso
> só sai na transição: um replay contra a família já morta revoga zero linhas e
> não grava nada, então um token velho não serve para encher a caixa do dono. O
> texto diz "suspeito", nunca "roubo", porque o endereço pode ser o do próprio
> cliente do dono.
>
> **Fatia 23 (2026-09-19) entregou o dispatch do outbox com etiqueta por
> mensagem** (decisão 40). Fecha o item #2 de "Pendências do boilerplate". Cada
> mensagem é pega com um prazo (`claimed_until`) antes de ser enviada, então
> execuções que se sobreponham trabalham em mensagens diferentes: três
> `cron.ts` concorrentes sobre 100 mensagens entregavam 300 e-mails e agora
> entregam 100. Não é "exatamente uma vez": uma queda entre o envio e o registro
> ainda reenvia. O SMTP ganhou timeouts explícitos, que a etiqueta exige.
>
> **Fatia 22 (2026-09-19) entregou o store de rate limit compartilhado no
> Redis** (decisão 39). Fecha o item #1 de "Pendências do boilerplate". As rotas
> que **declaram o próprio teto** (as nove do `auth`) passam a contar num Redis
> comum às réplicas e a recusar com 503 quando ele cai; o teto global de 300/min
> continua em memória, por réplica, e não depende do Redis. A premissa que
> sustenta o fail-closed — Redis operado por quem opera o app — está na decisão,
> junto do que a reabre.
>
> **Fatia 21 (2026-09-19) entregou o contexto de dispositivo na sessão, os
> claims `iss`/`aud`, o `helmet` e o TTL de 900s** (decisão 38). É a primeira
> fatia puxada pela auditoria de 2026-09-07 em vez da lista genérica — hoje
> "Entregues — a lista genérica original" —, que ficou sem item desbloqueado
> na fatia 20. O gatilho foi levantado: o primeiro
> app derivado será um agregador de gastos e investimentos ou um app de
> alimentação e calorias, e os dois disparam o critério da §6.
>
> O recorte foi por **reversibilidade**: coluna que o banco não registrou não
> volta, enquanto claim de access token se conserta sozinho numa janela de
> TTL. Por isso as três colunas entraram agora, com a tabela vazia, e `kid` e
> `auth_time`/`amr` não. **A justificativa que esta lista dava para o `kid`
> estava errada** e foi corrigida: trocar o `JWT_SECRET` não desloga ninguém,
> porque `/auth/refresh` não lê o access token.
>
> **Fatia 20 (2026-09-18) entregou a deleção de conta** (decisão 37).
> `DELETE /auth/me` com hard delete da linha de `users`; a cascata que o schema
> já declarava leva `refresh_tokens`, `federated_identities` e
> `password_reset_tokens`, e os pendentes do endereço são varridos
> explicitamente porque aquela tabela não tem FK. **Fecha junto "Revogação por
> usuário deletado/banido"**, sem código próprio. Sem soft delete e sem tabela
> de auditoria — ver decisão 37.
>
> **Fatia 19 (2026-09-17) entregou a invalidação de sessão no vínculo do
> Google** (decisão 36). Ao ligar uma conta Google numa conta que já tinha
> senha, `SignInWithGoogleUseCase` agora derruba toda sessão existente antes
> de abrir a nova — mesma defesa em profundidade que `change-password` e
> `reset-password` já tinham. O item original do `TODO.md` falava em
> "notificar o dono na verificação", mas o aviso por e-mail já existia desde a
> fatia 14; o que faltava era só a invalidação, e só nesta rota — as outras
> duas (troca e recuperação de senha) já derrubavam sessão desde antes.
>
> **Fatia 18 (2026-09-16) entregou a listagem de sessões ativas** (decisão
> 35). `GET /auth/sessions` devolve uma entrada por família de refresh token
> ainda viva (`family_id`, `createdAt`, `expiresAt`) — sem `GROUP BY`, porque a
> rotação já garante no máximo uma linha não revogada por família a qualquer
> instante. Sem informação de dispositivo de propósito: isso é o item separado
> "Contexto de dispositivo em `refresh_tokens`" da auditoria abaixo, que exige
> migration.
>
> **Fatia 17 (2026-09-16) entregou o throttle de `confirm` por e-mail**
> (decisão 34). O cooldown de reenvio de 60s (`RegisterUserUseCase`) passou a
> valer também sobre um pending com as tentativas esgotadas, não só sobre um
> ainda usável — fechando a brecha que deixava um atacante distribuído em
> vários IPs mintar orçamento de tentativas novo na hora, sem esperar nada.
> Ficou de fora, de propósito, um contador de falhas por e-mail com bloqueio:
> reproduziria o padrão já descartado no `DECISIONS.md` §6 para o login, que
> deixaria qualquer um travar o cadastro de uma vítima só sabendo o endereço.
>
> **Fatia 16 (2026-09-16) entregou o outbox transacional** (decisão 33).
> `outbox_messages` no módulo `auth`; os três avisos pós-commit (senha alterada,
> senha resetada, Google vinculado) são gravados dentro da mesma transação que
> muda o estado; `CronJob`s de dispatch e poda. Fecha o furo de "crash entre o
> `COMMIT` e o envio SMTP perde o e-mail em silêncio".
>
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

## Pendências do boilerplate

**Reorganizado em 2026-09-19.** A lista anterior arquivava quase tudo sob "o que
falta para dado sensível", que é uma lente de **produto**: pergunta o que o app
vai guardar. Faltava a outra pergunta — **o que todo app derivado vai precisar,
faça ele o que fizer** —, e sob essa lente alguns itens arquivados como produto
são do boilerplate, e um não estava aqui de jeito nenhum (o furo do dispatch do
outbox, que vivia só na spec da fatia 16).

O critério desta seção: entra se **todo** app derivado bate nele, e se resolver
uma vez aqui sai mais barato que resolver N vezes lá na frente. O que depende do
que o produto é foi para "Decisões que cada produto toma", adiante.

Os dois primeiros não são "falta uma feature": são **o boilerplate deixando de
cumprir o que ele mesmo promete** assim que sai de uma instância só.

| # | Item | Depende de | Nota |
|---|---|---|---|
| 1 | ~~Store do rate limit é in-process~~ | — | **fechado pela fatia 22.** Rota com teto próprio conta num Redis compartilhado e recusa com 503 quando ele cai; o teto global segue em memória, por réplica. Decisão 39 |
| 2 | ~~Dispatch do outbox sem trava~~ | — | **fechado pela fatia 23.** Cada mensagem é pega com uma etiqueta de prazo (`claimed_until`) por uma instrução única com `FOR UPDATE SKIP LOCKED`; execuções concorrentes trabalham em mensagens diferentes. Decisão 40 |
| 3 | ~~Notificar o dono quando a detecção de reuso dispara~~ | — | **fechado pela fatia 24.** `revokeFamily` devolve a contagem e só a chamada que matou a família grava o aviso, pelo outbox, na mesma transação. Decisão 41 |
| 4 | ~~Sessão sem teto absoluto~~ | — | **fechado pela fatia 25.** Todo token novo vence em `min(agora + TTL, início da sessão + teto)`, com padrão de 90 dias; o idle timeout já era o TTL deslizante. Decisão 42 |
| 5 | Checagem de senha vazada — **adiada em 2026-09-19** | decisão: API externa (HIBP) ou lista embarcada | o piso é 8 caracteres e não há blocklist. Como o lockout foi recusado, o custo do argon2 e a qualidade da senha são as duas únicas defesas contra força bruta — e uma delas está no piso. **Adiada de propósito, não esquecida.** Gatilho para reabrir: os primeiros usuários reais, ou o primeiro app derivado que trate dado sensível (o financeiro), o que vier primeiro. Um aviso por notificação, quando o app tiver esse canal, cobriria só a checagem no login (contas que já existem); não substitui a validação na criação da senha, que é o que protege |
| 6 | Trilha de auditoria — **só o mecanismo** | nada | a tabela e a porta são genéricas; *o que* registrar e por quanto tempo é produto. O boilerplate entrega o encanamento. É o que a LGPD art. 37 cobra, e a **deleção de conta** (fatia 20) é um dos eventos a capturar quando for retomada |
| 7 | `kid` no JWT | nada | genérico, mas compra pouco hoje: `iss` e `aud` foram entregues pela fatia 21 (decisão 38), e trocar o `JWT_SECRET` **não desloga ninguém** — `POST /auth/refresh` não lê o access token, então cada cliente ativo toma um `401` e renova de forma transparente. O que o `kid` evita é todos renovarem no mesmo instante: estampida, não logout |

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

## Entregues — a lista genérica original

Todos riscados. Ela é histórico, não fila: a fila viva é
"Pendências do boilerplate", abaixo.

| Item | Depende de | Nota |
|---|---|---|
| ~~Poda de tokens expirados~~ | — | **fechada pela fatia 13.** `cron.ts` one-shot + registry de jobs por módulo; três use-cases de poda com janela de retenção por tabela varrem `refresh_tokens`, `pending_registrations` e `password_reset_tokens`. Decisão 30; spec `2026-09-07-token-pruning-cron-design.md` |
| ~~Login social / OAuth (Google)~~ | — | **fechado pela fatia 14** (client-driven `POST /auth/google`, decisão 31). Listar provedores vinculados no `/me` fica em espera até o front precisar. Descartados: fluxo redirect/BFF (o front já lida com o redirect), desvincular provedor, definir a primeira senha numa conta só-Google, restrição de domínio `hd` (produto é global, não B2B/Workspace) |
| ~~Throttle de `confirm` por e-mail~~ | — | **fechada pela fatia 17.** O cooldown de reenvio de 60s passou a valer também sobre pending esgotado, não só sobre um ainda usável. Decisão 34 |
| ~~CORS~~ | — | **já existe** em `src/infra/http/cors.ts` (lista de origens permitidas, registrado no `buildApp`). Entrou sem decisão no `DECISIONS.md` — registrar quando o primeiro front web definir a política |
| ~~Outbox transacional~~ | — | **fechada por esta fatia.** `outbox_messages` no módulo `auth`; os três avisos pós-commit (senha alterada, senha resetada, Google vinculado) são gravados dentro da mesma transação que muda o estado; `CronJob`s de dispatch e poda. Decisão 33; spec `2026-09-15-transactional-outbox-design.md` |
| ~~Listar sessões ativas~~ | — | **fechada pela fatia 18.** `GET /auth/sessions`, uma entrada por família ainda viva. Decisão 35 |
| ~~Invalidar sessões + notificar o dono na verificação~~ | — | **fechada pela fatia 19.** Faltava só a invalidação no vínculo do Google — troca e recuperação de senha já derrubavam sessão. Decisão 36 |
| ~~Deleção de conta~~ | — | **fechada pela fatia 20.** `DELETE /auth/me`, hard delete apoiado na cascata; varre os `pending_registrations` do endereço. Decisão 37 |
| ~~Revogação por usuário deletado/banido~~ | — | **fechada pela fatia 20**, sem código próprio: a cascata apaga os `refresh_tokens` junto com a conta |
| ~~Contexto de dispositivo + `iss`/`aud` + `helmet` + TTL~~ | — | **fechados pela fatia 21.** Ver a tabela da auditoria abaixo e a decisão 38 |

## Auditoria de 2026-09-07 — o que falta para dado sensível

Escopo: `src/modules/auth`, `src/infra`, `src/shared`. Scanner de arquitetura em
**0 achados**; `pnpm lint`, `typecheck` e `test:unit` verdes (372 testes). Tudo
abaixo é do que o scanner não prova.

A pergunta que a motivou foi se este `auth` serviria a um app de controle
financeiro. **Nada aqui declara que o produto é esse** — é o cenário contra o
qual os itens estão avaliados, e é o mesmo cenário que a §6 do
[`DECISIONS.md`](DECISIONS.md) já nomeia como gatilho.

Os itens desta auditoria que valem **independente** do produto subiram para
"Pendências do boilerplate", acima. O que sobra aqui é o que a escolha do app
decide.

### Achados que não estavam rastreados em lugar nenhum

| Item | Depende de | Nota |
|---|---|---|
| ~~Headers de segurança (`helmet`)~~ | — | **fechado pela fatia 21.** `@fastify/helmet` nos defaults, registrado como `registerHelmet` no molde de `registerCors`. Decisão 38 |
| ~~Contexto de dispositivo em `refresh_tokens`~~ | — | **fechado pela fatia 21.** `ip`, `device_label` e `session_started_at`, os três nuláveis; a rotação herda rótulo e início. `last_used_at` ficou **de fora**: a rotação descarta a linha, então o `createdAt` da linha viva já é o instante da última renovação. Decisão 38 |
| ~~Notificar o dono quando a detecção de reuso dispara~~ | — | **movido para "Pendências do boilerplate" (#3)**: vale para todo app com sessão, não só para dado sensível |
| ~~`kid` no JWT~~ | — | **movido para "Pendências do boilerplate" (#7)**, com o motivo real: evita estampida de refresh, não logout |
| ~~Trilha de auditoria~~ | — | **o mecanismo virou "Pendências do boilerplate" (#6)**; *o que* registrar e a retenção continuam sendo do produto, e é aqui que a LGPD art. 37 pesa |
| ~~Checagem de senha vazada~~ | — | **movida para "Pendências do boilerplate" (#5)**: todo app com senha bate nela |
| Custo do argon2 acima do mínimo | máquina alvo | 7,3 ms / 19 MB é o **mínimo** recomendado pela OWASP; o comentário do adapter já registra que tunar é "hardening, once there is a target machine" |
| Step-up / reautenticação | decisão em aberto | o access token não carrega `auth_time` nem `amr`, então operação de valor alto não tem em que se apoiar. Sentar o claim agora é barato; depois é migração de token |
| MFA / TOTP | decisão em aberto | não aparece em nenhum documento do repositório. É a maior ausência de produto para financeiro |
| Criptografia em repouso | fora do `auth` | nada de column-level nem `pgcrypto` no projeto. O `auth` não guarda o dado sensível, mas estabelece o precedente para o módulo que guardar |

### Decisões que cada produto toma

Nada aqui é lacuna do boilerplate. São escolhas que dependem do que o app faz,
de quem usa e de qual é o risco — e a escolha entre os dois apps derivados
(agregador financeiro ou app de alimentação) muda a ordem: o financeiro sobe
MFA, o de saúde sobe trilha de auditoria.

### O que a auditoria promove de "decisão aceita" para "pendência"

Nenhum destes é deslize — todos estão escritos e justificados. O que muda é o
contexto, não a análise:

- **Contagem de falha / lockout.** A §6 do `DECISIONS.md` define o gatilho para
  reabrir como *"o primeiro app derivado que trate dado sensível (saúde,
  financeiro)"*. O custo aceito está lá com todas as letras: mil IPs somam dez
  mil tentativas por minuto e **nada no servidor nota**.
- ~~**Store do rate limit é in-process.**~~ **Subiu para "Pendências do
  boilerplate" (#1)** em 2026-09-19: não precisa de dado sensível para doer,
  basta uma segunda réplica.
- ~~**Teto absoluto de sessão, mais idle timeout.**~~ **Subiu para "Pendências
  do boilerplate" (#4)**: a não-decisão viaja para todo app derivado.
- ~~**TTL do access token.**~~ **Fechado pela fatia 21:** o default caiu de
  3600s para 900s (decisão 38). Continua variável de ambiente para quem quiser
  outro valor. Custo aceito: o `/refresh` é chamado 4× mais por cliente ativo.

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

**RBAC / permissões.** Decisão tomada de **não** entrar no boilerplate:
reclassificada em 2026-09-17 de "decisão de arquitetura pendente" para
"escopo de produto", pelo mesmo argumento que fechou o outbox genérico —
sem um segundo consumidor real não há como validar a forma certa, e "quem
pode fazer o quê" varia por produto muito mais do que "como não vazar
sessão". Gatilho para reabrir: o primeiro app derivado que precisar de
acesso diferenciado por usuário. `DECISIONS.md` §6.

## O que eu faria a seguir

**Pegue a fila de "Pendências do boilerplate" na ordem.** Ela existe desde
2026-09-19 justamente para que a próxima fatia seja escolhível **sem** decidir
antes qual app vem primeiro — os sete itens valem para qualquer um deles.

~~Store do rate limit~~ — **fechado pela fatia 22** (decisão 39).
~~Dispatch do outbox sem trava~~ — **fechado pela fatia 23** (decisão 40).
~~Notificar o dono quando a detecção de reuso dispara~~ — **fechado pela fatia
24** (decisão 41).
~~Sessão sem teto absoluto~~ — **fechado pela fatia 25** (decisão 42). Restam o
#6 (trilha de auditoria, só o mecanismo) e o #7 (`kid` no JWT); o #5
(checagem de senha vazada) foi **adiado em 2026-09-19** com gatilho próprio, na
tabela acima.

**Se o alvo tratar dado sensível, entra a ordem da auditoria de 2026-09-07 por
cima desta**: ~~(1) log de evento de segurança~~ fechado em 2026-09-08;
~~(2) `helmet` e TTL do access token~~ fechados pela fatia 21; (3) colunas de
dispositivo — **fechadas pela fatia 21** — e ~~notificação de reuso~~,
**fechada pela fatia 24**; (4) reabrir o lockout; (5) trilha de auditoria e
~~teto absoluto de sessão~~, fechado pela fatia 25; (6) MFA.

**A escolha do app continua pendente** e muda só a ordem do que está em
"Decisões que cada produto toma": o financeiro sobe MFA, o de saúde sobe
trilha de auditoria.

~~Login social / OAuth com Google~~ — **entregue pela fatia 14** (decisão 31).
O `auth` agora tem identidade federada: cadastro, verificação, login por senha
**ou com Google**, sessão com rotação, troca e recuperação de senha.

~~Outbox transacional~~ — **entregue pela fatia 16** (decisão 33).
`outbox_messages` no módulo `auth`; os três avisos pós-commit são gravados
dentro da mesma transação que muda o estado. Fecha o furo de "crash entre o
`COMMIT` e o envio SMTP perde o e-mail em silêncio".

~~Throttle de `confirm` por e-mail~~ — **entregue pela fatia 17** (decisão
34). O cooldown de reenvio passou a valer também sobre pending esgotado.

~~Listar sessões ativas~~ — **entregue pela fatia 18** (decisão 35).
`GET /auth/sessions`, uma entrada por família ainda viva — sem informação de
dispositivo, que é item separado da auditoria.

~~Invalidar sessões + notificar o dono na verificação~~ — **entregue pela
fatia 19** (decisão 36). Faltava só o vínculo do Google derrubar sessão; o
aviso por e-mail já existia, e as outras duas rotas sensíveis já derrubavam.

**RBAC/permissões saiu da tabela em 2026-09-17** — não é mais decisão de
arquitetura pendente, é escopo de produto, adiado de propósito (mesmo
argumento do outbox genérico). Ver "Perguntas registradas, não pendências"
abaixo e `DECISIONS.md` §6.

~~Deleção de conta~~ — **entregue pela fatia 20** (decisão 37), e com ela
~~revogação por usuário deletado~~, que a cascata resolve sem código próprio.

~~Contexto de dispositivo, `iss`/`aud`, `helmet` e TTL~~ — **entregues pela
fatia 21** (decisão 38). `GET /auth/sessions` passou a devolver `ip`,
`deviceLabel` e `startedAt`, fechando a limitação que a decisão 35 registrou
como deliberada e dependente de migration.

Miúdo que ficou da fatia 14: listar provedores vinculados no `/me` — em espera
até o front ter necessidade disso.

Descartados, não pendências: fluxo redirect/BFF do Google (o front já lida com o
redirect, não há BFF neste desenho), desvincular provedor e definir a primeira
senha numa conta só-Google (nicho — a maioria dos apps com login social nem
oferece isso; reabrir se aparecer pedido concreto), restrição de domínio `hd`
(só faz sentido pra produto B2B/Workspace-only; este é um produto global).
