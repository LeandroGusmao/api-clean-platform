# Fatia 21 — Contexto de dispositivo na sessão, `iss`/`aud` e hardening de transporte: design

> Escrito em 2026-09-18, ao fim da fatia 20 (deleção de conta). Contexto de
> entrada: a tabela genérica do [`docs/TODO.md`](../../TODO.md) ficou **sem item
> desbloqueado** — o que resta são os achados da auditoria de 2026-09-07, que
> sobem de prioridade pelo gatilho de "app derivado que trate dado sensível"
> (`DECISIONS.md` §6).
>
> O gatilho foi levantado: o primeiro app derivado será ou um agregador de
> gastos e investimentos (Open Finance, B3) ou um app de alimentação e
> calorias. **Os dois disparam o gatilho**, por motivos diferentes — o de saúde
> guarda o que a LGPD nomeia como dado pessoal sensível (art. 5º, II); o
> financeiro guarda dado comum cujo vazamento tem consequência maior.
>
> Esta fatia recorta desses achados **apenas o que fica mais caro depois**, mais
> dois itens que são quase de graça. O critério está na §3.1.

## 1. O que esta fatia entrega

Cinco mudanças independentes:

1. **Contexto de dispositivo em `refresh_tokens`** — três colunas novas (`ip`,
   `device_label`, `session_started_at`), preenchidas em todo ponto que emite um
   refresh token, e propagadas pela rotação.
2. **`GET /auth/sessions` passa a responder "qual é qual"** — a resposta ganha
   os três campos, fechando a limitação que a decisão 35 registrou como
   deliberada e dependente de migration.
3. **`iss` e `aud` no access token** — o token passa a dizer quem o emitiu e
   para quem serve, e o verificador passa a exigir os dois.
4. **`@fastify/helmet`** — headers de segurança de transporte, hoje ausentes.
5. **TTL do access token de 3600s para 900s** — só o default; a variável de
   ambiente já existe.

## 2. O que esta fatia NÃO entrega, e por quê

**`kid` e rotação de duas chaves.** O `TODO.md` justifica esse item com "trocar
o segredo desloga todo mundo de uma vez". **Isso é falso nesta arquitetura**, e
a fatia corrige a linha (§13). `POST /auth/refresh` não passa pelo guard e não
lê o access token: ele consome só o refresh token opaco, que é persistido e não
tem relação com o `JWT_SECRET`. Trocar o segredo ao vivo, portanto, produz um
`401` por cliente ativo, seguido de um refresh transparente. O que o `kid`
compraria é evitar que todos os clientes corram ao `/refresh` no mesmo instante
— uma estampida, não um logout. Com zero usuário em produção, não há estampida
a evitar.

**`auth_time` e `amr`.** Nenhuma rota hoje pergunta há quanto tempo ou por qual
método o usuário se autenticou. O comentário de
[`ports/token-signer.ts`](../../../src/modules/auth/ports/token-signer.ts) já
fixa a regra: *"a contract is born with what has a consumer"*. Entram junto com
o primeiro step-up de verdade.

**Tabela de sessão própria.** É o modelo mais honesto — o próprio
`ListActiveSessionsUseCase` diz que "o `family_id` É a sessão", e as três
colunas desta fatia são, por natureza, atributos da sessão e não de cada elo da
corrente. Fica fora por custo e por não ter prazo: ver §4.3.

**Flag de "sessão atual".** Inalterada em relação à decisão 35, e agora menos
necessária: com rótulo de aparelho e data de início, o dono reconhece a própria
sessão sem que o servidor precise marcá-la.

**`last_used_at`.** Estava na lista original da auditoria e **sai aqui**: a
rotação descarta a linha e cria outra, então o `created_at` da linha viva já é
o instante da última renovação. Ver §4.2.

## 3. Decisões tomadas no brainstorming

### 3.1 O critério de recorte: o que não se conserta sozinho

Os achados da auditoria não têm todos a mesma urgência, e a diferença não é
gravidade — é **reversibilidade**.

O access token vive uma hora (900s depois desta fatia). Qualquer mudança no
formato dele se resolve sozinha em uma janela de TTL: sobe a versão nova,
espera o TTL, e todo token em circulação já é do formato novo. Nada precisa ser
migrado, porque nada persiste.

