# 🧭 Estrutura e Fronteiras

Documento de trabalho da base. É o que **não muda** quando você adiciona feature:
onde as coisas moram, o que pode depender do quê, e como isso é garantido por
máquina em vez de por combinado.

Decisões de auth, erro, CI e observabilidade evoluem junto com o código e vivem em
[`ARCHITECTURE.md`](../ARCHITECTURE.md). O porquê de cada escolha e as
alternativas descartadas estão em [`DECISIONS.md`](DECISIONS.md).

---

## 1. O princípio, em uma frase

> **Código puro nunca depende de código que toca o mundo externo.**

"Mundo externo" é banco, HTTP, rede, sistema de arquivos, variável de ambiente,
**relógio** e **aleatoriedade**. Tudo isso entra por contrato e é implementado em
`infra/`.

Duas consequências práticas, que valem mais que a teoria:

- Regra de negócio roda em teste sem banco, sem servidor e sem esperar o tempo
  passar.
- Trocar Drizzle, Fastify ou o algoritmo de hash não toca `use-cases/`.

---

## 2. A árvore

### Anatomia de um módulo

Todo módulo tem a mesma forma. `<modulo>` é o domínio: `auth`, `billing`,
`orders`.

```text
src/modules/<modulo>/
│  ── PURO ─────────────────────────────────────────────────
├── entities/            # estado e comportamento de domínio
├── value-objects/       # valor com regra própria (Email, Money, CPF)
├── repositories/        # SÓ contratos de persistência
├── providers/           # SÓ contratos de serviço externo
├── use-cases/           # uma operação por arquivo (+ .spec.ts colocado)
├── dtos/                # entrada e saída dos use cases
├── errors/              # erros do módulo, sobre a taxonomia compartilhada
├── notifications/       # corpo dos e-mails do módulo, funções puras
├── config.ts            # schema Zod das env vars DESTE módulo
├── container.ts         # factory do grafo DESTE módulo
│
│  ── INFRA ────────────────────────────────────────────────
└── infra/
    ├── drizzle/         # mappers e repositórios concretos
    │   └── schema/     # UM ARQUIVO POR TABELA, nomeado pela tabela
    ├── in-memory/       # repositórios em memória, para teste unitário
    ├── providers/       # implementações concretas dos contratos
    └── http/
        ├── endpoints/   # 1 arquivo = schemas + handler + rota
        ├── middlewares/
        └── routes.ts    # agregador fino do módulo
```

**Por que as camadas não viram pastas.** `entities/` e `use-cases/` já dizem qual
camada são; um `domain/` e um `application/` por cima só repetiriam o nome e
aprofundariam o caminho diário. A separação que ganha pasta é a única que o lint
precisa enforçar: **puro versus `infra/`**.

**`notifications/`, novo na fatia 10 (verificação de e-mail).** O corpo de cada
e-mail é função pura — recebe os dados, devolve `EmailMessage` — e mora fora de
`use-cases/` de propósito: é o único arquivo do módulo que um não-engenheiro
pode querer reescrever, e um revisor consegue ler toda mensagem que o sistema
manda num lugar só.

### O resto da árvore

```text
src/
├── modules/                    # um diretório por domínio
│
├── infra/                      # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts           # merge dos schemas dos módulos + validação no boot
│   ├── database/client.ts      # conexão Postgres, instância Drizzle
│   ├── http/
│   │   ├── server.ts           # instância Fastify SEM rotas
│   │   └── error-handler.ts    # único lugar que mapeia erro → status
│   ├── observability/          # AsyncLocalStorage (traceId) + logger
│   └── providers/              # implementações transversais (clock, gerador)
│
├── shared/                     # transversal, sem dono
│   ├── errors/                 # AppError + taxonomia semântica
│   └── providers/              # contratos transversais (IClock, ITokenGenerator)
│
└── main/                       # entrypoints + composition root
    ├── container.ts            # compõe os containers dos módulos
    ├── http.ts                 # monta o container e REGISTRA as rotas
    ├── worker.ts
    └── cron.ts

tests/integration/              # suíte com banco real
drizzle/                        # migrations, forward-only
.dependency-cruiser.cjs         # a fronteira, em forma executável
```

**A distinção que confunde no começo:** `modules/<m>/infra/` é infra **daquele
domínio** — o repositório de usuários, os endpoints de auth. `src/infra/` é infra
**sem dono** — o servidor Fastify, a conexão do banco, o logger. Se você não
consegue dizer de qual módulo uma peça é, ela é global.

