# Design — Error handler, taxonomia de erro e `traceId`

> **Data:** 2026-08-21
> **Status:** aprovado, aguardando plano de implementação
> **Consome as decisões:** 13 (taxonomia + handler), 15 (logging e correlação), 03 (endpoints), 02 (fronteira)

---

## 1. O que este bloco entrega

Três peças que só fazem sentido juntas:

1. **Taxonomia semântica de erro** na camada pura — o vocabulário que os módulos usam para lançar falha sem saber o que é HTTP.
2. **Error handler global** — o único ponto do sistema que traduz esse vocabulário para status e corpo HTTP.
3. **`traceId` por request** — o mesmo identificador no log e no corpo de erro, propagado por `AsyncLocalStorage`.

Separá-las produziria trabalho jogado fora: sem handler, os endpoints do primeiro módulo nasceriam com `try/catch` improvisado; sem taxonomia, o handler não teria o que mapear; sem `traceId`, o corpo de erro sai sem o campo que a decisão 13 define como parte do contrato.

**Este bloco vem antes do primeiro módulo**, e não depois. A decisão 13 afirma que "o use case só faz `throw` e o endpoint fica sem `try/catch`" — isso só é verdade se o handler já existir quando o módulo for escrito. Num boilerplate, a forma improvisada é justamente a que os apps derivados copiam.

## 2. O que as decisões 13 e 15 deixaram em aberto

Este design fecha quatro pontos que as decisões não cobriam:

| Ponto | Resolução | Onde está |
|---|---|---|
| De onde sai o `code` do corpo | Declarado explicitamente em cada erro concreto | §4 |
| O que vira `traceId` | `crypto.randomUUID()` gerado sempre, header de entrada ignorado | §6 |
| Erro 4xx do próprio Fastify (415, 413, 400 body vazio) | Status preservado, `code` único `BAD_REQUEST` | §7 |
| Rota inexistente | `setNotFoundHandler` → 404 `ROUTE_NOT_FOUND` no mesmo envelope | §7 |

E corrige um conflito com o `CLAUDE.md`: a decisão 13 exemplifica `super('Credenciais inválidas')`, mas o `CLAUDE.md` exige toda string de código em inglês. **Mensagens são em inglês.** O custo é zero porque a própria decisão 13 estabelece que `code` é o contrato e a chave de i18n, e que a `message` "nunca deve ser exibida crua" num app traduzido.

## 3. Estrutura de arquivos

```text
src/
├── shared/                          # NOVO — primeira camada pura do projeto
│   └── errors/
│       └── app-error.ts             # AppError + as 6 categorias
├── infra/
│   ├── observability/
│   │   ├── request-context.ts       # AsyncLocalStorage — o mecanismo, isolado
│   │   └── request-context.spec.ts
│   └── http/
│       ├── error-response.ts        # schema Zod do envelope — fonte única
│       ├── validation-issues.ts     # tradução Zod → códigos do contrato
│       ├── validation-issues.spec.ts
│       ├── error-handler.ts         # ÚNICO lugar que conhece status HTTP
│       ├── error-handler.spec.ts
│       └── server.ts                # + genReqId, + hook do ALS, + os dois handlers
```

`#shared/*` já está declarado no `imports` do `package.json` — nenhuma mudança lá.

**Os três registros ficam em `buildServer`, não em `main/http.ts`.** A regra do `ARCHITECTURE.md` §2 é que `server.ts` não registra **rotas**; error handler, not-found handler e hook são configuração da instância. Efeito colateral desejado: todo teste que monta um servidor já herda o contrato de erro, incluindo a suíte de integração existente.

## 4. Taxonomia — `src/shared/errors/app-error.ts`

```ts
export abstract class AppError extends Error {
  abstract readonly code: string
}

export abstract class NotFoundError extends AppError {}
export abstract class ConflictError extends AppError {}
export abstract class UnauthorizedError extends AppError {}
export abstract class ForbiddenError extends AppError {}
export abstract class ValidationError extends AppError {}
export abstract class BusinessRuleError extends AppError {}
```

Zero menção a HTTP, zero dependência. As seis num arquivo só porque são um conjunto fechado e se leem juntas.

Um erro concreto de módulo:

```ts
// src/modules/auth/errors/invalid-credentials-error.ts  (exemplo, não entra agora)
export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = 'INVALID_CREDENTIALS'

  constructor() {
    super('Invalid credentials')
  }
}
```

### Por que o `code` é declarado e não derivado

