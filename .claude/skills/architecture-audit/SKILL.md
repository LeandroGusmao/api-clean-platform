---
name: architecture-audit
description: Use ao auditar, revisar ou validar código deste repositório contra a arquitetura — antes de commit, PR ou merge, ao revisar um diff/branch/fatia recém-implementada, ou quando pedirem "auditoria", "audit", "revisar arquitetura", "checar fronteiras", "camada pura", "vazamento de dado/segredo em log", "isolamento entre módulos", R6, R7.
---

# Auditoria de Arquitetura e Segurança

Auditoria deste repositório contra as regras de `ARCHITECTURE.md` e `CLAUDE.md`.
Duas passadas: o scanner prova o que regex prova; você lê o que só leitura pega.

**Princípio que ordena tudo:** código puro nunca depende de código que toca o
mundo externo, e nenhum segredo atravessa uma fronteira. Vazamento e quebra da
camada pura são **CRÍTICA** — não existe "só desta vez".

## Procedimento

### 1. Defina o escopo e diga qual é

| Situação | Comando |
|---|---|
| Trabalho não commitado (padrão) | `node .claude/skills/architecture-audit/scripts/audit-scan.mjs` |
| Branch contra a base | `… /audit-scan.mjs --base main` |
| Árvore inteira | `… /audit-scan.mjs --all` |
| Arquivos/pastas específicos | `… /audit-scan.mjs src/modules/auth package.json` |

`--json` para consumir a saída; `--strict` para portão de CI (exit 2 em CRÍTICA).
O relatório sempre nomeia o escopo auditado — auditoria sem escopo declarado não
é verificável.

### 2. Rode o scanner

Cada achado vem com severidade, id do check, `arquivo:linha`, a regra e o
trecho. Catálogo completo, com o que cada check prova e como corrigir:
[references/checks.md](references/checks.md).

**O scanner é piso, não teto.** Ele não abre um arquivo para entender intenção.

### 2b. Rode os portões que o repositório já tem

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"
pnpm lint && pnpm typecheck && pnpm test:unit
```

**Nunca canalize um portão.** `pnpm lint | tail -1` devolve o status do `tail`,
que é sempre 0: o `&&` segue por cima de um check vermelho e a auditoria aprova
o que falhou. Mesma família: `pnpm test:unit -- <filtro>` engole o filtro e roda
a suíte inteira, então "passou" não quer dizer que o seu caso passou. Rode cada
portão sozinho e leia o exit code — ou `set -o pipefail`, se precisar do pipe.

Sem o `PATH`, o `pnpm` recusa com `ERR_PNPM_UNSUPPORTED_ENGINE` — o `node` do
shell é mais velho que o `engines` do projeto, e isso não é achado da auditoria.

Portão vermelho é achado: **ALTA** se é lint ou typecheck, **CRÍTICA** se é teste
quebrado. Aprovar uma fatia com a suíte vermelha é aprovar o que ninguém
verificou — e o `pnpm lint` é onde R6 tem dente de verdade.

### 3. Leia o que o scanner não prova

Obrigatório para todo arquivo no escopo. Nenhum destes é detectável por padrão
textual:

- **Endpoint declara todo status que ele mesmo produz** (§7). Tem `body` schema
  mas não declara 400? Chama um use case que lança `ConflictError` mas não
  declara 409? Tem `guard` mas não declara 401? O cliente descobre por tentativa.
- **Schema de resposta não publica campo sensível.** Compare campo a campo com o
  read model do use case. `passwordHash` fora, e todo campo novo justificado.
- **Rota que chama `getPrincipal` tem `preHandler: guard`.** Sem o guard a rota
  responde **500**, não 401 — falha de fiação disfarçada de tráfego normal.
- **Erro novo estende uma das seis categorias** e declara `code` literal, nunca
  derivado do nome da classe (§8).
- **Use case recebe `IClock`/`IIdGenerator`** (`#shared/ports/`) em vez de gerar o valor — inclusive
  quando o valor nasce dentro de uma entidade.
- **Repositório insere e trata a violação**, nunca consulta-e-insere (corrida), e
  casa a constraint pelo **nome**, não só pelo código `23505` (§6).
- **Filtro por dono chega até a consulta.** O scanner acusa o parâmetro de posse
  recebido e nunca usado; ele **não** vê o caso em que o parâmetro é usado mas
  não entra no `where`. Leia a query: sem o dono nela, quem descobrir o id do
  recurso alheio lê o recurso alheio.
- **Campo que parece credencial** (`*Token`, `*Secret`, `*Key`) publicado numa
  resposta: ou carrega entropia — e aí não pode sair —, ou é derivável do que a
  própria resposta já expõe, e aí não autoriza nada e mente sobre proteger.
- **Todo pacote importado está em `package.json`**, na versão exata. Import de
  dependência não declarada não é detalhe de build: a fatia nunca rodou.
- **Tabela declarada em `schema/` tem migration commitada** em `drizzle/`.
  Schema sem migration é uma fatia que quebra no primeiro `select`.
- **O mapper persiste o valor real.** Entidade que não expõe o campo obriga o
  mapper a inventar um literal — e o dado gravado deixa de ser o dado recebido.
- **Migration nova em pasta nova**, com `--name`; migration aplicada é imutável
  (R4).
- **Teste colocado ao lado do código novo**; spec de integração limpa a própria
  tabela no `beforeEach` (§9).
- **Magic string/número** que o scanner não cobre (headers, chaves, limites) —
  exceto nomes em `infra/drizzle/schema/*.ts`, que o `CLAUDE.md` isenta.
