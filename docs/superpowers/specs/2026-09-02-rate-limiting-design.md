# Fatia 8 — Rate limiting: `TRUST_PROXY`, a chave de cliente e o limitador da borda para dentro

> **Status:** desenho aprovado em 2026-09-02, não implementado.
> **Fatia anterior:** [`2026-08-31-refresh-token-design.md`](2026-08-31-refresh-token-design.md)
> **Consome as decisões:** 13 (taxonomia e envelope), 14 (env), 15 (`traceId` por ALS)
> **Emenda:** `DECISIONS.md` §6 — fecha a decisão em aberto de rate limiting, delegando à borda a metade que a aplicação não faz melhor

## 1. Objetivo

Fechar a única decisão em aberto do `DECISIONS.md` §6 que a auditoria classificou
como **"branco arquitetural, não wishlist"**: hoje `POST /auth/login` aceita
tentativas de senha infinitas, e nenhuma rota tem teto de requisição.

A fatia entrega **três coisas pequenas e uma decisão registrada**:

1. `TRUST_PROXY`, sem o qual qualquer limitador por IP conta errado atrás de
   proxy — inclusive um limitador de biblioteca.
2. `clientIpKey`, porque `request.ip` **não é** um endereço IP (§3.2).
3. `@fastify/rate-limit` como teto por IP, global e mais apertado no login.
4. O registro de que a **contagem de falha de autenticação** foi deliberadamente
   delegada à borda e ao custo do argon2 — decisão, não omissão (§10.1).

`/auth/refresh` não precisa da mesma proteção e não a recebe: adivinhar 32 bytes
de `randomBytes` não acontece. É o login que tem senha humana do outro lado.

## 2. Escopo

### Entra

- `TRUST_PROXY` no `infra/config/env.ts`, aplicado em `buildServer`.
- `infra/http/client-ip.ts` — `clientIpKey`, validação na fronteira.
- `@fastify/rate-limit` registrado no `buildApp`: teto global por IP, `/health`
  isento, teto mais apertado em `POST /auth/login`.
- O `429` no envelope do projeto, com `code` próprio.
- As duas armadilhas medidas no `ARCHITECTURE.md` §11.

### Não entra, e por quê

**Contador de falha de autenticação.** É a única peça que a borda não consegue
fazer, porque só a aplicação sabe que *a senha estava errada* — um limitador de
transporte conta requisição. Foi avaliada em profundidade e **deliberadamente
recusada**: exigiria uma porta de store, política de dois baldes na camada pura,
teto de memória com política de despejo e um caminho próprio para Redis. Ver
§10.1 para o custo aceito e §11 para o que reabre a discussão.

**Store distribuído.** O store da biblioteca é em memória. Com N réplicas, o
limite efetivo é N× o configurado (§10.2). A borda é quem tem visão global.

**Limitador escrito à mão.** Considerado e descartado: o argumento a favor
existia *enquanto* houvesse um contador fino na camada pura para compartilhar
store, relógio e classe de erro. Sem o contador, escrever à mão é reinventar
roda por nada.

## 3. Dois fatos medidos que mudaram o desenho

Medidos em 2026-09-02 contra o Fastify 5.12.1 e o `@fastify/proxy-addr` 5.1.0
efetivamente instalados. Ambos contradiziam premissas escritas na versão
anterior deste desenho.

### 3.1 — `trustProxy` com número é **inoperante**

`node_modules/fastify/lib/request.js:50-54`:

```js
if (typeof tp === 'number') {
  // Hop-count-only trust cannot validate the immediate peer. Fail closed so
  // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
  return function () { return false }
}
```

`trustProxy: 1` **constrói sem erro e nunca confia em ninguém**. `request.ip`
fica preso no `remoteAddress`. É a pior forma possível de configuração: parece
ligada e não está — e é exatamente o valor que todo tutorial mostra.

Medido também:

