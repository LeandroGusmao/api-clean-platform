# Fatia 25 — Teto absoluto de sessão

## 1. Objetivo

Fechar o item #4 de "Pendências do boilerplate" do [`TODO.md`](../../TODO.md).
Os 60 dias do refresh token são **deslizantes**: cada rotação emite um token novo
que vale mais 60 dias a partir dali. Quem renova ao menos uma vez a cada 60 dias
nunca reautentica, e uma sessão roubada e **nunca detectada** (malware que lê o
token e renova em segredo, sem replay de token gasto) vive para sempre. A
detecção de reuso só pega o roubo quando os dois lados usam a mesma cadeia.

O TODO pedia "um `max_lifetime` por família, com idle timeout junto". O idle
timeout **já existe**: o TTL deslizante de 60 dias é exatamente "um token sem uso
por 60 dias morre". Falta só o teto absoluto.

A entrega: uma variável, `REFRESH_TOKEN_MAX_LIFETIME_SECONDS` (padrão 90 dias), e
todo token novo passa a vencer em `min(agora + TTL, início da sessão + teto)`.

## 2. Escopo

### Entra

- `REFRESH_TOKEN_MAX_LIFETIME_SECONDS` e o padrão `DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS`
  em `config.ts`, com o fixture de teste.
- `RefreshToken.create` aplica o teto ao calcular o `expiresAt`.
- `RefreshTokenIssuer` recebe o teto e o repassa; expõe `ceilingFor(start)`.
- `RefreshTokenUseCase` recusa a rotação quando o teto da família já passou.
- Decisão 42 no `DECISIONS.md` e as emendas da §10.

### Não entra, e por quê

| Item | Por quê |
|---|---|
| Coluna nova ou migration | O `session_started_at` da fatia 21 já é herdado por toda rotação; o teto é uma conta sobre ele |
| Código de erro novo, ou ramo novo no refresh | O token que passa do teto expira pelo caminho que já existe (§3.2). Um código próprio pediria um ramo que não é reuso e não é expiração comum |
| Campo "sua sessão acaba em X" na resposta | Nenhum cliente pede isso hoje; o contrato de fio não muda |
| Teto por família ou por usuário | O teto é global e o valor é decisão de cada app derivado, por variável de ambiente |
| Ajustar o `maxAge` do cookie | Ver custo 2 (§9) |
| Aviso ao dono quando o teto encerra a sessão | Não é evento de segurança: é o fim normal de uma sessão |

## 3. Fatos verificados que moldaram o desenho

### 3.1 — Existe um único ponto onde o vencimento nasce

`RefreshTokenIssuer.issue(userId, familyId, now, context)` é usado por login,
confirmação de e-mail, troca de senha, os três caminhos do Google e as duas
ramificações da rotação. Ele chama `RefreshToken.create({ now, ttlSeconds, … })`,
que faz `expiresAt = now + ttlSeconds`. Mudar ali cobre todos os fluxos.

### 3.2 — O teto sai de graça pelo caminho de expiração existente

O ramo "revogado" checa reuso antes de expiração (decisão 11, ordem normativa) e
o ramo seguinte faz `current.isExpired(now)` → `InvalidRefreshTokenError`. Um
token cujo `expiresAt` é o teto passa por esse ramo sem código novo. Não dispara
detecção de reuso, não revoga a família e não gera o aviso da fatia 24. O cliente
recebe 401 `INVALID_REFRESH_TOKEN`, que já significa "volte ao login".

### 3.3 — `session_started_at` sobrevive à rotação

A fatia 21 (decisão 38) grava `session_started_at` na linha do login e a rotação o
copia da linha substituída, porque ela a descarta. `inherit` em `refresh-token.ts`
já resolve o nulo: uma linha anterior à coluna adota o próprio `createdAt`. O
início é, portanto, sempre um instante, e é fixo para a família inteira.

### 3.4 — A borda do teto que encolhe

Um token ainda vivo (`expiresAt` no futuro) pode ter o teto da família no passado
se `REFRESH_TOKEN_MAX_LIFETIME_SECONDS` for **reduzido** depois de emitido. Sem
tratamento, a rotação emitiria um sucessor que nasce expirado: o cliente recebe
um par que já não renova, e o `expiresAt` de uma linha ficaria no passado desde
o insert. Precisa ser recusada.

### 3.5 — O cookie de refresh usa o TTL, não o `expiresAt`

`refresh-cookie.ts` recebe `refreshTokenTtlSeconds` e o usa como `maxAge` a cada
resposta. Perto do teto o cookie sobrevive ao token. Um token expirado enviado
pelo navegador cai no 401 normal.

