# Fatia 20 — Deleção de conta: design

> Escrito em 2026-09-18, ao fim da fatia 19 (invalidação de sessão no vínculo
> do Google). Contexto de entrada: [`docs/TODO.md`](../../TODO.md), "o resto em
> ordem decrescente de urgência" — deleção de conta era o próximo item sem
> bloqueio, depois que RBAC saiu da tabela por ter sido reclassificado como
> escopo de produto (§6 do [`DECISIONS.md`](../../DECISIONS.md)).

## 1. O que esta fatia entrega

`DELETE /auth/me`: o dono apaga a própria conta, autenticado pelo access token,
confirmando com a senha atual quando a conta tem uma. A linha de `users` é
apagada de verdade — **hard delete**, não coluna `deleted_at` — e com ela caem,
pela cascata que o schema já declara, as linhas de `refresh_tokens`,
`federated_identities` e `password_reset_tokens` daquele usuário.

Entrega junto duas coisas que a cascata **não** cobre, e por motivos opostos:

1. **A varredura de `pending_registrations` daquele endereço**, que não tem FK
   para `users` por desenho (§3.2).
2. **Um aviso "sua conta foi apagada"**, gravado no outbox dentro da mesma
   transação (§3.3).

**Fecha junto o item "Revogação por usuário deletado/banido"** do `TODO.md`, que
dependia deste. Não precisa de código: apagar a linha de `users` apaga as de
`refresh_tokens` pela cascata, e um refresh com token de conta apagada não acha
linha nenhuma — `findByHashForUpdate` devolve `null` e o fluxo já responde 401.

**Não entrega** deleção por administrador, banimento, janela de arrependimento,
exportação de dados antes de apagar, nem trilha de auditoria. Ver §7.

## 2. Por que hard delete

A pergunta foi levantada no brainstorming: apps de verdade apagam mesmo, ou
fazem soft delete e guardam rastro?

**A resposta depende de obrigação legal que este repositório não tem.** Quem
guarda rastro guarda porque precisa provar depois que o pedido existiu — banco,
saúde, disputa fiscal. Este projeto é boilerplate: não existe conta real em
lugar nenhum, e o mesmo argumento que a decisão 26 usou para recusar uma
migration de backfill vale aqui.

**E a trilha de auditoria já é uma pendência adiada, com gatilho escrito.** A
auditoria de 2026-09-07 registrou "Trilha de auditoria — não existe tabela nem
evento de login, troca de senha ou revogação", e ela só sobe de prioridade se o
alvo tratar dado sensível. Criar uma tabela de eventos agora, só para a
deleção, resolveria esse problema maior pela metade e para um evento só — o
mesmo erro que a decisão 33 (outbox genérico em `shared/`) e a reclassificação
do RBAC evitaram de propósito.

**Consequência a registrar:** quando a trilha de auditoria for retomada pelo
gatilho que já existe, a deleção de conta é um dos eventos que ela deve
capturar. Isso fica escrito no `TODO.md`, junto do item.

**O schema já assume hard delete.** As três FKs para `users` carregam
`onDelete: 'cascade'`, escrito antes desta fatia. Cascata só dispara quando a
linha-pai realmente some: com soft delete, as três tabelas ficariam com linhas
vivas apontando para uma conta que o app considera morta — incluindo refresh
tokens que continuariam rotacionando. Escolher soft delete aqui exigiria
reescrever a revogação de sessão como passo explícito, e a decisão de schema
que já está no repositório é a favor do hard delete.

## 3. O modelo

### 3.1 — O que a cascata já faz, verificado no schema

| Tabela | FK para `users` | O que acontece no `DELETE` |
|---|---|---|
| `refresh_tokens` | sim, `onDelete: 'cascade'` | some junto — é o que fecha "revogação por usuário deletado" |
| `federated_identities` | sim, `onDelete: 'cascade'` | some junto — o vínculo não significa nada sem o usuário |
| `password_reset_tokens` | sim, `onDelete: 'cascade'` | some junto |
| `pending_registrations` | **não tem FK** | **sobrevive** — ver §3.2 |
| `outbox_messages` | **não tem FK** | sobrevive, e é isso que queremos — ver §3.3 |

Nenhuma migration nesta fatia: as três cascatas já estão declaradas.

### 3.2 — Por que `pending_registrations` precisa de varredura explícita

A tabela é indexada por e-mail, não por `user_id`, e não tem FK — por desenho,
porque um pendente nasce **antes** de existir qualquer linha em `users` (§1 do
design da fatia 11). A cascata não tem em que pegar.

O risco concreto, que o `TODO.md` já nomeava antes desta fatia: pendentes do
mesmo endereço coexistem de propósito, e o `confirm` consome **um**. Um irmão
não consumido, dentro do TTL de 15 minutos, sobrevive à criação da conta. Se a
conta for apagada dentro dessa janela, aquele código ainda vivo confirmaria uma
conta **nova** com o mesmo endereço — sem o antigo dono pedir nada.

