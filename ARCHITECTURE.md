# Arquitetura

Documentação do que **existe neste repositório**. Nada aqui é plano ou intenção —
se está escrito, está construído e verificável rodando os comandos da §7.

Este é o único documento de arquitetura versionado. O material de referência em
`docs/` é rascunho local, fora do git — nada depende dele.

**Stack hoje:** Node 24 LTS (Krypton) · TypeScript 7 ESM · Fastify 5 · Zod 4 · PostgreSQL · Drizzle · Biome · pnpm

---

## 1. O princípio

> **Código puro nunca depende de código que toca o mundo externo.**

"Mundo externo" é banco, HTTP, rede, arquivo, variável de ambiente, relógio e
aleatoriedade. Tudo isso entra por contrato e é implementado em `infra/`.

Ainda não há código puro no repositório — existe `infra/` e existe `main/`. O
princípio está aqui porque é ele que decide onde cada arquivo novo vai cair.

---

## 2. A árvore

```text
src/
├── infra/                  # infra GLOBAL, sem dono de módulo
│   ├── config/env.ts       # ÚNICO lugar que lê process.env
│   ├── database/client.ts  # pool pg + instância Drizzle
│   └── http/
│       ├── server.ts       # instância Fastify, SEM rotas
│       └── endpoints/
│           └── health.ts   # GET /health — liveness + conexão com o banco
└── main/
    └── http.ts             # entrypoint: valida env, abre o banco, sobe o servidor
```

`src/infra/` é infra **sem dono** — o servidor, a config e a conexão do banco.
Futuramente, o logger. Quando existirem módulos, `src/modules/<m>/infra/` será a
infra **daquele domínio**. Se você não consegue dizer de qual módulo uma peça é,
ela é global.

**Divisão de responsabilidade que já vale:** `infra/http/server.ts` constrói e
configura a instância Fastify e a devolve **sem nenhuma rota**. Quem registra
rotas, prefixos e plugins é `main/http.ts`. Essa linha é o que permite ao servidor
ser montado num teste sem arrastar o roteamento inteiro junto.

---

## 3. Imports

Não há path alias. O projeto usa **subpath imports do Node**, declarados em
`package.json`, resolvidos pelo runtime — sem etapa de reescrita, sem bundler.

```jsonc
"imports": {
  "#modules/*": { "development": "./src/modules/*.ts", "default": "./dist/modules/*.js" },
  "#shared/*":  { "development": "./src/shared/*.ts",  "default": "./dist/shared/*.js"  },
  "#infra/*":   { "development": "./src/infra/*.ts",   "default": "./dist/infra/*.js"   }
}
```

Os três namespaces estão declarados; só `#infra/*` tem conteúdo hoje. Os outros
dois ficam de pé para que criar o primeiro módulo não exija mexer no
`package.json`.

**Duas regras, sem exceção:**

- **Entre diretórios de topo:** `#infra/...`, `#modules/...`, `#shared/...`
- **Dentro da mesma pasta:** relativo **com extensão `.js`** — `./user-mapper.js`.
  ESM com `nodenext` exige a extensão; sem ela o `tsc` falha com `TS2835`.

O `tsc` **não reescreve** esses especificadores: `dist/main/http.js` sai com
`import { env } from '#infra/config/env'` literal, e o Node resolve pela condition
`default` para `dist/`. É por isso que `package.json` precisa ir para a imagem de
produção.

> **A pegadinha mais fácil de não perceber.** Sem `--conditions=development`, com
> `dist/` presente, o processo sobe servindo **código compilado velho** enquanto
> você edita `src/` — sem nenhum aviso. O script `dev` já carrega a flag; não a
> remova.

### As três opções do tsconfig que sustentam isso

`rootDir`, `outDir` e `customConditions` **não são preferência**. Sem elas o
projeto não compila, e o modo de falha não é óbvio:

- Sem `customConditions: ["development"]`, o `tsc` resolve `#infra/...` pelo ramo
  `default` — ou seja, procura em `dist/`, que ainda não existe. Resultado:
  **`TS2307` em todo import `#`**.
- Sem `rootDir: "src"`, o `tsc` calcula a raiz comum das entradas. Basta o
  `include` alcançar um arquivo fora de `src/` para a saída virar `dist/src/...`,
  e aí o `imports` do `package.json`, que aponta para `./dist/infra/*.js`, passa a
  apontar para o nada.

Ambos verificados rodando uma config de biblioteca sobre esta árvore: 3 erros de
compilação e a saída no lugar errado.