**Descartado — derivar de `constructor.name`** (`InvalidCredentialsError` → `INVALID_CREDENTIALS`): zero duplicação e impossível esquecer, mas faz o **nome da classe virar contrato público em silêncio**. Um PR de renome passa no typecheck, no lint e em todo teste, e quebra o `switch (error.code)` de todo app mobile em produção sem nenhum sinal no code review. Segundo modo de falha: `constructor.name` é string de runtime — sobrevive ao `tsc`, que não minifica, mas qualquer app derivado que troque para `tsup`/`esbuild` com mangling (o gatilho da decisão 19 existe) passa a emitir `"code": "A"`.

**Descartado — union type fechada em `shared/`**: o compilador impediria typo e o arquivo viraria o catálogo do contrato, do qual dá para gerar o enum do app mobile. Perdeu porque centraliza o que a decisão 14 já concluiu que pertence ao módulo: deletar o módulo `auth` (decisão 01) deixaria `INVALID_CREDENTIALS` órfão em `shared/`, exatamente o defeito que a decisão 14 rejeitou no "schema único global" de env.

**Fraqueza aceita:** nada impede dois erros declararem o mesmo `code`. O conserto — um teste que varre os erros exportados e falha em duplicata — fica para quando houver erros o bastante para valer.

### O que fica deliberadamente fora da base

`statusCode` (decisão 13 rejeitou), `name`, `cause`, timestamp e `details`. Nada entra sem um teste que o exija.

## 5. O contrato do corpo — `src/infra/http/error-response.ts`

Conforme a decisão 13, sem alteração de formato:

```jsonc
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid credentials", "traceId": "6eedbea3-…" } }
```

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid payload",
    "details": [
      { "field": "email",    "code": "INVALID_FORMAT" },
      { "field": "password", "code": "TOO_SHORT" }
    ],
    "traceId": "6eedbea3-…"
  }
}
```

O schema Zod desse envelope é a fonte única de três coisas: o tipo do que o handler envia, a documentação OpenAPI, e o exemplo do `ARCHITECTURE.md`.

`field` é omitido quando o issue não aponta para campo nenhum (path vazio — o corpo inteiro está errado).

## 6. `traceId` — `src/infra/observability/request-context.ts`

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  traceId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn)
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId
}
```

Em `server.ts`:

```ts
const app = Fastify({
  genReqId: () => randomUUID(),
  logController: new LogController({ requestIdLogLabel: TRACE_ID_LOG_LABEL }),
  // ...
})

app.addHook('onRequest', (request, _reply, done) => {
  runWithRequestContext(request.id, done)
})
```

### Por que `randomUUID()` e não o padrão do Fastify

O `genReqId` padrão é **um contador por processo** — o smoke test do bloco anterior logou `"traceId":"req-1"`. Com duas réplicas no ar, as duas emitem `req-1`; depois de um restart, o contador reinicia. Grepar um `traceId` no agregador devolve requests sem relação entre si, ou seja, a correlação que a decisão 15 existe para garantir não funciona fora de uma única instância.

**Descartado — ULID** (o formato que o exemplo da decisão 13 usa): ordenável por tempo e mais curto, mas custa uma dependência de produção para um ganho que o timestamp da linha de log já entrega. Node 24 não tem UUIDv7 no core — verificado; só `randomUUID` (v4).

**Descartado — honrar `x-request-id` de entrada**: correlacionaria borda e aplicação quando houver gateway. Perdeu porque hoje não existe gateway no projeto, e aceitar valor controlado pelo cliente num campo que vai para todo log exige validação de formato e tamanho — vetor de log injection sem isso. Acrescentar depois é mudar uma linha em `genReqId`. E a decisão 15 já registra que a propagação entre serviços de verdade é assunto do OTel (W3C `traceparent`), explicitamente adiado — reimplementar meia versão dele agora seria cargo cult.

### O que o ALS entrega hoje, honestamente

Dentro do error handler, `getTraceId()` é **comprovadamente equivalente** a `request.id`: o primeiro consumidor fora do fluxo de request (o client do banco logando query lenta, por exemplo) ainda não existe. Construído mesmo assim, por dois motivos: num boilerplate, o que não entra hoje não chega aos apps que já forkaram; e o handler lendo `getTraceId()` é o que mantém a migração para OTel como troca de **um arquivo**, conforme a decisão 15.

Isso está registrado aqui em vez de escondido, porque é uma exceção consciente à regra do `ARCHITECTURE.md` §4 de não construir sobre o vazio.