O conserto não precisa de método novo: `IPendingRegistrationsRepository` já tem
`deleteAllByEmail`, escrito na fatia 14 para o caso vizinho de o Google tomar o
endereço. É o mesmo "apaga tudo daquele endereço, vivo ou não" de que esta
fatia precisa.

### 3.3 — O aviso, e por que ele sobrevive à própria conta

`outbox_messages` não tem FK para `users` — a linha carrega destinatário,
assunto e corpo, nada mais. Isso significa que o aviso pode ser gravado na
**mesma transação** que apaga a conta e continuar de pé depois: o `CronJob` de
despacho (decisão 33) o envia já sem conta nenhuma no banco.

O endereço é capturado **antes** do `delete`, da entidade já carregada.

**Por que avisar, se foi o próprio dono que pediu:** mesmo motivo das outras
três rotas sensíveis do módulo. Se quem pediu foi uma sessão roubada, o aviso é
a única chance de o dono real descobrir. É também a última mensagem que aquele
endereço vai receber deste app.

Precisa de uma função nova em `notifications/emails.ts` —
`accountDeletedEmail(to: Email)` — no molde das outras seis.

### 3.4 — `IUsersRepository.deleteById`

Método novo, com a forma que o módulo já usa para escrita que não é insert:
comando com primitivos, não entidade.

```ts
/**
 * Apaga a linha. As FKs com `onDelete: 'cascade'` levam junto
 * `refresh_tokens`, `federated_identities` e `password_reset_tokens`.
 *
 * Silencioso sobre id inexistente, como `updatePasswordHash`: o use case já
 * carregou o usuário, e transformar linha ausente em erro aqui duplicaria uma
 * decisão que é dele.
 */
deleteById(id: string): Promise<void>
```

Implementado em `DrizzleUsersRepository`, `InMemoryUsersRepository` e
`noopAuthRepos`.

## 4. O use case — `DeleteAccountUseCase`

Ordem normativa, pelas mesmas razões que `change-password.ts` documenta: argon2
nunca dentro de transação (§8 do design do unit of work), relógio lido uma vez
(R7), e a escrita toda dentro de um `uow`.

```
1. usersRepository.findById(userId)      // id vem do token, nunca do corpo
   -> null? UserNotFoundError (404)

2. user.passwordHash !== null?
     -> senha ausente OU errada? InvalidCurrentPasswordError (422)
     -> argon2 aqui, FORA da transação
   user.passwordHash === null (conta só-Google)?
     -> segue sem senha: a sessão válida é a prova (§5, decisão 2)

3. now = clock.now()                     // uma leitura só
   email = user.email                    // capturado antes do delete

4. uow(async ({ users, pendingRegistrations, outboxMessages }) => {
     await users.deleteById(user.id)                  // cascata leva as três
     await pendingRegistrations.deleteAllByEmail(email)
     await outboxMessages.save(OutboxMessage.create({ ... accountDeletedEmail(email) }))
   })
```

O use case não devolve nada: `Promise<void>`.

**Por que a ordem dentro do `uow` não é crítica aqui**, ao contrário da de
`change-password.ts`: as três escritas não disputam as mesmas linhas — uma
apaga `users`, outra apaga por e-mail em outra tabela, a terceira insere em uma
terceira. O `delete` vem primeiro por legibilidade, não por invariante.

## 5. Decisões tomadas no brainstorming

1. **Um passo, com a senha atual — não dois passos com código por e-mail.** O
   molde é `change-password.ts`, não o de recuperação de senha. Um segundo
   passo não torna a ação reversível, só a atrasa, e custaria tabela, TTL e
   cooldown novos repetindo infra que `verify`/`reset` já têm, para um caso que
   este boilerplate não tem evidência de precisar.
2. **Conta só-Google deleta com a sessão válida, sem senha.** Ela não tem senha
   para reapresentar, e a fatia que define a primeira senha numa conta federada
   não existe (segue fora do roteiro, §6 do `DECISIONS.md`). Bloquear até lá
   deixaria uma fração real de contas sem conseguir se apagar. O access token
   válido é a prova de posse que o resto do módulo já aceita.
3. **Avisa por e-mail, reusando o outbox.** Ver §3.3.
4. **Hard delete, sem trilha de auditoria.** Ver §2.
5. **Reusa `InvalidCurrentPasswordError` para senha errada E senha ausente.**
   Não há oráculo a proteger: quem chama já provou, pelo token, ser o dono
   daquela conta — sabe se cadastrou com senha ou com Google. Um erro novo só
   para "senha necessária" seria distinção sem consumidor.

## 6. HTTP

`DELETE /auth/me`, em `infra/http/endpoints/delete-account.ts`, registrado em
`routes.ts` com `{ container, guard }`.

