# Handoff — Fatia 11: fechar o account pre-hijacking

> Escrito em 2026-09-05, ao fim da fatia 10, para uma sessão que começa sem o
> contexto dela.

## 0. Como ler este documento

Cada afirmação de fato carrega uma marca, pela mesma razão do handoff anterior:

- **[medido]** — eu rodei e li a saída. Reproduza se duvidar, mas duvide menos.
- **[lido]** — li o código-fonte e conclui. Provável, não provado.
- **[suposto]** — raciocínio sobre o que ainda não existe. Trate como palpite.

**Qualquer coisa sem marca é opinião.**

E uma calibração que a fatia 10 cobrou caro, no §4.1: **uma correção revisada e
aprovada por três revisores ainda pode não corrigir nada.** Aquela correção tinha
teste, falsificação e revisão limpa. Continuava errada, porque o raciocínio por
trás dela estava errado — e nenhum teste que a acompanha testava o raciocínio.

## 1. O que esta fatia entrega

Fecha uma **vulnerabilidade real, aberta e conhecida** que a fatia 10 introduziu
e não conseguiu fechar. O ataque, reproduzível hoje na `main` depois do merge da
fatia 10 **[medido]** — há teste de integração cobrindo a metade que foi
corrigida, e a metade que sobrou é a mesma mecânica com a ordem invertida:

1. o atacante cadastra `vitima@exemplo.com` com a **senha dele**. Responde `202`.
   A conta existe, não verificada, e o gate do login barra até o atacante;
2. a vítima cadastra o mesmo endereço com a **senha dela**. Cai no `23505`, o
   caminho de colisão emite um código novo e o manda para a caixa da vítima. É
   indistinguível de um cadastro normal;
3. a vítima confirma. A conta fica **verificada**;
4. **de quem é a senha da conta agora?** Da última pessoa que cadastrou antes da
   confirmação. Se o atacante cadastrar depois da vítima e antes de ela
   confirmar, a senha é dele — e a vítima não recupera, porque
   `POST /auth/password` exige a senha atual e a recuperação de senha ainda não
   existe.

A categoria tem nome e literatura: **account pre-hijacking**, catalogada em 2022
por Sudhodanan e Paverd. Num estudo de 75 serviços populares, cerca de metade
estava vulnerável a alguma variante. Não é defeito exótico: é o que acontece em
**todo sistema que cria a linha em `users` antes de provar o endereço** — o
`confirmable` do Devise, o usuário inativo do django-allauth, o
`email_verified: false` do Auth0.

## 2. Leia primeiro, nesta ordem

1. `docs/superpowers/specs/2026-09-03-email-verification-design.md` **§6.1** — o
   caminho de colisão do `register` e por que ele existe. É a peça a ser
   substituída, e o raciocínio dela está certo até a última linha, onde erra.
2. O mesmo documento, **§12** — treze custos aceitos. Vários viram escopo desta
   fatia ou morrem com ela.
3. `src/modules/auth/use-cases/register-user.ts`, o método
   `#deliverForExistingAccount` — trinta linhas, e é o epicentro.
4. `.superpowers/sdd/2026-09-03-email-verification/final-review.md`, se ainda
   existir. É a revisão que achou o buraco; o diretório é gitignored e pode ter
   sumido.

## 3. Por que a correção da fatia 10 não bastou

Vale entender, porque a mesma armadilha espera a sua correção.

A fatia 10 corrigiu escrevendo o hash da senha nova **dentro da mesma transação
que emite o código novo**. O raciocínio era: o código só chega na caixa do dono
do endereço, logo confirmar sempre verifica uma senha escolhida por quem controla
a caixa.

**O raciocínio é falso**, e a frase que o derruba é curta: *o dono da caixa não
consegue distinguir de qual cadastro veio o código*. Ele recebe um código, ele
confirma. Se o último cadastro foi do atacante, a senha aplicada é a do atacante.

A correção não foi inútil — ela estreitou a janela de "para sempre" para "entre o
cadastro da vítima e a confirmação dela". Mas **estreitar não é fechar**, e o
documento não deve fingir o contrário.

**A raiz é a invalidação.** `EmailVerificationIssuer.issueFor` chama
`invalidateActiveForUser` antes de inserir o código novo **[medido]**, para
manter o invariante "um código vivo por usuário". É esse invariante que empurra a
vítima para o código do atacante: o código dela morre, e o único que funciona é o
do agressor. Qualquer correção que preserve esse invariante herda o problema.

## 4. As saídas, e a que eu recomendaria

### 4.1 — Registro pendente, e a conta nasce na confirmação *(recomendada)*

O cadastro para de escrever em `users`. Escreve num registro pendente que carrega
e-mail, hash da senha e código. `users` só ganha linha **na confirmação**, com a
senha daquele registro.