---

## 3. O que vai em cada pasta

| Diretório | Natureza | Responsabilidade |
|---|---|---|
| `entities/` | puro | Estado e comportamento de domínio |
| `value-objects/` | puro | Valor com regra própria e autovalidável |
| `repositories/` | puro | **Contratos** de persistência e o Unit of Work |
| `providers/` | puro | **Contratos** de serviço externo do módulo (hash, token) — o de e-mail (`IEmailSender`) é comum a todos os módulos e mora em `src/shared/ports/`, não aqui (§7.1 do design de verificação) |
| `use-cases/` | puro | Orquestra a regra; uma operação por arquivo |
| `dtos/` | puro | Entrada e saída do use case |
| `errors/` | puro | Erros do módulo, estendendo a taxonomia |
| `notifications/` | puro | Corpo dos e-mails do módulo, uma função pura por mensagem |
| `config.ts` | puro | Schema Zod das env vars do módulo |
| `container.ts` | composição | Monta o grafo do módulo |
| `infra/drizzle/` | infra | Schema, mappers, repositórios e UoW concretos |
| `infra/in-memory/` | infra | Repositórios em memória, para teste unitário |
| `infra/providers/` | infra | Implementações dos contratos de provider |
| `infra/http/` | infra | Endpoints, middlewares e rotas |

Dentro do puro não há restrição declarada: esses diretórios compõem livremente
entre si.

---

## 4. A regra de fronteira

Cinco tipos de elemento, **avaliados nesta ordem**:

| Ordem | Elemento | Padrão | Pode importar |
|---|---|---|---|
| 1 | `test` | `**/*.spec.ts` · `tests/**` | tudo |
| 2 | `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| 3 | `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · `module-infra` **do próprio módulo** |
| 4 | `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| 5 | `pure` | `src/modules/*/{entities,value-objects,repositories,providers,use-cases,services,dtos,errors,notifications}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |

### As quatro coisas que isso garante

1. **O puro não alcança `infra/` nenhum** — nem o do próprio módulo, nem o global.
   É o que impede um use case de importar o logger, o `env` já parseado ou o
   cliente do banco.
2. **Um módulo não alcança o `infra/` de outro** — a metade da comunicação entre
   módulos que contrato sozinho não resolve.
3. **`composition` e `test` são exceções deliberadas.** O composition root existe
   justamente para conhecer o concreto; o teste unitário precisa do repositório
   in-memory. Deixá-las implícitas é o que gera "exceção não documentada" e
   esvazia a regra.
4. **A ordem importa.** O padrão de `pure` casa com os `*.spec.ts` colocados — sem
   `test` avaliado antes, todo teste unitário é acusado por usar o in-memory e o
   CI quebra em todo módulo.

### O que isso significa para arquivo de schema

`infra/drizzle/schema/*.ts` é `module-infra`, então a linha 3 vale nele como em
qualquer outro arquivo: **FK dentro do módulo é normal, FK para a tabela de
outro módulo é proibida.** Entre módulos, coluna de id sem `.references()`, com
a integridade na aplicação. Ver decisão 24.

---

## 5. Como a fronteira é garantida

Por **`dependency-cruiser`**, não por disciplina.

> **Por que não um plugin de ESLint.** Plugin de boundaries **ignora em silêncio
> todo import que o resolver não resolve**, e nenhum resolver de ESLint entende o
> campo `imports` do package.json. Como todos os imports entre diretórios usam `#`
> (§7), o lint passaria verde sem enxergar nada.

### As três configurações sem as quais ele enforça ZERO

Verificado empiricamente. Cada uma sozinha desliga a regra **com exit 0**:

```js
// .dependency-cruiser.cjs
module.exports = {
  options: {
    tsPreCompilationDeps: true,          // (1)
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['development', 'node', 'import', 'require', 'default'], // (2)
      extensions: ['.ts', '.js'],
    },
    doNotFollow: { path: 'node_modules' },
  },
  forbidden: [ /* uma regra por linha da tabela da §4 */ ],
}
```

**(1) `tsPreCompilationDeps: true`** — sem isso, `import type` fica **invisível**.
Numa arquitetura contract-first, onde quase toda dependência entre camadas é uma
interface, some 42% das dependências: exatamente a metade da fronteira que a regra
existe para proteger.

**(2) `conditionNames` com `development`** — sem isso, `#modules/*` resolve para
`./dist/*.js` e as regras, escritas contra `^src/`, param de casar. Medido na mesma
árvore:

```
COM conditionNames  →  x 5 violations. 49 modules cruised.   exit=5
SEM                 →  ✔ no violations. 82 modules cruised.  exit=0
```

Note o detalhe traiçoeiro: **sem a condition ele cruza mais módulos e acha menos
violações** — parece estar trabalhando melhor.

**(3) TypeScript pinado em `<7`** — o `dependency-cruiser` suporta
`>=2.0.0 <7.0.0`. Com o TypeScript 7 (o port em Go) ele emite um **aviso**, não um
erro:

```
✔ no dependency violations found (0 modules, 0 dependencies cruised)
‼ missing-typescript-transpiler: ... (typescript: >=2.0.0 <7.0.0)
=== exit=0 ===
```

Zero módulos, exit 0, CI verde.

> **Guarda contra os três de uma vez:** o script `check:boundaries` deve **falhar
> se `modules cruised === 0`**. É a única checagem que pega qualquer um dos três
> modos de falha silenciosa.

### Critério de aceite

A configuração só vale se vier com fixtures que provem que ela funciona — **3
negativos que precisam falhar e 2 positivos que precisam passar**, todos escritos
com especificador `#`:

| Linha | Fixture | Esperado |
|---|---|---|
| `pure` | use case → logger e in-memory | **falha** |
| `module-infra` | `auth/infra/` → `orders/infra/` | **falha** |
| `global-infra` | `infra/http/` → `auth/infra/in-memory/` | **falha** |
| `test` | `.spec.ts` colocado → in-memory | passa |
| `composition` | `main/` → implementações concretas | passa |

Os dois positivos não são decorativos: o de `test` é o **teste de regressão da
ordem de avaliação** — removendo a exclusão de `test` do padrão de `pure`, ele
passa a ser acusado.

> As linhas `test` e `composition` podem importar tudo, então **não admitem
> fixture negativo**. Por isso o critério é 3 + 2, não 5.

---

## 6. Inversão de dependência na prática

Contrato no puro, implementação em `infra/`:

```ts
// modules/auth/repositories/users-repository.ts             (PURO)
export interface IUsersRepository {
  findByEmail(email: string): Promise<User | null>
  save(user: User): Promise<void>
}

// modules/auth/infra/drizzle/drizzle-users-repository.ts     (INFRA)
export class DrizzleUsersRepository implements IUsersRepository { /* ... */ }

// modules/auth/infra/in-memory/in-memory-users-repository.ts (INFRA)
export class InMemoryUsersRepository implements IUsersRepository { /* ... */ }
```

O use case depende da interface e não distingue um do outro — é isso que faz o
teste unitário rodar em milissegundos.

**O `new` acontece só em `container.ts`.** Endpoint e use case nunca instanciam
infra.

```ts
// modules/auth/container.ts
export function makeAuthContainer(db: Database, cfg: AuthConfig, clock: IClock) {
  const usersRepository = new DrizzleUsersRepository(db)
  const hashProvider    = new Argon2HashProvider()

  return {
    registerUser: new RegisterUserUseCase(usersRepository, hashProvider, clock),
  }
}
export type AuthContainer = ReturnType<typeof makeAuthContainer>
```

**O módulo recebe a fatia dele**, nunca o objeto global — vale para a config e
para o container. Isso faz o compilador barrar acesso entre módulos, sem depender
de lint.

---

## 7. Imports

Não há path alias. O projeto usa **subpath imports do Node**, resolvidos pelo
runtime — sem etapa de reescrita e sem bundler.

```jsonc
// package.json
"type": "module",
"imports": {
  "#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" },
  "#shared/*":  { "development": "./src/shared/*.ts",  "default": "./dist/shared/*.js"  },
  "#infra/*":   { "development": "./src/infra/*.ts",   "default": "./dist/infra/*.js"   }
}
```

**Duas regras, sem exceção:**

- **Entre diretórios de topo:** `#modules/...`, `#shared/...`, `#infra/...` — é a
  forma que o `dependency-cruiser` inspeciona.
- **Dentro da mesma pasta:** relativo **com extensão `.js`** —
  `import { toDomainUser } from './user-mapper.js'`. ESM com `nodenext` exige a
  extensão.