## 7. O handler — `src/infra/http/error-handler.ts`

Ordem de decisão:

```
1. hasZodFastifySchemaValidationErrors(err)  → 400 VALIDATION_ERROR + details[]
2. err instanceof AppError                   → status pela categoria + err.code
3. err.statusCode em 4xx                     → mantém o status, code BAD_REQUEST
4. qualquer outra coisa                      → 500 INTERNAL_SERVER_ERROR, corpo genérico
```

### O mapa das categorias, como dado

```ts
const STATUS_BY_CATEGORY: ReadonlyArray<[abstract new (...args: never[]) => AppError, number]> = [
  [NotFoundError, NOT_FOUND_STATUS],           // 404
  [ConflictError, CONFLICT_STATUS],            // 409
  [UnauthorizedError, UNAUTHORIZED_STATUS],    // 401
  [ForbiddenError, FORBIDDEN_STATUS],          // 403
  [ValidationError, BAD_REQUEST_STATUS],       // 400
  [BusinessRuleError, UNPROCESSABLE_STATUS],   // 422
]
```

Seis linhas que **não crescem com o número de erros de domínio** — a tese inteira da decisão 13, agora visível como tabela em vez de enterrada numa cadeia de `if`. As seis categorias são irmãs, todas estendendo `AppError` direto; se alguém fizer uma estender outra, a ordem passa a importar — fica documentado no `ARCHITECTURE.md`.

### Ramo 1 — validação do Fastify

A decisão 13 já registra que falha de validação **não é** da taxonomia: um corpo inválido chega como `Error` com `code: 'FST_ERR_VALIDATION'` e não é instância de `ValidationError`. Sem esse ramo primeiro, todo payload inválido responderia 500.

O guard usado é `hasZodFastifySchemaValidationErrors(err)` do `fastify-type-provider-zod`, não o `err.code === 'FST_ERR_VALIDATION'` que a decisão sugere — é mais preciso, porque confirma que os issues são do Zod e portanto traduzíveis pela tabela do §8. Rota com schema não-Zod cai no ramo 3 e responde 400 `BAD_REQUEST`, o que é seguro.

Cada item de `err.validation` traz `keyword` (o code do Zod), `instancePath` e `params` com o resto do issue (`origin`, `minimum`, `format`) — verificado no fonte da biblioteca (`src/errors.ts`, `createValidationError`).

### Ramo 3 — o buraco que a decisão 13 não cobriu

Um `Content-Type: text/plain` num POST vira `FST_ERR_CTP_INVALID_MEDIA_TYPE`, que não é `AppError`. Pela regra "não é `AppError` → 500", o cliente receberia **500 por erro dele**, e o log encheria de erro interno falso.

Regra: **se o erro carrega `statusCode` em 4xx, honre o status.** 4xx significa que o cliente errou, e a mensagem do Fastify nesses casos fala da requisição, não das entranhas. 5xx do Fastify cai no ramo 4 como qualquer desconhecido.

O `code` é um só, `BAD_REQUEST`, sem tabela por `FST_ERR_*`.

**Descartado — tabela explícita** (415 → `UNSUPPORTED_MEDIA_TYPE`, 413 → `PAYLOAD_TOO_LARGE`): contrato mais expressivo, mas é tabela que precisa ser mantida a cada versão do Fastify, e o caso não mapeado cai no genérico de qualquer forma.

**Descartado — repassar `FST_ERR_*` como `code`**: zero manutenção e máxima informação, mas o nome do framework vira contrato público e trocar de framework quebra clientes.

O argumento que decide: distinguir 413 de 415 é o que o **status HTTP já faz** — o mesmo com que a decisão 13 recusou o campo `status` do RFC 9457.

### Rota inexistente

`setNotFoundHandler` → 404 `ROUTE_NOT_FOUND` no mesmo envelope. Sem ele, o 404 do Fastify sai como `{"message":…,"error":"Not Found","statusCode":404}` e o envelope tem um furo logo no caso mais comum.

`NotFoundError` da taxonomia também responde 404, mas com o `code` do domínio. Status igual, `code` diferente, e está correto: "essa rota não existe" e "esse usuário não existe" são falhas distintas para o cliente.

### Ramo 4 — nada vaza

`message` fixa, sem stack, sem mensagem de driver, sem nome de host. `request.log.error({ err }, 'unhandled error')` registra tudo, correlacionado pelo `traceId`.

## 8. Tabela normativa — issue do Zod → `code` do contrato

`instancePath` (`/items/0/email`) vira `field` (`items.0.email`); path vazio omite o campo.

