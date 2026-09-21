# Fatia 28 — A regra de fronteira ganha dente

**Data:** 2026-09-20
**Alvo:** `ARCHITECTURE.md` §2 (tabela de fronteira) e §4 (regras com dente)

## 1. O problema

O §4 classifica a fronteira como **dívida**, não como desenho pendente: o código
que ela protege existe desde a fatia do `POST /auth/register`, o critério para
automatizar foi satisfeito e nada foi configurado. Hoje a única coisa que separa
um use case de um `import` de infraestrutura é um revisor humano atento.

O §4 também carrega o argumento mais concreto contra esse estado: a regra "não
logar objeto inteiro" existia por escrito **antes** do vazamento de hash que a
revisão encontrou. A regra estava certa; nada a verificava.

## 2. Objetivo

Transformar as cinco linhas da tabela do §2 em portão de máquina: `pnpm lint`
sai com exit 1 quando um import cruza a fronteira, com fixtures que provam que o
portão pega o que deve pegar e libera o que deve liberar.

**Dentro do escopo, por consequência:** duas emendas no `audit-scan.mjs`, que a
§9 detalha. Sem elas os dois verificadores se contradizem no primeiro
cruzamento de módulo.

**Fora de escopo:** R7 (valor não determinístico na camada pura), R1
(`db.query.*`), ciclos e módulos órfãos. Nenhum deles está na tabela do §2, e
enfiá-los aqui ampliaria a regra por baixo do pano.

## 3. Spike: `dependency-cruiser` e TypeScript 7

A armadilha nº 3 do §4 **está armada hoje**, e foi reproduzida na árvore real:

| cenário | módulos | dependências | exit |
|---|---|---|---|
| depcruise 18.4.0 + TS 7.0.2 | **0** | **0** | **0** (verde, zero enforcement) |
| depcruise 18.4.0 + TS 6.0.3 | 257 | 1003 | 1 |
| idem, sem `tsPreCompilationDeps` | 256 | 668 | 1 |

A versão 18.4.0 (a mais recente) ainda declara `typescript: ">=2.0.0 <7.0.0"` em
`src/meta.cjs`, e a mensagem do próprio binário diz: *"Support for
typescript@>=7 will follow when its API is published and stable."* Com TS 7 ele
emite um aviso em stderr e sai com **exit 0**.

A armadilha nº 1, remedida nesta árvore: **335 arestas type-only** somem sem
`tsPreCompilationDeps` — 33% do grafo. O §4 registra ~42%, medido em árvore
anterior; o número é atualizado junto com esta fatia.

### A saída: TypeScript 6 aninhado sob o depcruise

O gate do depcruise resolve `typescript` com `createRequire` a partir do
diretório **dele**, não da raiz do projeto. O `packageExtensions` do pnpm
explora exatamente isso:

```yaml
# pnpm-workspace.yaml
packageExtensions:
  dependency-cruiser:
    dependencies:
      typescript: 6.0.3
```

Verificado: a raiz segue em `7.0.2`, o depcruise enxerga `6.0.3`, e o cruzeiro
funciona. O projeto **não** é rebaixado — `build`, `typecheck` e editor
continuam em TS 7.

Dois detalhes que custaram uma iteração cada:

- `pnpm.packageExtensions` dentro do `package.json` é **ignorado em silêncio**
  pelo pnpm 11; a configuração mora em `pnpm-workspace.yaml`.
- `pnpm install --ignore-workspace` descarta essas settings junto. O aninhamento
  simplesmente não acontece, sem erro.

O dia em que o depcruise suportar TS 7, o bloco sai e nada mais muda.

## 4. Componentes

Nenhum deles dentro de `src/` — é ferramenta de lint, não código da aplicação.

### `tools/boundaries/layers.mjs`

A tabela do §2 expressa **uma vez**, como padrões nomeados exportados: `PURE`,
`MODULE_INFRA`, `GLOBAL_INFRA`, `COMPOSITION`, `TEST`.

```js
export const PURE =
  '^src/(shared/|modules/[^/]+/(entities|value-objects|repositories|ports|use-cases|services|dtos|errors|notifications)/|modules/[^/]+/config\\.ts$)'
export const MODULE_INFRA = '^src/modules/[^/]+/infra/'
export const GLOBAL_INFRA = '^src/infra/'
export const COMPOSITION = '^(src/main/|src/modules/[^/]+/container\\.ts$)'
export const TEST = '(\\.spec\\.ts$|^tests/|/fixtures/|/in-memory/)'
```

`COMPOSITION` não é referenciado por regra nenhuma do depcruise — composition é
exatamente a ausência de restrição. Ele existe porque o `audit-scan.mjs` precisa
classificar o elemento, e porque a tabela do §2 fica incompleta sem ele.