| valor | resultado |
|---|---|
| `'nao-e-um-cidr'` | lança **na construção**, `TypeError: invalid IP address: nao-e-um-cidr`, **`code: undefined`** |
| `'10.0.0.0/8,nao-e-um-cidr'` | lança igual — **não há aceitação parcial** |
| `'10.0.0.0/8'`, `'loopback'`, `'fe80::/10'` | constroem e funcionam |
| `0`, `false`, `''` | **observacionalmente idênticos** (`if (trustProxy)`, e `0` é falsy) |

Consequência: o schema **recusa** número ≥ 1, e **não precisa** validar sintaxe
de CIDR — o Fastify já morre no boot, e lista parcialmente inválida também.

### 3.2 — `request.ip` não é um endereço IP

Quando o peer é confiado, o Fastify devolve **o último token do
`X-Forwarded-For` cru, sem validação**:

| `x-forwarded-for` enviado | `request.ip` medido |
|---|---|
| `naoehip` | `"naoehip"` |
| `1.2.3.4a` | `"1.2.3.4a"` |
| `999.999.999.999` | `"999.999.999.999"` |
| `<script>alert(1)</script>` | a string inteira |
| 200 × `"A"` | string de 200 caracteres |

`typeof request.ip` foi `"string"` em todos os casos, nunca `undefined`, nunca
lançou. Mas **o conteúdo é escolhido pelo atacante, com comprimento arbitrário**
até o limite de header.

Isso importa porque o limitador guarda esse valor como chave no store dele: sem
validação, o atacante escolhe quantos bytes cada entrada ocupa e quantas
entradas distintas consegue abrir sem custo nenhum.

Em produção, com o proxy mais externo sobrescrevendo o header (§10.3), o valor
é um IP válido. `clientIpKey` existe para o caso em que **não** é — que é uma
premissa de infraestrutura que o código não consegue verificar.

## 4. `TRUST_PROXY`

Vive no `infra/config/env.ts`, porque não é de módulo nenhum (decisão 14).

**Aceita:** vazio ou `0` (não confia — o default), ou uma lista de redes
separada por vírgula (`10.0.0.0/8,loopback`, `fe80::/10`, `2001:db8::/32`).
O tipo de saída é `string | false` — número nenhum chega ao Fastify.

**Recusa, no boot:**

| valor | motivo |
|---|---|
| `true` | confia na entrada **mais à esquerda** do `X-Forwarded-For`, que o cliente escreve — qualquer um forja um IP novo por requisição e passa por cima de todo limite |
| `false` | ambíguo com o vazio, que já é o default; uma forma só para "não confia" |
| número ≥ 1 | **medido inoperante** (§3.1): aceita a config e nunca confia. Botão que não faz nada é pior que botão ausente |

O default é falha **fechada** por escolha. Atrás de proxy sem configurar, o
limitador bloqueia demais — ruidoso, descoberto na primeira hora. O inverso
contorna o rate limiting inteiro sem deixar rastro, e a §11 do
`ARCHITECTURE.md` já registra a mesma lógica para o cookie `Secure`: *falha
aberta em produção é pior que caça ao fantasma num laptop*.

**Não condicionar a `NODE_ENV`.** Ela tem `.default('development')` no `env.ts`,
então um deploy que esqueça de defini-la desligaria a proteção em silêncio — o
erro que o cookie `Secure` já documenta.

A sintaxe da lista **não** é validada por nós: o Fastify morre no boot de
qualquer jeito (§3.1), e duplicar a lógica do `@fastify/proxy-addr` é como as
duas divergem com o tempo. O custo é a mensagem feia, documentada no §11.

## 5. `clientIpKey`

Uma função em `infra/http/client-ip.ts`, infra global, sem dono.

```ts
/**
 * `request.ip` is NOT guaranteed to be an address. Measured on Fastify 5.12.1:
 * with a trusted peer it returns the last X-Forwarded-For token verbatim —
 * `naoehip`, `999.999.999.999`, 200 characters of `A`. It is attacker-chosen
 * text of arbitrary width, and it must not reach a rate limit store that way.
 *
 * Anything malformed collapses to ONE bucket, which is the useful behaviour: a
 * client forging addresses throttles itself, and the keyspace it can open stays
 * bounded at one. Falling back to the socket address instead would put every
 * client behind the proxy into a single bucket, which is the opposite.
 */
export function clientIpKey(request: FastifyRequest): string
```