Uma coluna no banco não tem essa propriedade. O dado que não foi registrado no
momento em que existia não volta — e um backfill de `ip` ou `user_agent` não
tem de onde tirar valor nenhum.

**Portanto:** as colunas entram agora, enquanto a tabela está vazia e a
migration é de graça. Os claims do JWT entram só quando tiverem leitor, com a
exceção de `iss`/`aud`, que entram por serem baratos e por já terem um
consumidor previsível — o segundo sistema, que é justamente a premissa desta
fatia.

### 3.2 Rótulo derivado, não `User-Agent` cru

A coluna guarda `"Chrome no Android"`, não a string original de ~150
caracteres. Duas razões, e a segunda é a que decide:

- **Legibilidade.** `/auth/sessions` existe para o dono responder "fui eu?". A
  string crua não responde isso sem trabalho no cliente.
- **Minimização.** A string crua é um vetor de fingerprint — identifica o
  aparelho com precisão bem além do necessário para a pergunta que a coluna
  serve, e ficaria em repouso por até 60 dias. O rótulo derivado carrega o que
  a funcionalidade precisa e descarta o resto.

**Biblioteca: `bowser` (2.14.1, MIT).** `ua-parser-js`, que é a escolha
reflexa, está hoje em `2.0.10` sob **AGPL-3.0-or-later** — verificado no
registry, não assumido. Uma licença viral de rede num boilerplate destinado a
gerar produtos fechados é custo desproporcional para interpretar uma string.

### 3.3 O IP é o do request; o rótulo e o início da sessão são herdados

Ver §6. Em uma frase: o rótulo identifica o **aparelho** e não deve mudar no
meio da sessão; o IP acompanha a pessoa trocando de wi-fi para 4G; e a data de
início precisa atravessar todas as renovações, porque é a única informação que
a rotação destrói hoje.

### 3.4 `iss`/`aud` são obrigatórios, sem default

Um default derrotaria o propósito. Se os dois apps derivados subirem com o
mesmo valor herdado, um token de um continua valendo no outro, que é exatamente
o que os claims existem para impedir. Duas variáveis de ambiente novas,
**required** no schema de `env`.

### 3.5 O IP aparece na resposta de `/auth/sessions`

É o dado do próprio dono, devolvido a ele sob `Bearer`, e é metade do que torna
"fui eu?" respondível. É também o que GitHub e Google fazem nas telas
equivalentes. Sem mascaramento e sem geolocalização — geo exigiria base de
dados externa e é decisão de produto que ninguém tomou.

## 4. O modelo

### 4.1 As três colunas

Em [`schema/refresh-tokens.ts`](../../../src/modules/auth/infra/drizzle/schema/refresh-tokens.ts):

| Coluna | Tipo | Nulável | Origem |
|---|---|---|---|
| `ip` | `text` | sim | request que criou **esta linha** |
| `device_label` | `text` | sim | request que abriu a **sessão**, herdado na rotação |
| `session_started_at` | `timestamptz` | sim | `created_at` da primeira linha da família, herdado na rotação |

O arquivo segue sob a exceção do `CLAUDE.md` para nomes inline: nenhum dos três
é lido de outro arquivo.

`timestamptz` sem default, como todo o resto da tabela: o comentário de cabeçalho
do schema já explica por quê — a comparação de instantes exige que os dois lados
venham do `IClock`.

### 4.2 Por que `last_used_at` não entra

A rotação nunca atualiza uma linha: ela revoga a atual e insere a sucessora
(decisão 11). Então o `created_at` da linha não revogada **é** o instante da
última renovação, e uma coluna `last_used_at` ao lado dele mostraria o mesmo
número. O comentário de
[`list-active-sessions.ts`](../../../src/modules/auth/use-cases/list-active-sessions.ts)
já registra essa propriedade.

A granularidade que isso dá é o TTL do access token: um cliente ativo renova a
cada 900s, então `created_at` é "houve atividade nos últimos 15 minutos". Para
a pergunta que a tela serve, basta.

### 4.3 Por que não uma tabela de sessão