| issue do Zod | condição | `code` do contrato |
|---|---|---|
| `invalid_type` | — | `INVALID_TYPE` |
| `too_small` | `origin` string/array | `TOO_SHORT` |
| `too_small` | `origin` number/date | `TOO_SMALL` |
| `too_big` | `origin` string/array | `TOO_LONG` |
| `too_big` | `origin` number/date | `TOO_LARGE` |
| `invalid_format` | — | `INVALID_FORMAT` |
| `not_multiple_of` | — | `NOT_MULTIPLE_OF` |
| `unrecognized_keys` | — | `UNRECOGNIZED_KEYS` |
| qualquer outro, inclusive `custom` | — | `INVALID_VALUE` |

O fallback é o que impede uma versão nova do Zod de produzir `undefined` no corpo. Os dois exemplos que a decisão 13 cita — `INVALID_FORMAT` e `TOO_SHORT` — caem exatamente onde ela diz.

Sem essa tabela, cada app derivado publicaria um contrato de validação diferente, que é o risco que a decisão 13 aponta.

## 9. OpenAPI

`error-response.ts` exporta o schema Zod do envelope; um endpoint documenta seus erros com `response: { [BAD_REQUEST_STATUS]: errorResponseSchema }`.

**Não entra** plugin que injete respostas de erro em toda rota automaticamente: sem endpoint que lance nada hoje, seria maquinaria sobre suposição.

## 10. Plano de testes

Tudo na pista `unit` — `app.inject()` não abre porta e nada aqui toca banco. As rotas que lançam são registradas **dentro do spec**, não no `src/`, para não deixar código descartável no boilerplate.

| teste | prova |
|---|---|
| isolamento do contexto | dois fluxos async concorrentes não enxergam o `traceId` um do outro |
| cada categoria → status | o mapa das seis, uma asserção por linha |
| formato do envelope | `code`, `message` e `traceId` presentes, conforme a decisão 13 |
| `traceId` do corpo == do log | usa o `logStream` injetado que já existe — fecha o ciclo do `ARCHITECTURE.md` §5 |
| **erro inesperado não vaza** | `throw new Error('connection to 10.0.0.5:5432 refused')` → corpo genérico **sem** a string, e a string **presente** no log |
| payload inválido | 400 + `details[]` por campo, conforme a tabela do §8 |
| rota inexistente | 404 no envelope, não no formato do Fastify |
| `Content-Type` inválido | 415 preservado, não 500 |

O quinto é o que mais importa num boilerplate: a garantia de não-vazamento escrita como teste, e não como intenção no README.

## 11. O que foi verificado antes de escrever isto

Sondas descartáveis, rodadas contra as versões instaladas. Nenhuma delas tocou o `src/`.

| Suposição do design | Resultado |
|---|---|
| `abstract new (...args: never[]) => AppError` é aceito à direita de `instanceof` (§7) | ✅ compila limpo sob a strictness do projeto — sem `as`, sem `any` |
| `setErrorHandler` roda dentro do escopo aberto pelo hook `onRequest` (§6) | ✅ `getTraceId() === request.id` em throw síncrono, em throw depois de `await` e no `setNotFoundHandler` |
| `params.origin` distingue `string`/`array` de `number` em `too_small`/`too_big` (§8) | ✅ Zod 4.4.3 emite `origin: string \| array \| number`; a divisão TOO_SHORT/TOO_SMALL é implementável |
| `unrecognized_keys` aponta para campo? | ❌ vem com path vazio — é o caso que justifica `field` opcional no §5 |

Isto elimina o risco que o design tinha: o §6 dependia inteiramente do ALS sobreviver até o error handler, e agora há evidência em vez de suposição.

### Ainda em aberto, para a implementação

- **`setNotFoundHandler` convive com `@fastify/swagger`** sem sumir da spec nem quebrar `/docs`. Consequência se falhar: o registro do not-found handler muda de lugar, não o design.

## 12. Impacto no `ARCHITECTURE.md`

- §2 (árvore): entra `src/shared/`, primeira camada pura do projeto.
- §5 (config e log): `genReqId` com `randomUUID` e o porquê do contador padrão não servir.
- §7 (HTTP): o envelope de erro como contrato, e os dois handlers registrados em `buildServer`.
- Nova seção de erro, com o mapa das seis categorias e a tabela de validação.
- §12 ("o que ainda não existe"): sai "error handler e taxonomia de erro" e sai "`traceId` por `AsyncLocalStorage`".