- **Guard**, como `/me` e `logout-all`: o id sai de `getPrincipal(request).id`.
  Aceitar um `userId` no corpo aqui deixaria qualquer autenticado apagar a
  conta de qualquer um.
- **Corpo:** `{ password?: string }`, opcional no schema porque conta federada
  não tem o que mandar. Obrigatoriedade real é do use case, que sabe se a conta
  tem senha.
- **Resposta `204`**, e `clearRefreshCookie(reply)` incondicional — mesmo
  raciocínio de `logout-all`: se veio cookie, ele acabou de morrer no banco, e
  deixá-lo no navegador só produz um 401 confuso no próximo refresh.
- **Teto próprio de rate limit**, `accountDeleteRateLimit`, com o par
  `ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS` / `_WINDOW_SECONDS` em `config.ts`,
  default 10/60s. Um request aqui carrega um palpite de senha — mesma razão de
  login e de `change-password`, e par próprio pela razão que aqueles documentam:
  campo nomeado para uma rota e usado por outra é comentário que mente.
- **Status declarados:** 204, 400, 401, 404, 422, 429, 503.

## 7. Custos aceitos

1. **O access token sobrevive à conta, até 1h.** É a latência de revogação que
   a decisão 11 já aceitou e que o `logout-all` já documenta. Depois do delete,
   um request com aquele token passa pelo guard e morre no primeiro use case que
   procurar a linha — `/me` responde 404, que é exatamente o teste que
   `me.spec.ts` já cobre para "conta apagada com token ainda válido".
2. **Não há janela de arrependimento.** Apagou, foi. Um produto derivado que
   queira 30 dias de carência precisa de soft delete e de um job de expurgo, e
   isso muda o desenho — está registrado aqui para não parecer esquecimento.
3. **Nada é exportado antes de apagar.** LGPD art. 18 dá ao titular tanto a
   eliminação quanto a portabilidade; esta fatia entrega só a primeira.
4. **Sem trilha de auditoria.** §2. Quando o gatilho da auditoria de 2026-09-07
   disparar, a deleção é um dos eventos a capturar.
5. **Um e-mail apagado pode ser recadastrado imediatamente.** Não há reserva do
   endereço. É o comportamento esperado para boilerplate, e a varredura do §3.2
   é o que garante que o recadastro comece do zero, sem código velho vivo.

## 8. Testes

**Unidade — `delete-account.spec.ts`:**

- apaga o usuário, varre os pendentes do endereço e grava o aviso, tudo num
  `uow` só (asserção de `callLog`, como `change-password.spec.ts`);
- recusa com `InvalidCurrentPasswordError` quando a senha está errada, **sem
  abrir transação** — prova que argon2 roda antes e fora;
- recusa com `InvalidCurrentPasswordError` quando a conta tem senha e o corpo
  não manda nenhuma;
- conta só-Google (`passwordHash === null`) apaga sem senha nenhuma;
- `UserNotFoundError` quando o id do token não tem linha;
- o endereço gravado no aviso é o do usuário carregado, não o do request.

**Integração — `delete-account.spec.ts`:**

- `204`, e o `GET /auth/me` com o mesmo token passa a responder `404`;
- o refresh token daquela sessão para de funcionar (`POST /auth/refresh` → 401)
  — a prova de que a cascata realmente apagou as linhas;
- um pendente vivo do mesmo endereço some, e um `register` seguinte começa do
  zero;
- a linha de aviso fica em `outbox_messages`, não despachada, depois da conta
  já não existir;
- `401` sem `Authorization`, e `422` com senha errada;
- uma conta só-Google (criada via `POST /auth/google`) se apaga sem mandar
  senha.

**Integração — `drizzle-users-repository.spec.ts`:** `deleteById` remove a linha
e leva junto refresh token, identidade federada e token de reset do mesmo
usuário; a linha de outro usuário fica intacta. É o teste que prova a cascata
contra o Postgres de verdade, e não contra o que o schema diz.

## 9. Emendas de documentação

- **`DECISIONS.md`** — decisão 37, com §2 (hard delete e o porquê de não ter
  auditoria agora) e as cinco decisões do §5.
- **`TODO.md`** — fecha "Deleção de conta" e **"Revogação por usuário
  deletado/banido"** (§1); acrescenta ao item "Trilha de auditoria" que a
  deleção de conta é um dos eventos a capturar quando ele for retomado.

## 10. Próxima fatia

Depois desta, a tabela genérica do `TODO.md` fica sem item desbloqueado: o que
resta são os achados da auditoria de 2026-09-07 (`helmet`, TTL do access token,
colunas de dispositivo, trilha de auditoria, MFA), que só sobem de prioridade
pelo gatilho de dado sensível, e os miúdos em espera (listar provedores
vinculados no `/me`).