O modelo correto seria uma linha por família, com `started_at`, `ip`,
`device_label` e a FK saindo de `refresh_tokens`. Ele não entra aqui por dois
motivos:

**Custo.** `LoginUserUseCase` passaria a fazer duas escritas onde a documentação
da classe afirma, explicitamente, que faz uma só — *"writes to one repository,
so there is no atomicity to protect"* — e o raciocínio que a mantém fora de
transação é o custo do argon2 (§8 do design de unit of work). Reabrir isso
arrasta poda, `logout-all`, deleção de conta e `ListActiveSessions` junto.

**Não tem prazo.** Diferente das colunas, migrar para a tabela depois é barato:
o `ip`, o rótulo e o início já estarão gravados nas próprias linhas, então o
backfill tem de onde ler. É o inverso exato da situação que torna esta fatia
urgente.

### 4.4 A entidade

`RefreshToken` ganha `ip: string | null`, `deviceLabel: string | null` e
`sessionStartedAt: Date | null`, com os getters correspondentes e o mesmo
`cloneNullableDate` que `revokedAt` já usa. `CreateRefreshTokenProps` e
`TrustedRefreshTokenProps` ganham os três.

**Nuláveis, e isso é semântico, não conveniência.** Uma linha criada antes desta
fatia genuinamente não tem esse dado. Preencher com `'unknown'` tornaria "nunca
registramos" indistinguível de "registramos e não reconhecemos o aparelho" — e
a segunda é uma resposta legítima do parser, que precisa continuar distinta.

`RefreshTokenMapper` mapeia os três nas duas direções.

## 5. Como o contexto chega até a entidade

### 5.1 `src/infra/http/device-context.ts`

Irmão de [`client-ip.ts`](../../../src/infra/http/client-ip.ts), no mesmo
lugar e pelo mesmo motivo: transforma uma `FastifyRequest` em um valor simples,
e é o único ponto onde isso acontece.

```
buildDeviceContext(request): { ip: string; label: string }
```

- `ip` — delega a `clientIpKey`, que já valida e normaliza. Um valor inválido
  vira o sentinel `UNPARSEABLE_CLIENT_IP_KEY` que já existe, em vez de gravar
  texto escolhido pelo atacante numa coluna que será exibida de volta.
- `label` — `bowser` sobre o header `user-agent`. Header ausente, vazio ou
  irreconhecível produz um rótulo único e nomeado por constante, não `null`:
  `null` é reservado para "a linha é anterior à fatia" (§4.4).

O `label` tem largura limitada por constante antes de ser gravado. A string de
entrada é escolhida pelo cliente, e nem toda saída do parser é curta.

Nenhum use case importa `FastifyRequest` — a regra de camada do projeto não
muda.

### 5.2 Os sete pontos de emissão

`RefreshTokenIssuer.issue()` é o funil único, com sete chamadas:

| Arquivo | Chamadas | Papel |
|---|---|---|
| [`login-user.ts`](../../../src/modules/auth/use-cases/login-user.ts) | 1 | abre família |
| [`confirm-email.ts`](../../../src/modules/auth/use-cases/confirm-email.ts) | 1 | abre família |
| [`change-password.ts`](../../../src/modules/auth/use-cases/change-password.ts) | 1 | abre família |
| [`sign-in-with-google.ts`](../../../src/modules/auth/use-cases/sign-in-with-google.ts) | 3 | abre família |
| [`refresh-token.ts`](../../../src/modules/auth/use-cases/refresh-token.ts) | 1 | rotação (§6) |

A assinatura passa a ser:

```
issue(userId, familyId, now, context: IssuedSessionContext)
```

onde `IssuedSessionContext` é `{ ip, deviceLabel, sessionStartedAt }` — já
resolvido pelo chamador, para que o issuer não precise saber distinguir abertura
de rotação.

### 5.3 Commands e endpoints

Quatro commands ganham `device: { ip, label }`: `LoginUserCommand`,
`ConfirmEmailCommand`, `ChangePasswordCommand`, `SignInWithGoogleCommand`.
`RefreshTokenCommand` ganha só `ip` (§6).