Validação por `z.ipv4()` / `z.ipv6()` — medido rejeitando `naoehip`,
`1.2.3.4a`, `999.999.999.999` e 200 caracteres de `A`. Malformado devolve uma
constante única.

⚠️ **Validar não basta: é preciso normalizar também.** Substituir o
`keyGenerator` do plugin descarta o `normalizeIP` que ele aplicaria, e esse
default agrupa IPv6 por **/64** (medido: `2001:DB8:0:1::5` e `2001:db8:0:1::99`
viram ambos `2001:db8:0:1::`). Sem isso, um cliente IPv6 tem 2⁶⁴ endereços e
portanto **chaves ilimitadas de graça** — o limitador não limitaria nada para
metade da internet. O `normalizeIP` é exportado e importável como named export;
o `keyGenerator` compõe os dois.

Três propriedades caem disso: o comprimento passa a ser limitado pela própria
validação (≤ 45 caracteres para IPv6 textual), o número de chaves que uma origem
forjando endereços consegue abrir vira **um**, e o valor que entra no store
volta a ser o que o nome promete.

## 6. A configuração do limitador

`@fastify/rate-limit`, registrado no `buildApp` — infra global, como o
`fastifyCookie` e o `registerOpenApi` já são. O módulo `auth` **não** registra
plugin de transporte próprio.

| escopo | teto | janela | por quê |
|---|---|---|---|
| global | `RATE_LIMIT_MAX_REQUESTS` (300) | 60 s | anteparo de enxurrada, não limite de UX — um SPA conversador não chega perto |
| `POST /auth/login` | `LOGIN_RATE_LIMIT_MAX_REQUESTS` (10) | 60 s | encarece força bruta sem nenhuma máquina na camada pura |
| `/health` | isento | — | ver abaixo |

**A isenção do `/health` não é conveniência.** Se o teto estourasse e a liveness
probe do Kubernetes tomasse `429`, o orquestrador mataria o pod: o limitador
derrubaria a aplicação que existe para proteger.

⚠️ **Ela NÃO se faz com `allowList`.** Medido: `allowList: ['/health']` não
isenta nada — o array de strings é comparado com **a chave gerada**, não com o
path, e cinco chamadas ao `/health` tomaram `429`. É armadilha silenciosa:
parece configurado e não está.

A isenção é `config: { rateLimit: false }` **na própria rota**, tipada por
`FastifyContextConfig`. A alternativa que funciona — `allowList` como *função*
lendo `req.routeOptions.url` — foi descartada porque casa o path por string:
renomear a rota de health quebraria a isenção **em silêncio**, que é exatamente
o modo de falha que a isenção existe para evitar. Declarada na rota, ela viaja
junto com a rota.

`keyGenerator` recebe o `clientIpKey` do §5.

### Variáveis novas

| Variável | Onde | Default |
|---|---|---|
| `TRUST_PROXY` | `infra/config/env.ts` | *(vazio — não confia)* |
| `RATE_LIMIT_MAX_REQUESTS` | `infra/config/env.ts` | `300` |
| `RATE_LIMIT_WINDOW_SECONDS` | `infra/config/env.ts` | `60` |
| `LOGIN_RATE_LIMIT_MAX_REQUESTS` | `modules/auth/config.ts` | `10` |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `modules/auth/config.ts` | `60` |

Todas as numéricas com `.int().positive()`, **nunca `.nonnegative()`** — pelo
motivo já escrito no `config.ts` atual: zero desligaria a proteção em silêncio, e
recusar zero é também o que recusa valor vazio.

**A divisão segue a decisão 14, e ela não é arbitrária.** O teto global é do
core porque quem registra o plugin é o `buildApp`. O teto do login é do **módulo**
porque quem o declara é a **rota** — via `config: { rateLimit: … }` no schema do
endpoint —, e rota é do módulo. Ele chega ao endpoint pelo container, como o
`refreshTokenTtlSeconds` já chega. Por isso o login tem janela própria em vez de
reusar a global: reusá-la faria o módulo ler uma variável do core, que é
exatamente o que a decisão 23 impede por tipagem.

