# Fatia 24 — Aviso ao dono quando a detecção de reuso dispara

## 1. Objetivo

Fechar o item #3 de "Pendências do boilerplate" do [`TODO.md`](../../TODO.md).
Quando um refresh token já gasto é reapresentado fora da janela de graça, o
`RefreshTokenUseCase` revoga a família inteira e responde 401
`REFRESH_TOKEN_REUSED`. O único rastro é uma linha de log (`securityEvent`); o
dono da conta só descobre quando o app o manda para a tela de login, sem saber
por quê. Troca e recuperação de senha e o vínculo do Google já mandam e-mail; o
roubo de sessão detectado, que é a defesa que sobra quando o atacante já tem a
sessão, não manda nada.

A entrega: na transição "família viva → família revogada por reuso", uma
mensagem entra no outbox, na mesma transação da revogação, nomeando o aparelho e
o início da sessão derrubada e o endereço de quem apresentou o token gasto.

## 2. Escopo

### Entra

- `revokeFamily` passa a devolver o número de linhas revogadas, nos dois
  repositórios (Drizzle e memória) e no `noop-auth-repos`.
- No ramo de reuso do `RefreshTokenUseCase`: se `revokeFamily` revogou algo,
  carregar o dono e gravar um `OutboxMessage` na mesma transação.
- `reuseDetectedEmail` em `notifications/emails.ts`.
- `IIdGenerator` injetado no `RefreshTokenUseCase` e no `container.ts`.
- Decisão 41 no `DECISIONS.md` e as emendas da §10.

### Não entra, e por quê

| Item | Por quê |
|---|---|
| Cooldown ou "último aviso enviado" | Recusado na conversa (§4, D1): exige estado novo e não compra segurança, porque a família já está morta |
| Aviso em reuso dentro da janela de graça | Não há revogação ali: o ramo revoga só o sucessor e emite outro. É retry de cliente, não detecção |
| Alterar a resposta da rota | Continua 401 `REFRESH_TOKEN_REUSED`; o cliente age pelo código |
| Aviso para o cliente ou para o atacante | O canal é o e-mail cadastrado, o mesmo dos três avisos existentes |
| Tabela de eventos de segurança | É o item #6 (trilha de auditoria); o log `securityEvent` continua sendo o registro |

## 3. Fatos verificados que moldaram o desenho

### 3.1 — O ramo de reuso dispara a cada replay

Em `refresh-token.ts`, todo token revogado com `replacedBy` fora da janela de
graça, ou revogado por logout (`replacedBy === null`), cai no mesmo ramo: chama
`revokeFamily` e devolve `REUSE_DETECTED`. O token gasto continua gasto para
sempre, então cada reapresentação percorre o ramo de novo. Um aviso gravado
ali sem condição vira um e-mail por tentativa, limitado só pelo rate limit da
rota: o atacante passa a usar o aviso para encher a caixa do dono.

### 3.2 — `revokeFamily` já distingue "vivo" de "morto", mas não conta

O `UPDATE` filtra `revoked_at IS NULL`. Na primeira detecção há pelo menos a
linha sucessora viva, então ele revoga ≥ 1. Nos replays seguintes revoga 0. A
informação existe no banco e é descartada porque o método devolve `void`.
Devolver a contagem é a mudança mínima; não precisa de coluna, tabela nem
relógio.

### 3.3 — Os outros caminhos que matam a família ficam sem aviso, e é o certo

`logout` chama `revokeFamily` e ignora o retorno. `logout-all`, troca e
recuperação de senha usam `revokeAllForUser`. Reapresentar depois disso um
token dessas famílias cai no ramo de reuso com contagem 0: nenhum aviso. Está
certo, porque o dono causou a revogação (ou já foi avisado por outro e-mail).

### 3.4 — Os dados que o aviso pode nomear

| Dado | De onde vem | O que descreve |
|---|---|---|
| `deviceLabel` | linha do token gasto (`current`) | a sessão derrubada; herdado pela rotação (decisão 38) |
| `sessionStartedAt` | idem; linha anterior à fatia 21 adota o `createdAt` | idem |
| `ip` | `command.ip`, resolvido na borda por `buildDeviceContext` | **quem apresentou o token gasto**: pode ser o ladrão ou o próprio cliente do dono com um retry fora da janela |

Os três podem ser `null` (linhas antigas; endereço que não parseia).

### 3.5 — O e-mail do dono está disponível dentro da transação

`AuthRepos` já traz `users` e `outboxMessages`. `users.findById` roda na mesma
transação. A deleção de conta apaga a cascata dos `refresh_tokens`, então uma
linha `current` sempre tem dono.

## 4. Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Aviso **só na transição** (`revokeFamily` revogou > 0) | Um e-mail por família comprometida, sem estado novo. Fecha o vetor de encher a caixa do dono (§3.1) |
| D2 | Pelo **outbox**, na mesma transação da revogação | Mesma razão dos três avisos existentes (decisão 33): uma queda entre a revogação e o envio não perde o aviso, e o SMTP não prende a requisição. É o caso em que perder o aviso em silêncio é pior |
| D3 | `REUSE_DETECTED` continua **retornado**, não lançado | Lançar desfaria a transação, e com ela a revogação e o aviso. A regra já existe no arquivo |
| D4 | O texto diz "uso suspeito", nunca "roubo" | O `ip` pode ser do próprio dono (§3.4). O texto cobre os dois casos |
| D5 | Campos `null` viram texto neutro no e-mail | Não inventar um valor nem deixar `null` aparecer no corpo |
| D6 | O dono é lido com `users.findById` dentro da transação | Ele já está disponível (§3.5); ler fora abriria uma janela entre a revogação e o aviso |