---

## 4. Regras com dente

Regra que não é verificada por máquina é combinado, e combinado não sobrevive a
N projetos derivados. Estas falham no `pnpm lint`:

| | Regra | Mecanismo | Verificado |
|---|---|---|---|
| **R6** | Só `src/infra/config/env.ts` lê `process.env` | Biome `style/noProcessEnv` + `overrides` | ✅ fixture faz o lint sair com exit 1 |

Só R6 tem dente hoje, porque só R6 tem alvo hoje. As demais entram quando o código
que elas protegem existir — regra configurada sobre o vazio dá falsa sensação de
enforcement, que é pior que não ter.

**Por que R6 importa:** cada módulo vai declarar o schema Zod das suas env vars, e
o boot faz o merge. Se um módulo lesse `process.env` direto, esquecer de registrar
o schema no merge passaria despercebido — a variável simplesmente não seria
validada e chegaria `undefined` em produção. Com o acesso restrito e a config
injetada tipada, esquecer o merge vira erro de compilação.

### Legal / não legal

| ✅ | ❌ |
|---|---|
| `buildServer(env)` — a config chega injetada | `process.env.X` fora de `env.ts` |
| Toda env numérica com `.int().positive()` | `z.coerce.number()` cru — `PORT=` vira **`0`** em silêncio |
| Registrar rotas em `main/http.ts` | Registrar rotas dentro de `server.ts` |
| `import '#infra/http/server'` | `import '../../infra/http/server.js'` |
| Logar campo escolhido | Logar objeto de request ou entidade inteira |
| Dependência em versão exata | `^` ou `~` em qualquer dependência |

---

## 5. Configuração e log

**`env.ts` valida tudo no boot e mata o processo se algo estiver errado**, com a
lista de campos inválidos. Falhar no start é o comportamento desejado: env
inválida não deve virar bug três horas depois.

```
$ PORT= node dist/main/http.js
Variáveis de ambiente inválidas:
✖ Too small: expected number to be >0
  → at PORT
exit=1
```

O logger é o pino que já vem no Fastify. Duas configurações merecem nota:

- **`logController: new LogController({ requestIdLogLabel: 'traceId' })`** — sem
  isso o Fastify loga `reqId` e o resto do sistema fala `traceId`, derrotando o
  grep único. A opção `requestIdLogLabel` de topo existe, mas está **deprecada** e
  sai no Fastify 6.
- **`redact`** cobre senha, token e headers de autenticação. Mas o `redact` do
  pino **não é recursivo** (`*.x` casa exatamente um nível) e o serializer `req`
  padrão do Fastify **não emite headers**. Então a lista é rede de segurança, não
  garantia: a regra que realmente protege é **nunca logar objeto inteiro**.

Em `NODE_ENV=development` o log sai por `pino-pretty`; em produção é JSON puro.

---

## 6. Banco de dados

**PostgreSQL**, acessado via `pg` (driver `node-postgres`) e Drizzle. A conexão
mora em `src/infra/database/client.ts`, infra global — ainda não há módulo
dono de tabela nenhuma.

```ts
// src/infra/database/client.ts
export type Database = NodePgDatabase | NodePgTransaction<EmptyRelations>
```

`DATABASE_URL` é validada em `env.ts` (§5), sem valor default — o boot falha
se faltar, mesma regra das demais variáveis.

Localmente, o Postgres sobe via `docker-compose.yml` (`postgres:18.4-alpine3.24`),
infra apenas — a aplicação roda no host:

```bash
docker compose up -d    # sobe só o Postgres
pnpm dev                # aplicação, no host
```

`drizzle.config.ts` (raiz) já está pronto para gerar e aplicar migrations, mas
seu glob de schema (`src/modules/*/infra/drizzle/schema.ts`) não casa com nada
até o primeiro módulo existir — não há migration real neste repositório ainda.

`GET /health` consulta o banco (`select 1`) a cada chamada: responde `200` com
o banco no ar, `503` com o banco fora. Sem preflight no boot — o processo sobe
mesmo com o banco inatingível, para que `/health` consiga reportar a falha em
vez do processo crash-loopar.

---

## 7. Comandos

```bash
pnpm dev          # tsx + watch, resolve # para src/
pnpm build        # tsc -> dist/
pnpm start        # node dist/main/http.js, resolve # para dist/
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check  (formatação + lint + ordem de imports)
pnpm lint:fix     # biome check --write
pnpm db:generate  # drizzle-kit generate — gera migration a partir do schema dos módulos
pnpm db:migrate   # drizzle-kit migrate — aplica migrations pendentes
```

