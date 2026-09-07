# O que falta

> Reescrito em 2026-09-07, ao fim da fatia 11. A versão anterior (2026-09-06)
> listava o account pre-hijacking como o único **buraco aberto** e a próxima
> fatia — a fatia 11 o fechou. Quem abrisse a versão anterior começaria pelo
> lugar errado.
>
> A versão de 2026-09-06 já havia corrigido uma anterior que listava rate
> limiting, troca de senha e verificação de e-mail como pendentes — as três
> entregues nas fatias 8, 9 e 10.

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

## 🟡 Recuperação de senha — o último endpoint do fluxo de auth, e agora desbloqueado

`POST /auth/password/forgot` e `POST /auth/password/reset`. É o único item do
roteiro que ainda é **endpoint ausente**; os outros nove existem. Hoje uma conta
com senha esquecida — ou tomada por qualquer outra via — **não tem caminho de
volta**: `POST /auth/password` exige a senha atual.

Estava travada atrás do pre-hijacking por um motivo concreto (construir
recuperação sobre um desenho vulnerável amplia a superfície). Com a fatia 11
fechada, **está desbloqueada e é a próxima fatia**.

Ficou barato: a fatia 10 pagou o provedor de e-mail e o thunk que mantém o envio
fora da transação; a fatia 11 deixou `EmailVerificationIssuer.issue`, o padrão de
tabela com hash/expiração/uso único e os `consume`/`registerFailedAttempt`
atômicos, o helper de teste `arrangeAccount` e a conta que **sempre** nasce
verificada. Contexto de continuação em
[`superpowers/2026-09-07-handoff-password-recovery.md`](superpowers/2026-09-07-handoff-password-recovery.md).

## O resto, em ordem decrescente de urgência

| Item | Depende de | Nota |
|---|---|---|
| Poda de tokens expirados | `cron.ts` | **duas** tabelas crescem: `refresh_tokens` (nada apaga) e `pending_registrations` (a poda oportunista da fatia 11 só limpa endereços que veem tráfego; abandonados ficam). A recuperação de senha adiciona uma terceira |
| Login social / OAuth (Google) | decisão em aberto | três sub-perguntas já resolvidas — ver `DECISIONS.md` §6. **Não** haverá troca de e-mail, por causa disto. Interage com a recuperação de senha (conta ligada ao Google não tem senha para "recuperar") |
| Throttle de `confirm` por e-mail | nada | um anônimo pode manter um endereço não-confirmável queimando o teto de cinco tentativas do código a cada cooldown — o teto por IP não segura. Conserto: throttle por conta/e-mail |
| CORS | primeiro front web | sem ele o modo cookie não funciona cross-origin |
| Outbox transacional | `cron.ts` / worker | um crash entre o `COMMIT` e o envio SMTP perde o e-mail em silêncio, e sobra um oráculo por **latência** no `resend`/`confirm` (o ramo que envia paga um round-trip). Custos aceitos, documentados no §11 da spec da fatia 11 |
| Listar sessões ativas | nada | cai quase de graça agora que há `family_id` |
| Invalidar sessões + notificar o dono na verificação | nada | defesa em profundidade que a literatura recomenda por cima da correção estrutural (§4.4 do handoff da fatia 11) |
| RBAC / permissões | decisão em aberto | acoplada à 11: role no JWT significa até 1h de latência para revogar permissão |
| Deleção de conta | não existe | quando existir, tem que varrer os `pending_registrations` do endereço — um código vivo remanescente confirmaria uma conta nova |
| Revogação por usuário deletado/banido | não existe deleção | a rotação é o lugar certo quando existir |

## Perguntas registradas, não pendências

**A sessão não tem teto absoluto.** Os 60 dias são deslizantes: um cliente que dê
refresh toda semana fica logado para sempre sem nunca reautenticar. A rotação e a
detecção de reuso cobrem roubo, então não é furo — é decisão de produto que
ninguém tomou. A saída usual é um `max_lifetime` por família.

**Contagem de falha de autenticação / lockout.** Decisão tomada de **não** fazer
no app: delegado à borda (Cloudflare/WAF) e ao custo do argon2. Gatilho para
reabrir: primeiro app derivado que trate dado sensível, ou primeiro incidente de
conta comprometida por força bruta. `DECISIONS.md` §6.

**Custos aceitos das fatias 10 e 11.** §12 da spec de verificação de e-mail
(treze), §11 da spec do pre-hijacking (os que sobrevivem e os novos). Os que mais
valem reler antes da próxima fatia: o `resend`/`confirm` é distinguível por
**latência**, e um pendente que perdeu a corrida do `users.save` fica
permanentemente não-resgatável.

**Colisão de nome de tabela entre módulos.** Arquitetural, não só do `auth`.
`DECISIONS.md` §6. **Multi-tenancy** idem.

## O que eu faria a seguir

Recuperação de senha. É o último endpoint ausente do fluxo de auth, está
desbloqueada agora que o pre-hijacking fechou, e a fatia 11 deixou quase toda a
infra pronta. Depois dela o `auth` está completo como boilerplate v1, e o próximo
grande bloco é o login social.