## 4. Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Teto **absoluto** contado a partir de `session_started_at` | É o que a família já carrega desde a fatia 21; não desliza, que é o ponto |
| D2 | O teto **limita o `expiresAt`**, sem ramo novo | Reaproveita a expiração existente e a ordem normativa da decisão 11 (§3.2) |
| D3 | A regra mora em `RefreshToken.create` | É regra de domínio sobre o vencimento do token; o emissor só calcula o teto a partir do contexto |
| D4 | Padrão de **90 dias** | Relogin a cada trimestre para quem usa toda semana: limita uma sessão roubada e nunca detectada a três meses sem incomodar o uso normal. O idle de 60 dias segue valendo por baixo |
| D5 | Sem relação obrigatória entre teto e TTL | Um teto menor que o TTL simplesmente domina; forçar a ordem na validação só criaria um erro de configuração sem ganho |
| D6 | Rotação com o teto no passado é **recusada** com `InvalidRefreshTokenError` (§3.4) | Não emitir um sucessor que nasce expirado. Lançar é seguro aqui: nada útil foi escrito antes, e o rollback só desfaz uma revogação do sucessor na ramificação da janela de graça, o que devolve o estado anterior |
| D7 | A recusa fica no `#issueInto`, um ponto só | As duas ramificações de emissão da rotação passam por ali |

## 5. O modelo

Sem coluna, sem migration.

### 5.1 — A entidade

`CreateRefreshTokenProps` ganha `lifetimeCeiling: Date`, o instante a partir do
qual nenhum token da família pode valer. `create` calcula
`expiresAt = min(now + ttlSeconds, lifetimeCeiling)`. A comparação usa
`getTime()`; `new Date(millis)` é determinístico e não é o hazard de R7.

### 5.2 — O emissor

`RefreshTokenIssuer` recebe `maxLifetimeSeconds` depois de `ttlSeconds`. Expõe:

```ts
ceilingFor(sessionStartedAt: Date): Date
```

que devolve `sessionStartedAt + maxLifetimeSeconds`. O `issue` calcula
`start = context.sessionStartedAt ?? now` (o nulo só ocorre em quem chama de fora
de `inherit`; ali nunca é nulo) e passa `ceilingFor(start)` para `create`.

### 5.3 — A rotação

`#issueInto` verifica, antes de emitir:

```ts
if (this.issuer.ceilingFor(context.sessionStartedAt ?? now) <= now) {
  throw new InvalidRefreshTokenError()
}
```

O `context.sessionStartedAt` que `inherit` produz nunca é nulo; o `?? now` só
satisfaz o tipo. O `<=` é inclusivo na borda, como `isExpired`.

## 6. Config

`REFRESH_TOKEN_MAX_LIFETIME_SECONDS`: `z.coerce.number().int().positive()`, padrão
`DEFAULT_REFRESH_TOKEN_MAX_LIFETIME_SECONDS = 7_776_000`. `.positive()` pela mesma
razão de todo o arquivo: zero recusaria todo login, e rejeitar zero é o que
rejeita o valor vazio. O comentário da constante diz que um teto menor que o TTL
domina. O `container.ts` passa o valor ao emissor; o fixture de teste ganha a
constante.

## 7. Testes

**Unidade**
- Entidade: `expiresAt` é `now + TTL` quando o teto está longe; é o teto quando
  está mais perto que o TTL; o teto igual a `now + TTL` dá o mesmo instante.
- Emissor: `ceilingFor` soma o teto ao início; `issue` passa o teto certo para uma
  família nova (`start = now`) e para uma rotação (`start` herdado).
- Rotação: sucessor perto do teto nasce com `expiresAt` igual ao teto; com o teto
  no passado a rotação lança `InvalidRefreshTokenError` sem escrever e sem gravar
  aviso; a ramificação da janela de graça também recusa.
- Login continua com `expiresAt = now + TTL` quando o teto é maior.
- Config: o padrão é 90 dias; zero e vazio são rejeitados.

**Integração** (Postgres real)
- Login, avança o `session_started_at` no banco até passar do teto e o refresh
  responde 401 `INVALID_REFRESH_TOKEN`; a família **não** é revogada e o outbox
  fica sem aviso de reuso.
- Uma rotação antes do teto emite um token cujo `expires_at` na linha é o teto.

## 8. Custos aceitos

1. **O cliente não distingue "teto de sessão" de qualquer outro 401**, e o usuário
   é deslogado sem aviso prévio. O caminho para o login é o mesmo.
2. **O cookie de refresh mantém `maxAge` de 60 dias** a cada rotação, então perto
   do teto o cookie sobrevive ao token. O navegador manda um token expirado, toma
   401, e o fluxo normal o limpa.
3. **Sessões anteriores à fatia 21 ganham uma prorrogação única**: o nulo adota o
   `createdAt` da linha viva, que é a última renovação, e o teto conta dali.
4. **O teto é global.** Um valor por app derivado é trocar a variável.
5. **Reduzir o teto derruba sessões vivas** na próxima rotação delas (§3.4).
   Consequência desejada, e por isso a recusa em vez de emitir um token morto.

## 9. Emendas de documentação

- [`DECISIONS.md`](../../DECISIONS.md): decisão 42, com D1 a D7, o que foi recusado
  (código de erro próprio, coluna nova) e os custos do §8.
- [`TODO.md`](../../TODO.md): riscar o item #4, corrigir a nota ("idle timeout
  junto" já existia), atualizar o cabeçalho e a "Próxima fatia".
- Comentário de `DEFAULT_REFRESH_TOKEN_TTL_SECONDS` em `config.ts`: continua
  "sliding", agora com o ponteiro para o teto.

## 10. Próxima fatia

Depois do #4, restam o #5 (checagem de senha vazada, que espera a escolha entre
API externa e lista embarcada), o #6 (trilha de auditoria, só o mecanismo) e o #7
(`kid` no JWT).