- **Comentário que mente**: o texto descreve um comportamento que o código já não
  tem. Vale como achado.

### 4. Classifique

| Severidade | O que cai aqui |
|---|---|
| **CRÍTICA** | Segredo/dado sensível cruzando fronteira (log, resposta, erro de driver); camada pura importando IO/infra; `process.env` fora de `env.ts`; infra de um módulo alcançando outro |
| **ALTA** | R7 (não determinismo na pura); import fora do padrão; teste lendo `process.env`; container alcançado por quem não pode; dependência com `^`/`~` |
| **MÉDIA** | Convenção com efeito local: `z.iso.datetime()` em resposta, `try/catch` no endpoint, status inline, `db.query.*`, arquivo fora do mapa de fronteira |
| **BAIXA** | Estilo, nomenclatura, comentário desatualizado sem efeito |

**Status geral — derivado, não opinado:**

- 🔴 **Reprovado** — ao menos uma CRÍTICA.
- 🟡 **Aprovado com Ressalvas** — nenhuma CRÍTICA, ao menos uma ALTA ou MÉDIA.
- 🟢 **Aprovado** — só BAIXA, ou nada.

### 5. Emita o relatório

Auditoria **relata**; corrigir é decisão de quem lê. Só aplique correção se
pedirem explicitamente, e em passo separado, depois do relatório.

## O relatório

Markdown, exatamente estas três seções, nesta ordem.

````markdown
## 1. Resumo Executivo

**Status:** 🔴 Reprovado
**Escopo:** 12 arquivos (diff contra `main`)

| Severidade | Total |
|---|---|
| CRÍTICA | 2 |
| ALTA | 1 |
| MÉDIA | 3 |
| BAIXA | 0 |

<uma frase dizendo o que decidiu o status — o achado mais grave, não um resumo>

## 2. Violações Encontradas

### 🔴 CRÍTICA — Vazamento de Dados · `src/modules/x/infra/drizzle/x-repository.ts:31`

**Regra violada:** ARCHITECTURE §6 — erro de driver não sai do `infra/`
**Problema:** <o que acontece em produção, não a regra reescrita>

```diff
- throw error
+ throw toPersistenceError(error)
```

### 🟡 MÉDIA — Documentação da API · `…:18`
<mesma forma>

## 3. Checklist de Verificação Executado

| # | Verificação | Status |
|---|---|---|
| 1 | Nenhum import de IO/infra na camada pura | ✅ |
| 2 | Nenhum `process.env` fora de `src/infra/config/env.ts` | ✅ |
| 3 | Nenhum vazamento de credencial/hash/query em log ou resposta | ❌ 1 |
| 4 | Isolamento de `module-infra` entre módulos | ✅ |
| 5 | `IClock`/`IIdGenerator` no lugar de valor não determinístico | ✅ |
| 6 | Erro de banco traduzido sem expor o erro cru do driver | ❌ 1 |
| 7 | Imports subpath (`#…`) e extensão `.js` nos relativos | ✅ |
| 8 | Data em schema de resposta como `z.date()` | ⚠️ 1 |
| 9 | Endpoint declara todo status que produz | ✅ |
| 10 | Schema de resposta sem campo sensível | ✅ |
| 11 | `pnpm lint`, `pnpm typecheck` e `pnpm test:unit` verdes | ✅ |
````

**O checklist é derivado da seção 2, não preenchido à parte.** Antes de fechar,
passe cada violação da seção 2 pela linha do checklist que a cobre: se alguma
cai ali, a linha é ❌ com a contagem. Uma linha ✅ acima de um achado que
pertence a ela é o defeito mais fácil de cometer neste relatório — e é o que faz
o leitor confiar no resumo em vez do corpo.

**Regras da forma:** um bloco por violação, CRÍTICA primeiro. `arquivo:linha`
sempre — achado sem linha não é acionável. Todo bloco carrega diff de correção;
quando a correção depende de decisão (dois caminhos válidos), escreva os dois e
diga qual você recomenda. Linha de checklist marca `n/a` quando o escopo não tem
arquivo daquela camada — nunca ✅. E ✅ só depois de ter olhado: um item que você
não verificou é `n/a`, não aprovado.

## Racionalizações que invalidam a auditoria

| Pensamento | Realidade |
|---|---|
| "O scanner não apontou nada, então passou" | Ele cobre o que regex prova. O passo 3 existe porque o resto não é. |
| "É só um teste, testes são exceção" | A tabela de fronteira isenta `test` de **import**, não de segredo. Spec que loga erro cru vaza igual. |
| "O lint já pega isso" | R6 e a fronteira têm dente (§4); R7 não. E o portão vê o grafo, não a intenção — é o motivo desta skill existir. |
| "É uma linha só, marco MÉDIA" | Vazamento não tem severidade proporcional à contagem. Uma linha basta para o hash sair no log. |
| "Código pré-existente, não é do diff" | Reporte com o escopo marcado. Idade não rebaixa severidade. |
| "Corrijo enquanto audito" | Relatório primeiro. Correção misturada esconde o que foi encontrado. |
| "A intenção estava certa" | A regra vale pelo que o código faz. |

## Manutenção

Editou o scanner ou uma regra de fronteira mudou em `ARCHITECTURE.md`?

```bash
node .claude/skills/architecture-audit/tests/run-tests.mjs
```

Ele afirma as duas direções: toda violação plantada é detectada na linha certa, e
os dois fixtures **corretos** produzem zero achados. Regra nova entra com fixture
novo — violação e contra-exemplo limpo — antes do código do check.