É a resposta ao custo aceito na convivência entre os dois verificadores: o
`.dependency-cruiser.mjs` e o `audit-scan.mjs` viram dois **consumidores** de um
classificador, não duas implementações da mesma tabela.

### `.dependency-cruiser.mjs` (raiz)

Config em ESM — verificado que o depcruise aceita, e combina com o
`"type": "module"` do projeto. Importa `layers.mjs` e carrega as três
configurações que desarmam as armadilhas do §4:

```js
options: {
  tsPreCompilationDeps: true,
  tsConfig: { fileName: 'tsconfig.json' },
  enhancedResolveOptions: {
    exportsFields: ['exports'],
    conditionNames: ['development', 'import', 'require', 'node', 'default', 'types'],
    mainFields: ['module', 'main', 'types', 'typings'],
    extensions: ['.ts', '.js', '.mts', '.cts'],
  },
  doNotFollow: { path: 'node_modules' },
}
```

### `tools/boundaries/check.mjs`

O portão, em três atos:

1. **Pré-voo.** Lê `supportedTranspilers.typescript` do depcruise e a versão de
   `typescript` que ele de fato resolve. Divergiu, morre dizendo qual é — em vez
   de deixar o cruzeiro sair com exit 0 e zero módulos.
2. **Cruzeiro.** Roda com `--output-type json` e reporta as violações.
3. **Guarda de cobertura.** Conta módulos com `source` em `src/` e compara com
   os `.ts` em disco. Hoje **229 = 229**. Diferente, falha nomeando os que
   sumiram.
4. **Classificação total.** Passa cada módulo de `src/` pelos padrões do
   `layers.mjs` e falha se algum não cair em elemento nenhum. É o equivalente ao
   `LAYER-UNKNOWN` do scanner — o check que pegou a pasta `services/` antes de
   ela entrar na tabela do §2.

O ato 4 mora aqui, e não como regra do depcruise, por medição: uma regra
`from: ^src/ pathNot: <todos os elementos>` funciona para arquivo com import,
mas **um arquivo sem import nenhum escapa** — ele existe no grafo e nunca aparece
do lado `from` de uma dependência. A lista de módulos não tem esse buraco.

A guarda de cobertura é estritamente mais forte que o `modules cruised === 0`
proposto pelo §4: pega os três modos de falha silenciosa **e** a perda parcial —
um arquivo futuro com sintaxe só-TS-7 que o TS 6 não parseie sumiria do grafo
sem zerar a contagem.

## 5. As regras

Sete regras, todas lendo `layers.mjs`. Toda regra de produção carrega
`pathNot: TEST` no lado `from`: é assim que a precedência do `test` sobre as
outras linhas vira ordem de avaliação, e é a regressão que o positivo do
`.spec.ts` guarda.

| # | nome | `from` | proibido alcançar |
|---|---|---|---|
| 1 | `pure-imports-only-pure` | `PURE` | qualquer coisa fora de `PURE` — dublês, container e infra inclusive |
| 2 | `pure-external-only-zod` | `PURE` | pacote npm que não seja `zod` |
| 3 | `module-does-not-reach-module` | `^src/modules/([^/]+)/` | `^src/modules/` que não seja `$1` |
| 4 | `shared-does-not-know-modules` | `^src/shared/` | `^src/modules/` |
| 5 | `global-infra-imports-pure-or-global-infra` | `GLOBAL_INFRA` | `module-infra`, `composition`, dublês |
| 6 | `own-container-type-only` | `^src/modules/([^/]+)/infra/` | `container.ts` do `$1` sem `type-only` |
| 7 | `no-unresolvable-imports` | qualquer um | import que não resolve |

### A regra 6 é a que revisão humana não sustenta

Hoje as 16 arestas de endpoint para o container são `type-only` — verificado no
grafo. A primeira que virar import de valor cria dependência em runtime e ciclo
em potencial, e some da revisão porque a linha continua parecendo idêntica.

### A regra 3 fecha o cruzamento entre módulos nos dois lados

A letra atual do §2 permite que o `infra/` de um módulo importe a camada pura de
outro: `pure`, como elemento, cobre qualquer módulo. A regra 3 fecha isso — nem
`infra/`, nem camada pura, em nenhuma direção.

**A analogia que decidiu:** em microsserviços o billing *chama* o auth, mas não
*importa* o auth — ele segura um cliente de um contrato que ele mesmo define, e
a rede obriga a porta. A regra 3 reproduz isso dentro do processo. Ela não
proíbe a chamada; proíbe o import.

O cruzamento passa a ter uma forma só: o consumidor declara a porta na sua
camada pura, e o adaptador mora em **`src/main/`**, que é o único lugar onde
módulo conhece módulo.

