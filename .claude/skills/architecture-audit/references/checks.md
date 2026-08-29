# Catálogo de checks

O que cada check de `scripts/audit-scan.mjs` prova, e como corrigir o achado.
Referência — leia sob demanda, quando um id aparecer no relatório.

## Como um arquivo é classificado

O scanner deriva a camada do caminho, exatamente como a tabela de fronteira do
`ARCHITECTURE.md` §2. A ordem importa: `infra/` vence antes das pastas puras.

| Camada | Padrão | Pode importar |
|---|---|---|
| `pure` | `src/modules/*/{entities,value-objects,repositories,ports,use-cases,dtos,errors}/**` · `src/modules/*/config.ts` · `src/shared/**` | só `pure` |
| `module-infra` | `src/modules/*/infra/**` | `pure` · `global-infra` · o `module-infra` do próprio módulo |
| `global-infra` | `src/infra/**` | `pure` · `global-infra` |
| `composition` | `src/modules/*/container.ts` · `src/main/**` | tudo |
| `test` | `**/*.spec.ts` · `tests/**` | tudo |
| `unknown` | qualquer outro `src/**` | — dispara `LAYER-UNKNOWN` |

> **`ports/` é o contrato; `infra/providers/` é a implementação.** Os dois se
> chamavam `providers/` e eram indistinguíveis na árvore sem abrir as duas
> pastas — `repositories/` nunca teve o problema porque o adapter dele mora em
> `infra/drizzle/`, nomeado pela tecnologia. Só o lado do contrato foi
> renomeado: `infra/providers/` segue como está.

`composition` e `test` são exceções deliberadas: o composition root existe para
conhecer o concreto, e o teste unitário precisa alcançar o repositório
in-memory. `test` é isento de **import**, nunca de segredo.

---

## Fronteira

### `PURE-IO` — CRÍTICA
Camada pura importando pacote de IO (`fastify`, `drizzle-orm`, `pg`, `pino`,
`jose`, `@node-rs/*`, `node:*`, HTTP clients…) ou `#infra/*` / `#main/*`.

**Corrigir:** declare o contrato em `ports/` ou `repositories/` do módulo (ou
`#shared/ports/` se for transversal) e implemente o adapter em `infra/`. O
container injeta. É o que torna o use case testável em milissegundos, sem banco.

Vale também para `import type`: um tipo importado do infra ainda é a camada pura
conhecendo o mundo externo, e o próximo `import` do mesmo arquivo deixa de doer.

### `PURE-XMOD` — CRÍTICA (se alcança `infra/` do outro módulo) · MÉDIA (resto)
Camada pura de um módulo importando outro módulo. Entre módulos referencia-se por
id, sem constraint e sem import; a integridade fica na aplicação (§6).

### `SHARED-XMOD` — CRÍTICA
`src/shared/**` importando `#modules/*`. `shared/` é transversal por definição:
se ele conhece um módulo, deixou de ser compartilhável e virou dependência
circular esperando acontecer.

### `XMOD-INFRA` — CRÍTICA
`infra/` de um módulo importando o `infra/` de outro. É o cruzamento que a linha
`module-infra` da tabela existe para impedir.

**Corrigir:** o que é comum sobe para `src/infra/**` (infra sem dono); o que é do
domínio do outro módulo atravessa por contrato injetado no composition root.

### `GLOBAL-INFRA-XMOD` — CRÍTICA (`infra/` ou container do módulo) · MÉDIA (resto)
`src/infra/**` conhecendo um módulo. O modelo é `infra/http/auth-guard.ts`: ele
protege rotas sem importar `#modules/auth` — o verificador chega injetado.

**Exceção que não dispara:** `#modules/<m>/config` em `env.ts`. A tabela
classifica o `config.ts` do módulo como `pure`, e o merge dos schemas no boot é a
decisão 14.

### `XMOD-PURE` — MÉDIA
`infra/` de um módulo importando a camada **pura** de outro. A tabela permite —
`module-infra` pode importar `pure` —, então isto é sinal, não veredito: confirme
se o acoplamento entre domínios é intencional ou se o que se quer ali é um
contrato próprio. Um dia esse import vira o caminho por onde a linha de outra
tabela atravessa a fronteira.

### `PURE-CONTAINER` / `XMOD-CONTAINER` / `CONTAINER-VALUE` — ALTA
Quem pode importar um container: `src/main/**` como **valor**, e o `infra/` do
**próprio** módulo apenas como **tipo** (`import type`). Mais ninguém.

`CONTAINER-VALUE` é o caso sutil: `import { }` no lugar de `import type { }` no
próprio módulo cria dependência em runtime e abre caminho para ciclo. Sendo
`import type`, some na compilação.

### `INFRA-MAIN` — CRÍTICA
Infra importando `#main/*`. O composition root depende das camadas, nunca o
contrário.