Cinco endpoints ganham a chamada a `buildDeviceContext`: `login.ts`,
`confirm-email.ts`, `change-password.ts`, `sign-in-with-google.ts`,
`refresh.ts`.

**Esta é a maior parte do custo da fatia:** mudança larga e rasa, mecânica em
todos os pontos.

## 6. A rotação

A linha sucessora nasce com:

| Campo | De onde vem |
|---|---|
| `ip` | request atual |
| `device_label` | copiado da linha sendo substituída |
| `session_started_at` | copiado da linha sendo substituída, ou o `createdAt` dela quando for `null` |

O fallback da última linha é o que faz uma sessão **anterior** a esta fatia
adquirir um início assim que renovar: não o início real, mas o instante da
primeira renovação após o deploy — e a partir dali estável. Alternativa seria
deixar `null` para sempre; esta é melhor e não custa nada.

`RefreshTokenCommand` ganha apenas `ip` porque o rótulo e o início não vêm do
request: vêm da linha. `#issueInto` recebe o contexto já montado.

**A janela de graça e o ramo de reuso não mudam.** A linha emitida dentro da
janela de graça herda da mesma forma. A revogação de família por reuso não lê
nenhuma das colunas novas.

## 7. `iss` e `aud`

Em [`jwt-token-signer.ts`](../../../src/modules/auth/infra/providers/jwt-token-signer.ts):

- `sign` ganha `.setIssuer(...)` e `.setAudience(...)`.
- `verify` ganha `issuer` e `audience` nas opções de `jwtVerify`, que passa a
  rejeitar um token sem eles ou com valores diferentes.

A classe recebe os dois pela mesma fatia de config que já recebe `JWT_SECRET` e
`ACCESS_TOKEN_TTL_SECONDS` — o `Pick<AuthConfig, ...>` cresce em dois nomes, e o
padrão da decisão 23 se mantém.

Tokens emitidos antes do deploy param de verificar. É aceitável e é o mesmo
mecanismo da §3.1: uma janela de TTL de `401`s seguidos de refresh transparente,
e com zero usuário em produção, nem isso.

## 8. `helmet` e o TTL

**`@fastify/helmet` 13.1.1 (MIT).** Entra como
`registerHelmet(app)` em `src/infra/http/helmet.ts`, no formato exato de
`registerCors` e `registerRateLimit` — função exportada, não registro inline no
`buildApp`, pelo motivo que o comentário de `rate-limit.ts` já dá: uma spec
consegue montar um servidor pelado e exercitar o header sem banco.

Defaults do plugin. A posição no `buildApp` fica junto de `registerCors`, antes
de qualquer rota.

**`DEFAULT_ACCESS_TOKEN_TTL_SECONDS`: 3600 → 900.** Só o default em
[`config.ts`](../../../src/modules/auth/config.ts); `ACCESS_TOKEN_TTL_SECONDS`
já é variável de ambiente. O número é a latência real de revogação do
`logout-all`: até esta fatia, revogar uma sessão roubada deixava o atacante com
até uma hora de acesso.

Custo: o `/refresh` passa a ser chamado 4× mais por cliente ativo. Cada chamada
é uma transação com rotação. Aceito — é a troca que o item existe para fazer.

## 9. `/auth/sessions`

`ActiveSessionResult` ganha `ip`, `deviceLabel` e `startedAt`. O schema de
resposta do endpoint e o OpenAPI acompanham.

`ip` e `deviceLabel` são **nuláveis**, espelhando as colunas: uma sessão aberta
antes desta fatia não tem o que mostrar, e o cliente precisa saber disso.

`startedAt` **não é nulável**: cai para o `createdAt` da linha quando a coluna
é `null`, pela mesma razão do fallback da §6. O cliente nunca trata "sessão sem
início" — no pior caso o valor é mais recente que o início real, e converge
assim que a sessão renovar.

A query não muda: continua plana, sem `GROUP BY`, pelo argumento da decisão 35.

## 10. Config

Duas variáveis novas no schema de `env`, **sem default**:

| Variável | Papel |
|---|---|
| `JWT_ISSUER` | valor do claim `iss`, exigido na verificação |
| `JWT_AUDIENCE` | valor do claim `aud`, exigido na verificação |