### Medido em 2026-09-02, contra a versão 11.2.0

Instalada fora do projeto e exercitada contra o Fastify 5.12.1 real:

| Fato | Resultado |
|---|---|
| Compatibilidade | `fp(..., { fastify: '5.x' })` — serve |
| O `429` passa pelo `setErrorHandler`? | **sim** — `throw params.errorResponseBuilder(...)`, e o default devolve um `Error` real com `statusCode = 429` e `code: undefined` |
| `Retry-After` | o plugin **já o define** na reply antes de lançar, e o header sobrevive ao throw (medido: `retry-after: 60`) |
| Headers `x-ratelimit-*` | presentes por default; `enableDraftSpec` troca para `ratelimit-*` |
| `config: { rateLimit: { max } }` por rota | funciona |
| `allowList: ['/health']` | **não isenta** — compara com a chave, não com o path |
| `keyGenerator` | recebe `req.ip` cru; medido devolvendo 200 caracteres de `"A"` |
| Rota inexistente (404) | o plugin **não roda** — ver §10.5 |

Pinar em versão exata (§11 do `ARCHITECTURE.md`: nenhum `^`, nenhum `~`).

> **Armadilha de ambiente, não do repositório.** A store do pnpm mora sob a
> revisão do snap do VS Code, então `pnpm add` recusa depois que o snap atualiza.
> O contorno é `--store-dir` apontando para a revisão de onde o `node_modules`
> está linkado. Este é o primeiro `pnpm add` desde que isso foi descoberto.

## 7. O `429` no envelope

Hoje o handler **já responde 429** sem nenhuma mudança: o ramo `isClientError`
pega qualquer `statusCode` entre 400 e 499, preserva o status e devolve o
envelope do projeto com `traceId`. O que sai errado é só o `code`, que fica
`BAD_REQUEST`.

**Resolvido pela medição do §6:** o plugin lança, o erro passa pelo
`setErrorHandler`, e o `Retry-After` já vem definido na reply. Então o conserto
é **um ramo no handler**, antes do `isClientError`:

```ts
const TOO_MANY_REQUESTS_STATUS = 429

// Before `isClientError`, which would otherwise flatten this into
// `BAD_REQUEST`. Keyed on the status and not on the plugin's error, so the
// library's name never becomes public contract — the same reasoning that keeps
// `FST_ERR_*` out of the envelope. `Retry-After` is already on the reply: the
// plugin sets it before throwing, and the header survives.
if (isClientError(error) && error.statusCode === TOO_MANY_REQUESTS_STATUS) {
  return reply
    .status(TOO_MANY_REQUESTS_STATUS)
    .send(buildErrorResponse(TOO_MANY_REQUESTS_CODE, error.message, traceId))
}
```

Nada de `errorResponseBuilder`: o default do plugin já produz um `Error` com
`statusCode`, e o envelope do projeto se monta onde todo envelope se monta.

**Nenhuma categoria nova na taxonomia.** A versão anterior deste desenho criava
uma oitava irmã `RateLimitedError`; ela existia para o contador da camada pura
ter o que lançar. Sem o contador, o `429` nasce inteiramente no transporte, que
é onde o `ARCHITECTURE.md` §8 já trata *"4xx do próprio Fastify"* — status
preservado, `code` do projeto. As sete categorias continuam sete.

## 8. A árvore

```text
src/
├── infra/
│   ├── config/env.ts                    # + TRUST_PROXY e os três tetos
│   └── http/
│       ├── client-ip.ts                 # NOVO — clientIpKey
│       ├── rate-limit.ts                # NOVO — registerRateLimit(app, env)
│       ├── server.ts                    # + trustProxy no construtor
│       ├── endpoints/health.ts          # + config: { rateLimit: false }
│       └── errors/error-handler.ts      # + o ramo do 429 (ver §7)
└── main/app.ts                          # + o registro do plugin
```