## 5. O modelo

Sem coluna, sem migration, sem entidade nova.

### 5.1 — `revokeFamily`

`IRefreshTokensRepository.revokeFamily(familyId, revokedAt): Promise<number>`,
"the number of tokens it revoked". No Drizzle, o mesmo `UPDATE` com
`.returning({ id })` e o tamanho do resultado; na memória, o número de linhas
que `#replace` alterou. `noop-auth-repos` devolve 0. `logout.ts` ignora o valor
e não muda.

### 5.2 — O e-mail

```ts
reuseDetectedEmail(to: Email, session: {
  deviceLabel: string | null
  sessionStartedAt: Date | null
  ip: string | null
}): EmailMessage
```

Função pura em `emails.ts`, com o assunto como constante. O corpo diz que um
token de renovação já usado foi apresentado de novo, que por isso a sessão de
`<aparelho>` iniciada em `<data em UTC>` foi encerrada, e que a tentativa veio
de `<endereço>`. Orienta a trocar a senha se o dono não reconhece, e diz que,
se foi ele com um app com problema, basta entrar de novo. Nulos viram
"an unknown device", "an unknown start time" e "an unrecognized address".

## 6. O ramo de reuso

```
if (!withinGrace) {
  const revoked = await refreshTokens.revokeFamily(current.familyId, now)

  if (revoked > 0) {
    const owner = await users.findById(current.userId)
    if (owner !== null) {
      await outboxMessages.save(OutboxMessage.create({
        id: this.idGenerator.generate(),
        message: reuseDetectedEmail(owner.email, { …session, ip: command.ip }),
        now,
      }))
    }
  }

  return REUSE_DETECTED
}
```

O `owner === null` não deveria acontecer (§3.5); é a guarda de tipo, e o ramo
não lança porque lançar desfaria a revogação (D3). O callback do `uow` recebe
`users` e `outboxMessages` além de `refreshTokens`. O `id` sai de
`idGenerator.generate()` dentro do callback, como em `change-password.ts`.

## 7. Wiring

`RefreshTokenUseCase` ganha `IIdGenerator` no construtor; `container.ts` o
injeta. Nenhuma variável de ambiente nova.

## 8. Testes

**Unidade**
- Reuso com a família viva grava exatamente um `OutboxMessage`, para o e-mail do
  dono, com aparelho, início da sessão e o `ip` **da requisição**.
- Replay do mesmo token com a família já morta: nada gravado, resposta igual.
- Reuso após `logout` (`replacedBy === null`): nada gravado.
- Reuso dentro da janela de graça: nada gravado.
- Campos `null` produzem o texto neutro; nenhum `null` literal no corpo.
- A resposta segue sendo `RefreshTokenReusedError`.
- `reuseDetectedEmail`: destinatário, assunto, os três dados no corpo, e a
  ausência de "stolen"/"theft".
- Repositório em memória: `revokeFamily` devolve a contagem, inclusive 0.

**Integração** (Postgres real)
- `revokeFamily` devolve a contagem certa e 0 na segunda chamada.
- **A prova do problema:** dois replays seguidos do mesmo token gasto deixam
  **uma** linha em `outbox_messages`. Sem a condição, o teste vê duas.
- A revogação e o aviso são atômicos: a linha do outbox só existe se a família
  está revogada.

## 9. Custos aceitos

1. **Um segundo ataque à mesma família não avisa de novo.** Ela já está morta.
2. **O `ip` do aviso é o de quem apresentou o token**, que pode ser o do próprio
   dono. O texto trata os dois casos (D4).
3. **O e-mail leva um endereço IP a um endereço cadastrado.** É o mesmo dado que
   `GET /auth/sessions` devolve ao dono (decisão 38), e vale ser mandado porque
   é a única defesa depois que o atacante já tem a sessão.
4. **Uma família cujo último token expirou sem ser revogado ainda conta 1** na
   primeira reapresentação e avisa, embora já estivesse morta por expiração. Uma
   vez só, e a poda a apaga depois.
5. **O aviso herda as garantias do outbox:** pode chegar atrasado e, numa queda
   entre o `send` e o registro, repetir (decisão 40).

## 10. Emendas de documentação

- [`DECISIONS.md`](../../DECISIONS.md): decisão 41, com D1 a D6, o §3.1 (o vetor
  que o desenho fecha) e os custos do §9.
- [`TODO.md`](../../TODO.md): riscar o item #3 e atualizar o cabeçalho; a
  linha "Notificar o dono…" da auditoria já está marcada como movida.
- [`2026-09-15-transactional-outbox-design.md`](2026-09-15-transactional-outbox-design.md):
  a lista dos "três avisos" passa a ser quatro.
- Comentários de `outbox-message.ts` e `unit-of-work.ts` que enumeram "os três
  avisos" passam a citar o quarto.

## 11. Próxima fatia

Depois do #3, o item #4 da fila: sessão sem teto absoluto. Depende de uma decisão
de produto que ainda não foi tomada.
