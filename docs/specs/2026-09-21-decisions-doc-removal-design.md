# Fatia 29 — o comentário se sustenta sozinho (parte 1: `DECISIONS.md`)

> **Escopo desta fatia:** apagar `docs/DECISIONS.md` e todo ponteiro de código
> que aponta para ele. A segunda família de ponteiros (`§N` para documentos de
> desenho de fatia) fica para a parte 2 — o handoff está no fim deste documento.

---

## 1. O princípio

Comentário é para dizer **por que aquele código existe**. O que o código faz, o
leitor vê lendo o código. Um comentário que obriga a abrir outro documento não
explica — ele adia.

`DECISIONS.md` nasceu como controle de um processo de desenho que já terminou.
As decisões foram tomadas. O que restou é um documento de 2972 linhas que só
cresce, e 100 ponteiros no código que dependem dele para fazer sentido.

Esta fatia termina o que a fatia 27 começou quando decidiu que a documentação
descreve o estado, não a jornada.

## 2. O que existe hoje

124 citações `decision N` em 76 arquivos:

| Onde | Citações | Arquivos |
|---|---|---|
| `src/**/*.ts` | 91 | 64 |
| `ARCHITECTURE.md` | 17 | 1 |
| `docs/PRODUCT-CHOICES.md` | 7 | 1 |
| `tests/integration/*.spec.ts` | 3 | 3 |
| `.env.example`, `tsconfig.build.json`, `vitest.config.ts` | 3 | 3 |
| `.github/workflows/ci.yml` | 2 | 1 |
| `.claude/skills/architecture-audit/` | 2 | 2 |

Três dessas citações não ficam só no repositório. Duas em `tests/` estão no
**nome** do teste, e saem no output do `vitest`. Uma terceira família está nas
descrições de endpoint (`change-password`, `delete-account`, `logout-all`), que
viram texto do **documento OpenAPI publicado** — `— decision 11.` estava sendo
servido como documentação da API.

Além delas, quatro documentos linkam o arquivo: `README.md`,
`ARCHITECTURE.md` (duas vezes), `docs/PRODUCT-CHOICES.md` e
`src/modules/auth/README.md`.

## 3. O que é normativo e não pode sumir junto

`DECISIONS.md` §4 declara R1–R7, que o `pnpm lint`, o `dependency-cruiser` e a
skill `architecture-audit` enforçam. **R1, R2, R4, R6 e R7 já estão replicadas**
em `ARCHITECTURE.md` §4. **R3 e R5 existem só no documento que vai ser apagado**
e precisam migrar antes.

- **R5** — comunicação entre módulos só via Application ou Domain: a regra de
  ouro, as três abordagens (injeção de contrato de repositório, reuso de use
  case, eventos de domínio) e os três antipadrões proibidos. Vai para
  `ARCHITECTURE.md` §2, junto da tabela de fronteira que já enforça parte dela.
- **R3** — não cortar um "1.0 do boilerplate" antes do GA do Drizzle. Vai para
  `ARCHITECTURE.md` **§12 ("Decisões travadas")**, e não para o §4: o §4 é uma
  tabela de regras com mecanismo de enforcement, e R3 não tem mecanismo — é uma
  restrição de release, vizinha natural do pin do TypeScript e da escolha do
  Biome. Migra na **forma-estado**: a regra e o fundamento que vale
  hoje (`1.0.0-rc.4` é release candidate, e o roadmap ainda tem itens que tocam
  código nosso). A nota de revisão de 2026-08-25 e a calibração da previsão são
  história de processo e não migram.

## 4. Os três padrões de citação

A limpeza não é mecânica. Cada citação cai num destes casos:

**Aposto redundante** — o comentário já diz o porquê, e o número é um apêndice.
Recorta-se o parêntese e nada se perde.

```
- * In-memory adapter, for the unit tests of the use cases (decision 09).
+ * In-memory adapter, for the unit tests of the use cases.
```

**Número como sujeito da frase** — a frase se apoia gramaticalmente no ponteiro
e precisa ser reescrita.

```
- * over HTTP and kept for the non-HTTP entrypoints of decision 10.
+ * over HTTP and kept for the non-HTTP entrypoints.
```

**Motivo mora só no documento** — o comentário fica sem sentido sem o ponteiro.
Aqui o porquê é **trazido do `DECISIONS.md` para o comentário**, antes de o
documento ser apagado. É onde esta fatia ganha informação em vez de perder.

## 5. Ponteiros já quebrados

Dois comentários citam `§6 item 2 of DECISIONS.md`. O documento só vai até §5 —
a seção não existe e provavelmente nunca existiu com essa numeração:

- `src/modules/auth/entities/user.ts`
- `src/modules/auth/repositories/pending-registrations-repository.ts`

Ambos falam da mesma coisa: por que uma conta federada nasce com o e-mail já
verificado. Ganham o motivo escrito no lugar do ponteiro morto.

## 6. A convenção escrita

`ARCHITECTURE.md` linha 17 diz que "os comentários do código citam as decisões
por número (`decisão 11`), nunca re-argumentam". Depois desta fatia a frase é
falsa, então a linha sai.

`CLAUDE.md` tem a regra **"Cite, never re-argue"**, que é a mesma convenção na
forma normativa. Ela **fica como está nesta fatia**: enquanto os 71 ponteiros
`§N` existirem, a regra ainda descreve o código. Ela cai junto com eles, na
parte 2.

## 7. Verificação

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `node .claude/skills/architecture-audit/tests/run-tests.mjs`, porque a skill
  também citava o documento.
- Grep de aceitação: zero ocorrências de `decision N` e de `DECISIONS.md` fora
  de `docs/plans/`, `docs/specs/` e `docs/memory/`.

## 8. Fora de escopo

`docs/plans/`, `docs/specs/` e `docs/memory/` são registros datados do que foi
feito quando foi feito. Citam o `DECISIONS.md` porque ele existia. Ficam
intactos — reescrever registro histórico é a prática que a fatia 27 condenou.

---

## Handoff — parte 2

**O que sobra:** 71 ponteiros `§N` em 39 arquivos de `src/`, apontando para
seções de documentos de desenho de fatia.

**Por que é pior que o que esta fatia resolveu:** `(decision 11)` ao menos nomeia
o alvo. `(§8)` e `(§9)` não nomeiam documento nenhum — o leitor precisa primeiro
descobrir **qual** documento abrir. Exemplos:

```
src/modules/auth/use-cases/reset-password.ts     // argon2, outside the transaction (§8)
src/modules/auth/use-cases/register-user.ts      /** the narrowing IS the rule (§9) */
src/modules/auth/use-cases/prune-expired-refresh-tokens.ts   * the trade-off are design §3.4
```

**O que a parte 2 precisa fazer:**

1. Para cada `§N`, identificar o documento de desenho alvo e trazer o motivo
   para o comentário, pelos mesmos três padrões da §4 deste documento.
2. Remover a regra **"Cite, never re-argue"** do `CLAUDE.md`, substituindo-a
   pelo princípio da §1: o comentário se sustenta sozinho.
3. Decidir o que acontece com `docs/plans/` e `docs/specs/` — nesta fatia eles
   ficaram porque são registro histórico, mas se o código deixar de apontar para
   eles, vale perguntar se a pasta inteira ainda se paga.

**O que NÃO refazer:** a limpeza dos `decision N`, feita aqui, e a migração de
R3/R5, também feita aqui.