Vários pendentes coexistem para o mesmo endereço, **sem invalidar uns aos
outros** — e é isso que fecha: cada código carrega a própria senha, ninguém é
empurrado para o registro alheio. Quem confirmar com o código que recebeu leva a
conta; o segundo confirm encontra conta verificada e vira no-op.

É a resposta dominante no mercado e a única que fecha **junto com** a
anti-enumeração, em vez de contra ela.

### 4.2 — Expirar conta não verificada

Varredura apaga não confirmadas depois de N horas. Barato, depende do `cron.ts`
(fatia já no roteiro). **Não fecha** — limita a janela de squatting. Serve como
mitigação parcial, nunca como a correção.

### 4.3 — Senha definida na confirmação

O cadastro pede só o e-mail; o código leva a uma tela "crie sua senha". Fecha por
construção. Custo: dois passos e uma mudança de contrato maior que a da 4.1.

### 4.4 — Defesa em profundidade, vale junto com qualquer uma

Invalidar **toda sessão** no instante da verificação, e notificar o dono. É o que
a literatura recomenda por cima da correção estrutural, não no lugar dela.

## 4.5 — Login social está no roteiro, e isso sobe o custo de escolher errado

**Decidido em 2026-09-06:** o Google entra como provedor no futuro. Isso não é
detalhe de outra fatia — muda o que esta aqui deve escolher.

O pre-hijacking **não é só herdado** pelo cadastro federado: a variante mais
citada do estudo de 2022 é exatamente essa, o *Classic-Federated Merge*. O
atacante cadastra `vitima@gmail.com` com senha pelo fluxo normal; meses depois a
vítima clica em "Entrar com Google"; o app vê o e-mail bater e **funde**; e a
senha do atacante continua valendo. É a falha de hoje mais um passo de merge — e
o merge é a parte que os apps erram, porque parece hospitalidade.

Três decisões já tomadas, registradas no §6 do `DECISIONS.md`, que esta fatia
deve respeitar:

1. **Não haverá troca de e-mail** — o endereço passa a ser asserção do IdP.
2. **Sign-in do Google sobre cadastro pendente: o Google ganha**, a conta nasce
   verificada, e os pendentes são descartados de modo que **não possam mais
   definir senha depois**.
3. **Sign-in do Google sobre conta verificada com senha: recusa o merge e exige
   a senha cadastrada**, e só então vincula a identidade.

**O que isso implica para a escolha do §4.** A saída 4.1 — a conta nasce na
confirmação — é, por acaso, exatamente o formato que o login federado quer: o
Google já provou o endereço, então cria uma conta verificada direto, sem senha e
sem etapa pendente. E ela **elimina** o estado "conta não verificada com senha",
que é justamente o estado que o item 2 acima precisa tratar com cuidado.

Um remendo mais estreito no fluxo atual resolveria o sintoma e teria de ser
refeito quando o Google entrar. Isso é argumento a favor da 4.1, e vale mais que
qualquer um listado no §4.1 original.

## 5. As armadilhas desta fatia

### 5.1 — O índice único deixa de proteger o caminho pendente [lido]

Hoje a segurança contra corrida no cadastro é o índice
`users_email_lower_unique`: o repositório **insere e trata o `23505`**, nunca
consulta-e-insere, porque consultar-e-inserir corre. Com registro pendente, dois
cadastros simultâneos do mesmo endereço são **legítimos** e o índice não opina.

A corrida se muda para o `confirm`: duas confirmações simultâneas de pendentes
diferentes do mesmo endereço podem ambas tentar criar o usuário. Uma perde no
índice único — e aí o `confirm` precisa decidir o que responder, **sem virar
oráculo**. Provavelmente o mesmo erro genérico de sempre.

### 5.2 — O `202` do register fica mais fácil, não mais difícil

Hoje o `register` tem três ramos e um `catch` de `EmailAlreadyInUseError` para
decidir qual e-mail sai. Com registro pendente, cadastro em endereço livre e
cadastro em endereço com pendente são **o mesmo caminho** — só o endereço já
**verificado** diverge, e esse continua recebendo "você já tem conta". O código
encolhe. Desconfie se estiver crescendo.

### 5.3 — Um pendente carrega uma senha em repouso [suposto]

Hoje o hash da senha só existe em `users`. Com registro pendente ele passa a
existir também numa tabela de curta duração, para contas que talvez nunca
existam. É argon2, não texto claro, então o estrago é limitado — mas é superfície
nova e merece uma linha nos custos aceitos, junto com a decisão de poda.

### 5.4 — O que morre e o que sobrevive de §12