Em `modules/auth/`: `config.ts` ganha as duas variáveis do login, `container.ts`
as publica, e `endpoints/login.ts` declara o `429` na resposta e o
`config: { rateLimit }` da rota.

O registro fica em `infra/http/rate-limit.ts` e não solto no `app.ts`, pelo mesmo
motivo que `registerErrorHandling` e `registerOpenApi` já são funções: assim um
spec monta um servidor nu e exercita só o limitador, sem subir banco.

## 9. Testes

### Unidade

| Arquivo | O que prova |
|---|---|
| `infra/config/env.spec.ts` *(estendido)* | `TRUST_PROXY` recusa `true`, `false` e `1`; vazio e `'0'` viram "não confia"; lista de CIDR passa |
| `infra/http/client-ip.spec.ts` | IPv4 e IPv6 válidos passam intactos; `naoehip`, `1.2.3.4a`, `999.999.999.999` e uma string de 200 caracteres **colapsam na mesma chave** |
| `infra/http/rate-limit.spec.ts` | `429` no envelope depois do teto; `Retry-After` presente; **`/health` isento**; sobe servidor e usa `inject`, como `auth-guard.spec.ts` já faz |
| `infra/http/errors/error-handler.spec.ts` *(estendido)* | um erro com `statusCode: 429` publica `TOO_MANY_REQUESTS`, e não `BAD_REQUEST` — o ramo novo precede o `isClientError` |

### Integração

`tests/integration/login.spec.ts` estendido: `429` depois do teto da rota, no
envelope. E o teste que já existe —
`answers an unknown email exactly like a wrong password` — **continua verde**,
porque o limitador conta requisição e não consulta o repositório: e-mail
inexistente e e-mail real atingem o teto identicamente.

Constantes de rota e `code` continuam **escritas à mão** nos specs de
integração, nunca importadas do endpoint: elas *são* o contrato de fio.

### Falsificação

Prática do repositório: teste que nunca ficou vermelho não provou nada. Cada
mutação precisa produzir vermelho **no alvo previsto e em nenhum outro**.

| Mutação | Vermelho esperado |
|---|---|
| schema aceita `TRUST_PROXY=1` | recusa de hop count |
| `keyGenerator` usa `request.ip` cru | colapso da chave malformada |
| `/health` removido do `allowList` | isenção da probe |
| teto da rota de login removido | `429` no login |
| `code` do `429` volta a `BAD_REQUEST` | contrato do envelope |

## 10. Custos aceitos

### 10.1 — Não há contagem de falha de autenticação

O limitador conta **requisição**, não falha. Um ataque distribuído de senha
continua viável: cada IP gasta o teto da rota (10/min), e mil IPs somam dez mil
tentativas por minuto contra uma conta, sem nada disparar.

**É decisão de risco tomada, não esquecimento.** O que segura hoje:

- **argon2 a 7,3 ms e 19 MB por tentativa** — medido na fatia 3. Não substitui
  throttle (ataque distribuído ignora, e o custo é ele próprio vetor de DoS), mas
  o endpoint não nasce nu.
- **O teto por IP na borda**, que é onde uma botnet é visível de verdade.
- **A equalização de tempo do login**, que impede descobrir *qual* conta existe
  antes de atacá-la.

O que a decisão custa, dito com todas as letras: uma conta cujo e-mail é
conhecido e cuja senha é fraca pode ser quebrada por uma botnet paciente, e
**nada no servidor vai notar**. O gatilho para reabrir está no §11.

A alternativa recusada exigia porta de store, política de dois baldes na camada
pura, teto de memória com política de despejo e um caminho próprio para Redis —
tudo para reimplementar, pior, o que a borda já faz para a metade coarse do
problema.

### 10.2 — O store é por processo

Com N réplicas, cada uma conta a sua: o limite efetivo é **N× o configurado**.
Não é defeito da biblioteca — é o que store em memória significa. Um app
derivado que suba três pods herda isso, e é mais uma razão para o limite que
importa viver na borda.

### 10.3 — `TRUST_PROXY` assume que o proxy mais externo sanea o header