Este código já está pronto para isso: o `GetUserProfileUseCase` retorna
`UserProfileResult` plano por desenho — *"the `Email` value object is unwrapped
here, so no consumer has to know the entity's internal types"*. Contrato entre
módulos se escreve em `string` e `Date`, sem vocabulário compartilhado.

O custo aceito: todo cruzamento futuro paga uma interface e um adaptador,
inclusive os triviais. Medido hoje: **zero violações, nenhuma refatoração**.

### O que foi cortado, e por quê

Uma regra `container-only-from-main-and-own-infra` foi escrita e **removida após
medição**: ela nunca dispara sozinha. Global-infra alcançando container já cai
na 5, camada pura na 1, outro módulo nas 1 e 3. Removê-la não deixa nenhum
arquivo infrator escapar. Regra que fixture nenhuma consegue isolar é regra
morta, que é o que o §4 condena.

### O padrão de externo no store do pnpm

O caminho resolvido de um pacote é
`node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.d.cts`. Padrão ancorado em
`^node_modules/` **não casa**, e ancorar na versão quebraria no primeiro
upgrade. A allowlist usa `(^|/)node_modules/zod/`.

## 6. Fixtures e testes

As fixtures entram na suíte, não num script à parte — a lição do
`audit-scan.mjs` é que ferramenta que ninguém invoca não é portão.

`tools/boundaries/boundaries.spec.mjs` materializa a árvore
`.ts.txt` num tmpdir com `package.json` (mapa `imports`), `tsconfig.json` e um
symlink para o `node_modules` do repo, roda o depcruise com a **config real** e
afirma, por fixture, **qual regra** disparou.

O armazenamento em `.ts.txt` é o padrão que a skill `architecture-audit` já usa:
nem o `tsc` nem o Biome parseiam código que viola de propósito.

**O `UNIT_INCLUDE` do `vitest.config.ts` ganha `tools/**/*.spec.mjs`.** Hoje ele
é só `src/**/*.spec.ts`, e o CI roda `pnpm test:unit`/`pnpm test:integration`,
nunca `pnpm test` — um projeto novo, ou um teste fora desse glob, não seria
executado por ninguém. Seria a mesma armadilha do scanner que existe e ninguém
chama.

O depcruise roda **uma vez** no `beforeAll` e os dez casos são afirmados sobre o
mesmo JSON: 0,52s no total, em vez de dez invocações.

**Afirmar o nome da regra, não o exit code.** Verificado na prática: com o
`node_modules` ausente, o negativo de "pure importa `pg`" acusava as regras 1 e
7 em vez da 2 — passaria num teste que só olhasse exit 1. O symlink para o
`node_modules` real é o que torna o negativo honesto.

### Os oito negativos (têm que falhar)

| fixture | regra esperada |
|---|---|
| use case → `#infra/observability/logger` | 1 |
| use case → `pg` | 2 |
| `auth/infra/` → `billing/infra/` | 3 |
| `billing/use-cases/` → `auth/use-cases/` | 3 |
| `shared/` → `#modules/auth/...` | 4 |
| `src/infra/` → in-memory de módulo | 5 |
| `auth/infra/http/` → `auth/container` como valor | 6 |
| `main/` → `#modules/ghost/...` (não existe) | 7 |

O negativo da regra 7 mora em `src/main/` de propósito: em qualquer outro
elemento ele acusaria duas regras, porque um import não resolvido também falha a
regra do elemento de origem. Composition é o único lugar onde ele fica isolado.

### Os dois positivos (têm que passar)

| fixture | por que existe |
|---|---|
| `.spec.ts` colocado → in-memory | regressão da ordem de avaliação: tire a exclusão de `TEST` do `from` e ele passa a ser acusado |
| `main/adapters/` → os dois módulos | sem ele, o adaptador de cruzamento que a regra 3 exige seria ilegal |

Os dez casos já foram executados em protótipo: os oito acusam exatamente uma
regra cada, os dois passam limpos.

### Quem protege a guarda

O pré-voo e a cobertura são funções puras — recebem versão resolvida + range, e
lista de módulos + lista de arquivos. Testadas direto: `('7.0.2', '>=2.0.0
<7.0.0')` falha, `('6.0.3', ...)` passa, e a cobertura acusa quando falta
módulo. Sem isso, o mecanismo que protege as três armadilhas seria a única coisa
sem rede.

## 7. Integração

- `pnpm-workspace.yaml`: o `packageExtensions` da §3.
- `package.json`: `dependency-cruiser` pinado exato em devDependencies; `lint`
  passa a ser Biome **e** fronteira. Custo medido: 0,52s contra 0,16s do Biome.
- `vitest.config.ts`: `UNIT_INCLUDE` vira um array com `src/**/*.spec.ts` e
  `tools/**/*.spec.mjs`. As ferramentas ficam em `.mjs` porque `tools/` está
  fora do `include` do `tsconfig.json`.