### `LAYER-UNKNOWN` — MÉDIA
Arquivo em `src/` que não cai em nenhuma linha da tabela — por exemplo
`src/modules/auth/helpers.ts`. Ou ele pertence a uma das pastas nomeadas, ou a
tabela precisa ganhar uma linha, o que é decisão consciente e documentada. Um
arquivo fora do mapa é um arquivo cuja fronteira ninguém verifica.

---

## Configuração e determinismo

### `ENV` — CRÍTICA (R6)
`process.env` fora de `src/infra/config/env.ts`.

**Corrigir:** o módulo declara o schema Zod das suas variáveis em `config.ts`;
`env.ts` faz o merge e o boot morre listando tudo que está inválido. A config
chega injetada e tipada — e esquecer o merge vira erro de compilação, em vez de
`undefined` em produção.

Único check com dente no lint hoje (Biome `style/noProcessEnv`). O scanner o
mantém porque a auditoria também roda em escopos onde o lint não rodou.

### `TEST-ENV` — ALTA
Teste lendo `process.env`. A env da suíte é injetada em `test.env` no
`vitest.config.ts` — é o que permite R6 valer sem exceção nenhuma no
`biome.jsonc`.

### `R7-CLOCK` / `R7-RANDOM` — ALTA
`new Date()`, `Date.now()`, `Math.random()`, `randomUUID()`, `randomBytes()`,
`performance.now()`, `process.hrtime` na camada pura.

**Corrigir:** `IClock` (`#shared/ports/clock`) para tempo, `IIdGenerator`
(`#shared/ports/id-generator`) para identidade. São duas portas de propósito:
id de entidade e segredo criptográfico têm perfis de segurança diferentes.

`new Date(valor)` **com argumento** não dispara — é cópia defensiva, é
determinístico, e o repositório usa esse padrão.

---

## Vazamento de dados

### `DRIVER-RETHROW` — CRÍTICA
`catch (error) { … throw error }` em `infra/drizzle/**`.

A `message` do `DrizzleQueryError` é `Failed query: ${query}\nparams: ${params}`
— o texto **mais todo parâmetro vinculado**. Num INSERT em `users`, um deles é o
hash de senha. A `stack` deriva da `message` e `params` é propriedade própria
enumerável: três carregadores do mesmo segredo no mesmo objeto.

```diff
- throw error
+ throw toPersistenceError(error)
```

### `CATCH-UNSANITIZED` — ALTA
`catch` na camada Drizzle que nunca chama `toPersistenceError`. Ou o erro escapa
por outro caminho, ou a falha está sendo engolida em silêncio. Traduza a violação
esperada para erro de domínio e converta o resto.

### `DRIVER-LOG` — CRÍTICA
Qualquer `log.*`/`console.*` dentro de `infra/drizzle/**`. É onde o objeto
perigoso ainda existe; logar ali é exatamente o vazamento. O `error-handler`
central já registra a falha com `traceId`.

### `DRIVER-RAW` — CRÍTICA
Leitura/propagação de `error.message`, `.stack`, `.params`, `.detail` na camada
Drizzle. O `detail` do Postgres embute o valor conflitante:
`Key (email)=(joao@example.com) already exists.` O que sobrevive é **lista de
permissão** (`code`, `constraint`, `query` com marcadores), não de proibição.

### `LOG-OBJECT` — ALTA
`log.*({ request })`, `{ body }`, `{ user }`, `{ headers }`… O `redact` do pino
**não é recursivo** (`*.x` casa exatamente um nível) e o serializer `req` padrão
do Fastify não emite headers: a lista de redact é rede de segurança, não
garantia. Logue o campo escolhido.

### `LOG-ERR-MODULE` — ALTA
Erro logado dentro de `src/modules/*/infra/**`. O `error-handler` central já loga
com `traceId`; o log local duplica a linha e, quando o objeto é o do driver,
escapa da sanitização. `infra/http/**/error-handler.ts` é o único isento — é o
lugar projetado para isso, com o `error-serializer` registrado atrás.

### `SECRET-HTTP` — CRÍTICA
`passwordHash`, `JWT_SECRET`, `SECRET_KEY`, `PRIVATE_KEY` mencionados na camada
HTTP. Confirme se entra em schema de resposta ou em `send()`; o read model do use
case já entrega a forma publicável (`comando devolve recibo, consulta devolve
read model`).

### `OWNERSHIP-UNUSED` — ALTA
Use case cujo `execute` recebe `userId`/`ownerId`/`tenantId`/`accountId` e nunca
o usa — o identificador aparece uma única vez no arquivo, a própria declaração.
A consulta é por id global: quem obtiver o id de um recurso alheio o alcança.
É o padrão de IDOR, e a assinatura mente ao sugerir que a posse é conferida.