`src/infra/config/fixtures/test-env.ts` ganha as duas, e `env.spec.ts` ganha a
asserção de que a ausência de qualquer uma reprova o boot.

Nenhuma variável nova para as colunas, para o `helmet` ou para o TTL.

## 11. Testes

TDD, por unidade:

- **`device-context.spec.ts`** — header ausente, header vazio, string
  irreconhecível, string acima do limite de largura, UA de Chrome/Android e de
  Safari/iOS; IP inválido caindo no sentinel.
- **`refresh-token.spec.ts` (entidade)** — os três campos sobrevivem a
  `create`/`fromTrusted`; `sessionStartedAt` é clonado na entrada e na saída.
- **`refresh-token-issuer.spec.ts`** — o contexto chega à entidade intacto.
- **`refresh-token.spec.ts` (use case)** — a sucessora herda rótulo e início e
  grava o IP novo; a sucessora de uma linha com `sessionStartedAt` nulo herda o
  `createdAt` dela; a emissão dentro da janela de graça herda igual; o ramo de
  reuso continua revogando a família.
- **`jwt-token-signer.spec.ts`** — token com `iss` errado é rejeitado; com `aud`
  errado é rejeitado; sem os claims é rejeitado; o par correto verifica.
- **`login-user.spec.ts`, `confirm-email.spec.ts`, `change-password.spec.ts`,
  `sign-in-with-google.spec.ts`** — o contexto do command chega à linha salva.
- **`list-active-sessions.spec.ts`** — os três campos saem no resultado;
  `startedAt` cai para `createdAt` quando nulo.
- **e2e** — `GET /auth/sessions` devolve os campos novos após um login; o header
  do `helmet` está presente numa resposta qualquer.

## 12. Custos aceitos

1. **O rótulo envelhece.** `bowser` é lista de regex; um aparelho lançado depois
   da última versão da lib aparece como desconhecido. É o custo de não guardar a
   string crua, e foi escolhido de olhos abertos (§3.2).
2. **O `User-Agent` é escolhido pelo cliente.** O rótulo é uma afirmação do
   cliente sobre si mesmo, não um fato verificado. Serve para o dono reconhecer
   a própria sessão; não serve como prova em investigação.
3. **O IP é o que o proxy disser.** Depende de `TRUST_PROXY` estar correto, do
   mesmo jeito que o rate limit já depende.
4. **Dado repetido a cada rotação.** Rótulo e início são copiados linha a linha.
   É a consequência direta de não ter tabela de sessão (§4.3), e some junto com
   as linhas revogadas na poda.
5. **`/refresh` 4× mais frequente** (§8).
6. **Cinco commands e cinco endpoints tocados** por uma mudança mecânica (§5.3).

## 13. Emendas de documentação

- **`docs/TODO.md`** — a linha do achado `iss`/`aud`/`kid` afirma que *"trocar o
  segredo desloga todo mundo de uma vez"*. É falso: `/auth/refresh` não lê o
  access token. Reescrita para dizer o que o `kid` de fato compra (evitar
  estampida de refresh) e por que isso não é prioridade hoje. As linhas de
  "contexto de dispositivo", "helmet" e "TTL do access token" são marcadas como
  fechadas por esta fatia.
- **`docs/DECISIONS.md`** — decisão 38, registrando: o critério de recorte da
  §3.1, o rótulo derivado e a licença que descartou `ua-parser-js`, a herança na
  rotação, os `iss`/`aud` sem default, e o que ficou de fora com o motivo.
- **Decisão 35** — o parágrafo "Sem informação de dispositivo, de propósito"
  ganha emenda apontando para esta fatia, para não continuar lendo como estado
  atual.

## 14. Próxima fatia

Os achados da auditoria de 2026-09-07 que sobram, na ordem que ela propõe:
notificar o dono quando a detecção de reuso dispara — que agora tem em que se
apoiar, já que a sessão passa a ter rótulo e IP para citar no e-mail —, depois
reabrir o lockout, trilha de auditoria com teto absoluto de sessão, e MFA.

A escolha entre os dois apps derivados muda essa ordem: o financeiro sobe MFA,
o de saúde sobe trilha de auditoria. Decidir o app primeiro.