- `ci.yml`: nada a mudar — o job já roda `pnpm lint` e `pnpm test:unit`, e as
  duas mudanças acima entram por eles.

## 8. Documentação

Escrita **depois** do código, como destilação — o formato que a decisão 45
aprova.

- **§2**: a frase que fecha o cruzamento entre módulos e nomeia `src/main/` como
  casa do adaptador.
- **§4**: linha Fronteira de ⚠️ para ✅; as "três armadilhas" viram a
  configuração que as desarma; ~42% corrigido para os 33% medidos; parágrafo
  declarando os papéis — depcruise é o **portão**, `audit-scan.mjs` é a **rede
  de revisão**, ambos consumindo `layers.mjs`.
- **§11**: o TS 6.0.3 aninhado, com o motivo e a condição de saída.
- **`DECISIONS.md`**: decisão 46.

## 9. Fidelidade ao `audit-scan.mjs`

Os dois verificadores convivem com papéis declarados, o que só funciona se eles
não se contradisserem. Comparados check a check, sobraram três divergências —
todas latentes hoje (o scanner passa limpo em 285 arquivos), todas a resolver
nesta fatia.

**1. O scanner não implementa a linha `test` do §2.** O `classify()` dele só
reconhece `.spec.ts` e `tests/`; `fixtures/` e `in-memory/` ficam de fora. Na
prática `src/modules/auth/infra/in-memory/` é classificado como `module-infra` e
`src/infra/config/fixtures/test-env.ts` como `global-infra` — exatamente o que o
§2 manda não fazer, por escrito: *"Classificá-los como produção faria o lint de
fronteira aprovar exatamente o import que deveria barrar."* Adotar o
`layers.mjs` como fonte única corrige o scanner de graça, mas **muda o
comportamento dele**, então os testes da skill rodam junto.

**2. A decisão da regra 3 muda a severidade do `XMOD-PURE`.** O scanner já
acusa `auth/infra/` → `billing/use-cases/`, mas em **MÉDIA**, com a mensagem
*"Acoplamento entre domínios — confirme se é intencional."* Sob a regra 3 não há
o que confirmar: é violação. O check sobe para CRÍTICA e a mensagem passa a
apontar a forma legal — porta do consumidor, adaptador em `src/main/`.

O `CONTAINER-VALUE` do scanner, por outro lado, já concorda com a regra 6 sem
emenda: ele exige `import type` no container do próprio módulo.

**3. `LAYER-UNKNOWN` não tinha equivalente.** Resolvido pelo ato 4 do
`check.mjs`.

**O que *parece* divergência e não é:** o `GLOBAL-INFRA-XMOD` acusa
`src/infra/` → camada pura de um módulo como MÉDIA, enquanto o portão libera. É
deliberado, e o próprio texto do scanner diz por quê: *"a tabela permite pure,
mas infra sem dono acoplada a um módulo pede justificativa."* Portão barra o que
a tabela proíbe; rede de revisão questiona o que a tabela permite mas merece
olhar. A exceção de `#modules/*/config` (decisão 14, o merge dos schemas de env
no boot) está contemplada: a regra 5 classifica `config.ts` como `PURE`.

## 10. Riscos e custos aceitos

1. **Um segundo TypeScript no lockfile.** Pinado exato, escopo de lint,
   removível quando o depcruise suportar TS 7.
2. **TS 6 parseia código escrito para TS 7.** Hoje sem incidente — 229 de 229
   arquivos cruzados. A guarda de cobertura é o que transforma uma futura
   divergência de sintaxe em falha ruidosa em vez de silêncio.
3. **Duas implementações da fronteira convivem.** A classificação vira fonte
   única no `layers.mjs`, mas os *checks* seguem separados — o risco residual é
   uma linha nova do §2 virar regra no portão e não virar check no scanner. A §9
   mostra que isso já aconteceu uma vez, em três lugares.
4. **Cerimônia no cruzamento entre módulos.** Porta + adaptador, inclusive nos
   casos triviais. Aceito em favor de módulos extraíveis.

## 11. Critério de pronto

- `pnpm lint` sai 1 com uma violação plantada e 0 na árvore limpa.
- Os oito negativos acusam a regra certa; os dois positivos passam.
- O pré-voo falha com TS 7 e passa com TS 6, com teste próprio.
- A guarda de cobertura falha quando falta módulo, com teste próprio.
- `pnpm test` e `pnpm typecheck` verdes.
- A classificação total falha com um arquivo de produção não classificado, com
  teste próprio.
- `node .claude/skills/architecture-audit/tests/run-tests.mjs` verde depois das
  duas emendas no scanner.
- §2, §4, §11 e a decisão 46 atualizados.