Alguns custos aceitos da fatia 10 **desaparecem** com a 4.1 — vale conferir um a
um em vez de copiar a lista. O teto de tentativas queimável por anônimo (§12.11)
provavelmente sobrevive; o oráculo por latência do reenvio (§12.10) sobrevive
inteiro, porque não tem nada a ver com esta fatia.

## 6. O que já está pronto e te espera [medido]

| Peça | Onde | Estado |
|---|---|---|
| `IEmailSender` + `SmtpEmailSender` | `shared/ports/`, `infra/providers/` | pooling ligado, teardown no `onClose`, TLS ≥ 1.2, `requireTLS` obrigatório em produção |
| `BestEffortEmailSender` | `infra/providers/` | o decorador que aplica política de falha por fiação |
| Thunk `DeliverVerification` | `services/email-verification-issuer.ts` | persiste dentro, envia depois do commit — o padrão do §8 já resolvido |
| `ITokenGenerator.numericCode` | `shared/ports/token-generator.ts` | uniforme via `randomInt`, zeros à esquerda preservados |
| `registerFailedAttempt(id, max)` | `repositories/email-verifications-repository.ts` | teto **atômico**, à prova de concorrência |
| `consume(id, at) → boolean` | idem | uso único à prova de corrida, via contagem de linhas |
| Mailpit no compose e no CI | `docker-compose.yml`, `ci.yml` | com health check |
| Cliente de teste do Mailpit | `tests/integration/setup/mailpit.ts` | espera por condição, nunca `sleep` |
| `verify-email.spec.ts` | `tests/integration/` | o fluxo inteiro ponta a ponta, e o teste do ataque |

O grosso da infraestrutura desta fatia **já foi pago pela anterior**. O que resta
é desenho de domínio.

## 7. Estado do repositório [medido]

Branch `feat/email-verification`, **24 commits** à frente de `main`.

`pnpm lint`, `typecheck` e `build` verdes; **328 testes unitários**, **135 de
integração**, rodados separadamente. Auditoria de arquitetura em **0 achados**.
`docker compose up -d` sobe Postgres (5432), Postgres de teste (5433) e Mailpit
(1025 SMTP, 8025 UI).

Regras que a fatia 10 mudou e você herda:

- **§9 do Unit of Work** admite **escrita** no `Pick`, quando a linha 3 do §8 a
  justifica. `ConfirmEmailUseCase.registerFailedAttempt` é o primeiro caso.
- **Decisão 25** — `register` responde `202` sempre. Contrato público quebrado de
  propósito.
- **Decisão 26** — sem backfill de `email_verified_at`, com ressalva normativa
  para apps derivados já em produção.
- **`notifications/`** é pasta nova na camada pura, e está na tabela de fronteira
  **e** no scanner da auditoria — os dois precisam concordar; da primeira vez não
  concordaram.

> ⚠️ **Armadilhas de ambiente que não são do repositório.** `pnpm lint | tail -1`
> devolve o status do `tail` — rode cada portão sozinho e leia o exit code.
> `pnpm test:unit -- <arquivo>` **não filtra**: use
> `pnpm vitest run --project unit <arquivo>`. A porta 3000 pode estar ocupada.

## 8. O método deste repositório

Brainstorming → spec em `docs/superpowers/specs/` → plano em
`docs/superpowers/plans/` → execução. Três práticas cobraram preço na fatia 10:

**Verifique, não presuma.** Duas suposições marcadas `[suposto]` foram medidas e
confirmadas; a terceira continua marcada, honestamente.

**Falsifique todo teste, e a DELEÇÃO antes da troca.** `toEqual` no log de
chamadas inteiro mata deleção, reordenação e realocação de uma vez; `toContain`
não mata nenhuma.

**E desconfie de revisão limpa em raciocínio novo.** O §3 aqui existe por isso: a
correção que não corrigiu passou por três revisões. O que faltou não foi rigor de
teste — foi alguém perguntando *"e se o dono da caixa não souber de qual cadastro
veio o código?"*. Quando a fatia inteira depende de uma frase em prosa, ataque a
frase, não o código.

## 9. O roteiro depois desta

| Fatia | Depende de | O que destrava |
|---|---|---|
| **Recuperação de senha** | esta | e é **por isso** que ela vem depois: hoje uma conta tomada não tem como ser recuperada, e a recuperação sobre um desenho vulnerável só amplia a superfície |
| **Poda** (`cron.ts`) | entrypoint novo | `refresh_tokens` **e** `email_verification_tokens` crescem sem limite; a 4.2 desta fatia também precisaria dela |
| **CORS** | primeiro front web | sem ele o modo cookie não funciona cross-origin |

**Três decisões continuam sem dono**, no `DECISIONS.md` §6: RBAC, a sessão sem
teto absoluto, e a colisão de nome de tabela entre módulos.
