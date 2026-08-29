# Erros

Taxonomia semântica na camada pura, um único tradutor para HTTP. O use case
lança, o endpoint não trata, o handler responde.

> **Aqui está como usar.** O porquê de cada escolha está no
> [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) §8.

---

## Os arquivos

| arquivo | camada | faz |
|---|---|---|
| [`app-error.ts`](./app-error.ts) | pura | `AppError` + as 6 categorias abstratas |
| `src/modules/<m>/errors/*.ts` | pura | os erros concretos do módulo |
| [`error-handler.ts`](../../infra/http/errors/error-handler.ts) | infra | traduz erro → status + corpo |
| [`error-response.ts`](../../infra/http/errors/error-response.ts) | infra | schema Zod do corpo de erro |
| [`validation-issues.ts`](../../infra/http/errors/validation-issues.ts) | infra | issue do Zod → `code` do contrato |

Erro de módulo mora no módulo. `src/shared/errors/` guarda só as categorias.

---

## Como usar

**1. Crie o erro no seu módulo**

```ts
// src/modules/auth/errors/invalid-credentials-error.ts
import { UnauthorizedError } from '#shared/errors/app-error'

export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = 'INVALID_CREDENTIALS'

  constructor() {
    super('Invalid credentials')
  }
}
```

O `code` é escrito à mão, nunca derivado do nome da classe: renomear a classe não
pode mudar o contrato público. Mensagem em inglês (`CLAUDE.md`).

**2. Lance no use case**

```ts
if (!user) throw new InvalidCredentialsError()
```

**3. Não trate no endpoint**

```ts
async (request, reply) => {
  const result = await authenticate.execute(request.body)
  return reply.status(OK_HTTP_STATUS).send(result)
}
```

Sai `401` com `{"error":{"code":"INVALID_CREDENTIALS", ...}}`, sem você escrever
uma linha de HTTP.

---

## Qual categoria escolher

A pergunta é "que tipo de falha é esta", não "que status eu quero". O status vem
junto.

| categoria | use quando | status |
|---|---|---|
| `NotFoundError` | o recurso pedido não existe | `404` |
| `ConflictError` | o estado atual colide com a operação | `409` |
| `UnauthorizedError` | não autenticado, ou credencial inválida | `401` |
| `ForbiddenError` | autenticado, mas sem permissão | `403` |
| `ValidationError` | o **valor** é inválido pela regra de domínio | `400` |
| `BusinessRuleError` | o valor é válido, a **operação** não é permitida | `422` |

As duas confusões comuns:

- **`401` vs `403`** — se o usuário logar de novo e o erro sumir, é `401`; se
  continuar, é `403`.
- **`Validation` vs `BusinessRule`** — `"abc"` não é um CPF: `ValidationError`.
  Saldo `R$ 10` é válido, sacar `R$ 50` dele não é: `BusinessRuleError`.

`ValidationError` é validação de **domínio**, lançada por value object ou use
case. Payload inválido no corpo da requisição é pego pelo Zod antes do seu código
rodar e tem ramo próprio.

---

## Comportamento do handler

```mermaid
flowchart TD
    E([erro]) --> Z{"veio do Zod?"}
    Z -->|sim| R1["400 · VALIDATION_ERROR · details por campo"]
    Z -->|não| A{"AppError de uma das 6?"}
    A -->|sim| R2["status da categoria · code do erro"]
    A -->|não| C{"tem statusCode entre 400 e 499?"}
    C -->|sim| R3["status preservado · BAD_REQUEST"]
    C -->|não| R4["500 · INTERNAL_SERVER_ERROR · corpo genérico"]
```

- **A ordem é carregada de significado.** Erro de validação do Fastify carrega
  `statusCode: 400`; se o ramo do 4xx viesse antes, engoliria o `details[]`.
- **O ramo do 500 não vaza nada** — mensagem fixa, sem stack e sem texto de
  driver. O erro completo vai para o log, correlacionado pelo `traceId`.
- **`AppError` fora das seis categorias cai no 500**, de propósito: é erro de
  programação, não problema do cliente.
- **Rota inexistente** responde `404 ROUTE_NOT_FOUND`, no mesmo formato.

---

## A resposta

```jsonc
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid credentials",
    "traceId": "6eedbea3-43fd-4f2a-a41b-3a39336b0268"
  }
}
```

```jsonc
// validação ganha detalhe por campo
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid payload",
    "details": [
      { "field": "email",    "code": "INVALID_FORMAT" },
      { "field": "password", "code": "TOO_SMALL" }
    ],
    "traceId": "6eedbea3-43fd-4f2a-a41b-3a39336b0268"
  }
}
```

- **`code` é contrato**, estável, e serve de chave de i18n no cliente.
- **`message` não é contrato** — é para log e debug, e não deve ser exibida crua
  num app traduzido.
- **`traceId`** é o mesmo valor da linha de log daquela requisição.
- `field` é omitido quando o problema é o corpo inteiro, não um campo.

---

## Regras

| ✅ | ❌ |
|---|---|
| `throw new InvalidCredentialsError()` | `return { error: 'invalid' }` |
| `readonly code = 'INVALID_CREDENTIALS'` | derivar o `code` do nome da classe |
| estender uma das seis categorias | estender `AppError` direto |
| erro do módulo em `src/modules/<m>/errors/` | erro do módulo em `src/shared/` |
| endpoint sem `try/catch` | `try/catch` traduzindo erro para status |
| `import { X } from '#shared/errors/app-error'` | `import ... from '../../../shared/...'` |

**Nunca** adicione `statusCode` a um erro da camada pura. É o atalho óbvio e é o
que este desenho existe para impedir.

---

## Testes

Não teste que `NotFoundError` vira `404` — já está coberto em
[`error-handler.spec.ts`](../../infra/http/errors/error-handler.spec.ts), categoria por
categoria.

No use case, verifique o tipo:

```ts
await expect(authenticate.execute(input)).rejects.toBeInstanceOf(InvalidCredentialsError)
```

No endpoint, verifique o contrato — com constante nomeada no próprio spec, nunca
importada do erro, senão o teste vira tautologia:

```ts
const UNAUTHORIZED_STATUS_CODE = 401
const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS'

expect(response.statusCode).toBe(UNAUTHORIZED_STATUS_CODE)
expect(response.json().error.code).toBe(INVALID_CREDENTIALS_CODE)
```

<sub>O diagrama é Mermaid: o GitHub renderiza nativamente; no VS Code exige a
extensão <i>Markdown Preview Mermaid Support</i>.</sub>