```jsonc
"dev":   "tsx --conditions=development src/main/http.ts",
"build": "tsc",
"start": "node dist/main/http.js"
```

> **Sem `--conditions=development`, com `dist/` presente, o processo sobe
> servindo código compilado velho enquanto você edita `src/` — sem nenhum aviso.**
> Confirmado em teste. É a pegadinha mais difícil de perceber do setup.

---

## 8. Comunicação entre módulos

> **Regra de ouro:** entre módulos, só via use case ou contrato. Nunca invoque o
> handler HTTP de outro módulo, nem faça chamada HTTP interna ao próprio servidor.

**1. Injetar o contrato do módulo alvo** — recomendado, cobre a maioria:

```ts
// modules/orders/use-cases/create-order.ts
constructor(
  private ordersRepository:   IOrdersRepository,
  private productsRepository: IProductsRepository,  // contrato do outro módulo
) {}
```

**2. Reusar o use case do módulo alvo** — quando há efeito colateral ou regra
complexa (reservar estoque, aplicar cupom). Injete o use case, não o repositório.

**3. Eventos de domínio** — desacoplamento completo, para preparar extração em
serviço separado.

### Antipadrões

- ❌ **Chamada HTTP interna** — `axios.get('/api/products/123')` no mesmo processo
- ❌ **Reusar handler HTTP** de outro módulo
- ❌ **Importar `infra/` de outro módulo** em vez do contrato
- ❌ **Alcançar o container de outro módulo** — impossível por construção

---

## 9. Nomenclatura

- Arquivo em `kebab-case.ts`
- Implementação concreta leva o prefixo da tecnologia:
  `drizzle-users-repository.ts`, `argon2-hash-provider.ts`
- Contrato não leva prefixo: `users-repository.ts`, `hash-provider.ts`
- Contrato de interface com `I`: `IUsersRepository`, `IHashProvider`
- Use case, um por arquivo, nomeado pela operação: `register-user.ts`
- Teste unitário colocado: `register-user.spec.ts`

---

## 10. Como adicionar um módulo novo

1. `mkdir src/modules/<modulo>` com a anatomia da §2 — crie só as pastas que vai
   usar.
2. **Domínio primeiro:** entidade e value objects. Sem pensar em banco nem HTTP.
3. **Contratos:** `repositories/` e `providers/` com o que o domínio precisa do
   mundo externo.
4. **Use cases por TDD**, contra o repositório in-memory. Aqui o módulo já tem
   valor e já está testado, sem nenhuma infra real.
5. **Infra depois:** schema Drizzle, mapper, repositório concreto. Os testes de
   use case não mudam.
6. **HTTP por último:** `endpoints/` e `routes.ts`.
7. **`config.ts`** se o módulo tiver env vars próprias, e registre o schema no
   merge de `infra/config/env.ts`.
8. **`container.ts`** montando o grafo, e registre a fatia em
   `main/container.ts`.
9. **Rode `check:boundaries`.** Se passar sem você ter pensado na fronteira, é
   porque a estrutura fez o trabalho.

A ordem não é burocracia: ela força o domínio a ser desenhado antes de qualquer
decisão de infraestrutura, que é o que mantém a fronteira honesta.

---

## 11. Estrutural que ainda não está fechado

| Assunto | Situação |
|---|---|
| **Superfície pública do módulo** | Um módulo precisa expor algo (ex.: um middleware de autenticação que todos consomem). Falta decidir a forma — barrel `index.ts`? pasta `public/`? caminho permitido na config? Enquanto isso, cada caso é **exceção declarada explicitamente** no `.dependency-cruiser.cjs`, nunca tolerada em silêncio. |
| **Alcance de `pure → pure` entre módulos** | Hoje é livre. A intenção é liberar só `repositories/`, `providers/`, `dtos/` e `errors/`, para que um módulo não se acople à entidade interna de outro. Sai junto com a decisão acima. |
| **Onde moram os fixtures de fronteira** | Precisam estar em caminhos reais de `src/` para serem classificados — mas aí entram no build. Em `tests/` viram tipo `test` e não testam nada. Falta a convenção (provavelmente `exclude` no tsconfig). |
| **`config.ts` e o tipo `Env`** | `config.ts` é `pure` e não pode importar de `src/infra/`. A factory de config do módulo deve receber `Record<string, unknown>`, não o `Env` global. |