O servidor sobe com uma única rota, `GET /health` (§6). Qualquer outro caminho
responde **404**, e isso é o esperado.

---

## 8. Versões

**Toda dependência é pinada em versão exata. Nenhum `^`, nenhum `~`** — nem em
`dependencies`, nem em `devDependencies`. Num boilerplate copiado N vezes, caret
significa que dois apps gerados do mesmo commit podem resolver árvores
diferentes, e a divergência aparece como bug que não reproduz.

O pin não é só do estado atual: `savePrefix: ''` faz todo `pnpm add` futuro
gravar exato, sem ninguém precisar lembrar.

Atualizar é ato deliberado — `pnpm outdated` mostra, e a subida é um commit que
passa pela suíte.

### O que garante a versão do Node

| mecanismo | o que faz | é portão? |
|---|---|---|
| `.nvmrc` | fnm/nvm trocam a versão ao entrar na pasta; CI lê com `node-version-file` | não — conveniência |
| `engines` + `engineStrict: true` | `pnpm install` **recusa** em versão fora da faixa | **sim** — exit 1 |
| `packageManager` | Corepack fixa a versão do pnpm | sim, com Corepack ligado |

Sozinho, `engines` só **avisa** e sai com exit 0. É o `engineStrict` no
`pnpm-workspace.yaml` que o transforma em portão.

> **`lib` do tsconfig acompanha o runtime, não o `target`.** `lib: ["es2024"]`
> sozinho esconde do compilador APIs que o Node 24 **tem** — iterator helpers
> (`.map`/`.toArray`), métodos de `Set` (`union`) e `Error.isError`. O sintoma
> engana: o dev bate em `TS2339`, conclui que o Node não suporta e escreve o
> workaround. Por isso o `lib` carrega os blocos `ESNext.*` do
> `@tsconfig/node24`.

> **`@types/node` acompanha o major do Node, não o `latest` do npm.** Hoje o
> `latest` desse pacote é 26.x, que descreve o Node 26 — *current*, não LTS.
> Instalá-lo sobre o Node 24 faz o compilador aceitar APIs que não existem em
> runtime. Rodamos Node 24, logo `@types/node` é 24.x.

---

## 9. Decisões travadas

**TypeScript pinado em `7.0.2` exato, sem caret.** O TS 7 é o port em Go e mudou o
`exports` do pacote: a raiz passou a exportar só a versão, e a API do compilador
foi para `./unstable/*`. Consequência prática — **`typescript-eslint` e
`dependency-cruiser` não funcionam com TS 7**, porque ambos consomem a API antiga.
O `dependency-cruiser` é o pior dos dois: ele emite *aviso*, não erro, e sai com
**exit 0** e `0 modules cruised`, ou seja, CI verde sem enforçar nada.

**Biome no lugar de ESLint + Prettier.** Decorre do parágrafo acima: o Biome é um
binário Rust com **zero dependências JS**, com parser próprio — a versão do
TypeScript é indiferente para ele. Além disso `noProcessEnv` (R6) é regra nativa, e
`noRestrictedImports` casa o especificador **como string**, o que resolve
fronteira sem precisar de resolver de módulo.

**Custo aceito:** o Biome não detecta ciclo de dependência e não gera grafo. Sem
lint type-aware.

**`pnpm-workspace.yaml` não faz deste repo um monorepo.** Sem a chave
`packages:`, isto é um pacote único. O arquivo existe porque o pnpm 11 deixou de
ler o campo `pnpm` do `package.json`, e é onde moram `allowBuilds`,
`engineStrict` e `savePrefix`.

**Sem Turborepo.** Ele orquestra tarefas entre pacotes e cacheia saída de tarefa;
aqui há um pacote só, e o pipeline inteiro custa ~1,1 s — o overhead do próprio
turbo fica na mesma ordem. Passaria a valer se isto virasse monorepo de verdade, e
aí o primeiro passo seria pnpm workspaces, não ele. Módulos aqui são
**diretórios**, não pacotes; `worker` e `cron`, quando existirem, são entrypoints
do mesmo pacote.

---

## 10. O que ainda não existe

Listado para não ser confundido com omissão, sem detalhar o que não foi construído:

módulos e camada pura · regra de fronteira no lint · error handler e taxonomia de
erro · `traceId` por `AsyncLocalStorage` · testes · migrations · rotas,
validação de schema e OpenAPI · Docker · CI