O código não consegue verificar isso. A regra é: **o proxy que o cliente alcança
sobrescreve o `X-Forwarded-For`; os internos acrescentam.** Se o mais externo
apenas acrescenta, o cliente escreve as primeiras entradas da cadeia.

Vale a mesma advertência para a proteção de borda em geral: ela só protege o
tráfego que **passa** por ela. Se o IP de origem for alcançável direto, o
atacante pula o Cloudflare/WAF inteiro. O conserto é restringir o ingress da
origem às faixas do CDN — infraestrutura, não código, e fora desta fatia.

### 10.4 — Rota inexistente não é limitada

Medido: numa requisição que não casa rota nenhuma, o plugin **não roda** — nem o
`allowList` é consultado. Um atacante martelando `/nao-existe` passa por fora do
limitador inteiro.

O custo real é baixo: o `setNotFoundHandler` responde sem tocar banco, sem
argon2 e sem alocar chave no store. Mas é tráfego não contabilizado, e é mais um
lugar onde a proteção que importa é a da borda — que limita antes de saber se a
rota existe.

### 10.5 — Chave malformada colapsa clientes legítimos juntos

Um cliente atrás de um proxy mal configurado cai no mesmo balde de todo mundo
que forja endereço, e é limitado junto. É o lado errado do trade-off para esse
cliente, e o lado certo para o sistema — e o sintoma aponta direto para a
configuração que precisa ser corrigida.

## 11. Emendas de documentação

- **`DECISIONS.md` §6** — a decisão em aberto *"Rate limiting e proteção contra
  brute force"* **fecha**, registrando o que entrou e, principalmente, que a
  contagem de falha de autenticação foi **delegada à borda e ao custo do
  argon2**, com o §10.1 desta spec como fundamentação. **Gatilho para reabrir:**
  o primeiro app derivado que trate dado sensível (saúde, financeiro), ou o
  primeiro incidente de conta comprometida por força bruta.
- **`ARCHITECTURE.md` §11**, *"Bibliotecas que falham em silêncio"* — ganha duas
  entradas, e as duas se qualificam pelo critério da seção (*o código parece
  certo, compila ou passa, e faz outra coisa*):
  1. **`trustProxy` com número é inoperante** no Fastify 5.12.1 — aceita a
     config e nunca confia em ninguém; e um CIDR inválido morre no boot como
     `TypeError` cru do `@fastify/proxy-addr`, com `code: undefined` e fora do
     formato de erro de env do projeto.
  2. **`request.ip` não é um endereço IP** — com peer confiado, é o último token
     do `X-Forwarded-For` sem validação nenhuma.
- **`ARCHITECTURE.md` §8** — a tabela *"as quatro coisas que não são da
  taxonomia"* ganha a linha do `429`, e fica explícito que ele **não** é
  categoria nova. **O próprio título da seção muda de "quatro" para "cinco"** —
  ele conta as linhas, e a auditoria de arquitetura pega comentário que mente.
- **`ARCHITECTURE.md` §2** — a árvore ganha `infra/http/client-ip.ts`.

## 12. Próxima fatia

Inalterada pelo que esta fatia decidiu. A ordem recomendada continua sendo:

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Troca de senha** | nada | dá gatilho ao `logout-all`, entregue sem consumidor; primeiro use case a escrever em `users` **e** `refresh_tokens` na mesma transação |
| **Verificação de e-mail** | provedor de e-mail | destrava `emailVerifiedAt`; primeira vez que *"persista dentro, envie depois do commit"* sai do papel |
| **Recuperação de senha** | verificação de e-mail | reusa `ITokenGenerator` e `ITokenDigest` como estão |
| **Poda de `refresh_tokens`** | entrypoint `cron.ts` | a tabela cresce sem limite hoje |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |

**Troca de senha é a menor** e fecha um laço já construído.

Continua sem dono a decisão de produto registrada no §6: a sessão não tem teto
absoluto. Os 60 dias são deslizantes, então quem der refresh toda semana nunca
reautentica. Não é furo — rotação e detecção de reuso cobrem roubo —, mas
ninguém decidiu.