**Corrigir:** leve o dono até a consulta e responda 404, não 403 — confirmar que
o recurso existe mas é de outro já é vazamento de existência.

```diff
- const notification = await this.repository.findById(id)
- if (notification === null) throw new NotificationNotFoundError()
+ const notification = await this.repository.findByIdAndOwner(id, userId)
+ if (notification === null) throw new NotificationNotFoundError()
```

O check só vê o parâmetro **nunca** usado. Usado e ausente do `where` é o passo
3 da skill que pega.

### `CONSOLE` — MÉDIA
`console.*` em código de módulo: sem `traceId`, sem redact, sem nível. Isentos
`env.ts` e `database/client.ts` — rodam antes de o logger existir.

---

## HTTP e convenções

### `ZOD-DATE` — MÉDIA
`z.iso.datetime()` em endpoint. Em schema de **resposta** use `z.date()`: o
`serializerCompiler` aceita o `Date` e emite ISO sozinho, e o OpenAPI publica o
mesmo `format: date-time`. Com `z.iso.datetime()` todo handler precisa chamar
`.toISOString()`, e para isso conhecer os tipos internos do domínio.

Em schema de **request** o `pattern` extra tem consumidor e a forma é legítima —
por isso MÉDIA, e não automática: leia em qual metade do schema ela está.

### `HANDLER-CATCH` — MÉDIA
`try/catch` em `infra/http/endpoints/**`. O use case só faz `throw`; o
`error-handler` traduz para status pelas seis categorias. Capturar no endpoint é
onde o envelope de erro começa a divergir de rota para rota.

### `HTTP-MAGIC` — MÉDIA
Status inline: `.status(201)`, `.code(404)`, `{ 200: schema }`. Use as constantes
de `infra/http/constants.ts` do módulo (`CLAUDE.md`, sem magic number).

### `IMPORT-PARENT` — ALTA
`from '../…'` em `src/`. Entre galhos usa-se subpath import: um caminho `#`
continua correto depois de mover o arquivo, um `../../..` não. Isento em `tests/`.

### `IMPORT-EXT` — ALTA
Import relativo sem `.js`. ESM com `nodenext` exige a extensão — o `tsc` falha com
`TS2835`. Dentro do próprio galho: `./user-mapper.js`, `./schema/users.js`.

### `IMPORT-DEEP` — ALTA
Especificador apontando para `src/` ou `dist/`. O `tsc` **não reescreve**
especificadores: quem decide a árvore é a condition (`development` → `src/`,
`default` → `dist/`).

### `DRIZZLE-QUERY-API` — MÉDIA (R1)
`db.query.*` no repositório. A regra é usar só a API core
(`select`/`insert`/`update`/`delete`).

### `DEP-RANGE` — ALTA
`^` ou `~` em `package.json`. Num boilerplate copiado N vezes, caret significa
que dois apps gerados do mesmo commit resolvem árvores diferentes — e a
divergência aparece como bug que não reproduz. `savePrefix: ''` já cuida do
futuro; este check pega o que entrou à mão.

### `MD-LINK` — MÉDIA
Link relativo quebrado em `.md` versionado. Entra no escopo com `--all` (todo
`.md` rastreado pelo git) e, nos escopos de diff, quando o próprio arquivo mudou.

É a única forma de "documento que mente" que uma máquina prova. Um move de pasta
não toca o texto do link: ele continua verde no diff e morto na leitura. Âncora
pura (`#secao`), URL e caminho absoluto ficam fora — o último depende de uma raiz
que o script não conhece. Link dentro de bloco cercado não conta.

### `TEST-ONLY` — MÉDIA
`.only` commitado silencia o resto da suíte.

---

## Limitações conhecidas

O scanner não substitui o passo 3 da skill. O que ele **não** vê:

- **Intenção.** `SECRET-HTTP` acusa a menção, não prova que o campo vai na
  resposta. Leia o schema.
- **Dependência não declarada.** Import de pacote ausente do `package.json`, e
  tabela declarada sem migration commitada: nenhum dos dois é padrão textual no
  arquivo auditado.
- **Fluxo entre arquivos.** Um valor sensível que chega ao log por três saltos
  passa: cada linha, isolada, é inocente.
- **Status não declarado.** Ausência não casa com regex — nenhum check prova que
  um endpoint esqueceu de declarar o 409 que ele produz.
- **Comentário que mente.** O scanner remove comentários exatamente para não
  disparar em prosa; a contrapartida é que também não os lê.
- **Import multi-linha acima de 12 linhas** e reexport exótico saem da extração.
- **Fixture com violação proposital** dispara como violação real — é o motivo de
  os fixtures do teste morarem em `.ts.txt`, fora do alcance do tsc e do Biome.
