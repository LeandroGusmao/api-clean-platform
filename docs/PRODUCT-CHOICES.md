# O que cada produto decide

**Nada aqui é lacuna do boilerplate.** São escolhas que dependem do que o app
faz, de quem usa e de qual é o risco — e por isso não têm resposta certa antes
de existir um produto para validá-las contra.

A fila de pendências do boilerplate fechou em 2026-09-20. O que resta é esta
lista, e quase tudo nela está travado no mesmo gatilho: **qual app
derivado vem primeiro.** Os dois candidatos mudam a ordem — um agregador
financeiro sobe MFA e criptografia em repouso; um app de alimentação sobe
trilha de auditoria e retenção.

Cada entrada diz: o que é · por que não está aqui · o que reabre · o que custa
enquanto não for feito.

A estrutura que o código segue está no [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## MFA / TOTP

**O que é.** Segundo fator no login, tipicamente TOTP com app autenticador.

**Por que não está aqui.** Não aparece em nenhum documento do projeto, e não é
esquecimento: MFA obriga a decidir recuperação (códigos de backup? SMS? e-mail?),
e cada resposta tem um perfil de risco diferente. Sem produto, a escolha seria
arbitrária — e MFA mal desenhado tranca o usuário fora da própria conta.

**Gatilho.** O primeiro app derivado que trate dado sensível. É a maior ausência
de produto para um app financeiro.

**Custo enquanto isso.** A senha é o único fator. Uma credencial vazada em outro
serviço e reusada aqui dá acesso completo, e nada no servidor distingue isso de
um login legítimo.

---

## Contagem de falha de autenticação / lockout

**O que é.** Contar senhas erradas por conta ou por par IP+e-mail, e bloquear
após N.

**Por que não está aqui.** Decisão tomada de **não** fazer no app, não omissão.
O limitador conta requisição, não falha — só a aplicação sabe que a senha estava
errada, mas implementar isso exigiria porta de store, política de dois baldes na
camada pura, teto de memória com política de despejo e um caminho próprio para
Redis, para reimplementar pior o que a borda (Cloudflare/WAF/ALB) já faz na
metade grossa do problema.

A política de par IP + e-mail foi analisada e **descartada**: o par sozinho não
detém ataque distribuído (mil IPs são mil baldes), e o balde por e-mail que o
deteria é vetor de DoS contra a vítima — qualquer um trava a conta de qualquer
pessoa sabendo só o endereço.

**O que segura hoje.** O teto de 10/min por endereço no login, compartilhado
entre réplicas via Redis; o custo do argon2, medido em 7,3 ms e 19 MB por
tentativa; a equalização de tempo do login, que impede descobrir
*qual* conta existe antes de atacá-la; e o teto por IP na borda, que é onde uma
botnet é visível de verdade.

**Gatilho.** O primeiro app derivado que trate dado sensível (saúde, financeiro),
ou o primeiro incidente de conta comprometida por força bruta. **O primeiro
gatilho já foi levantado** pela auditoria de 2026-09-07 — trate isto como
reaberto, não como decidido.

**Custo enquanto isso, com todas as letras.** Uma conta de e-mail conhecido e
senha fraca pode ser quebrada por uma botnet paciente — cada IP gasta 10/min,
mil IPs somam dez mil tentativas por minuto — e **nada no servidor vai notar**.
A proteção de borda só vale para o tráfego que passa por ela: se o IP de origem
for alcançável direto, o atacante pula tudo.

---

## Checagem de senha vazada

**O que é.** Recusar, na criação da senha, uma que já apareceu em vazamento
público — por API externa (HIBP, com k-anonymity) ou lista embarcada.

**Por que não está aqui.** A decisão entre API externa e lista embarcada não foi
tomada, e ela muda o desenho inteiro: a API acrescenta uma dependência de rede
num caminho crítico e uma decisão de fail-open/fail-closed; a lista embarcada
acrescenta megabytes ao build e envelhece.

**Gatilho.** Os primeiros usuários reais, ou o primeiro app derivado que trate
dado sensível — o que vier primeiro. **Adiada de propósito em 2026-09-19, não
esquecida.**

**Custo enquanto isso.** O piso é 8 caracteres e não há blocklist. Como o lockout
foi recusado acima, o custo do argon2 e a qualidade da senha são as duas únicas
defesas contra força bruta — e uma delas está no piso.

**Ressalva de desenho.** Um aviso por notificação, quando o app tiver esse canal,
cobriria só a checagem no login (contas que já existem). Não substitui a
validação na criação da senha, que é o que de fato protege.

---

## RBAC / permissões

**O que é.** Quem pode fazer o quê. Papéis, permissões, ou os dois.

**Por que não está aqui.** Reclassificada em 2026-09-17 de "decisão de
arquitetura pendente" para escopo de produto, pelo mesmo argumento que fechou o
outbox genérico: sem um segundo consumidor real não há como validar a forma
certa, e "quem pode fazer o quê" varia por produto de um jeito que "como
não vazar sessão" não varia. Um papel único (`admin`/`user`) seria simples demais
para servir de verdade; papéis com permissões associadas seria decisão tomada sem
produto nenhum para validar contra.

**Gatilho.** O primeiro app derivado que precisar de acesso diferenciado por
usuário. A decisão certa depende do que **esse** produto precisa — papel único?
por recurso? por organização? — e não do que este documento adivinharia hoje.

**Trade-off a preservar para quando for retomada.** Se o papel for para dentro do
JWT, mudança de permissão só vale no próximo refresh: janela de até o TTL do
access token. É a mesma latência de revogação que a autenticação já aceitou ao
manter o banco fora do caminho autenticado, passando a valer também para
autorização.

---

## Multi-tenancy

**O que é.** Isolar dados por organização/cliente dentro da mesma instalação.

**Por que não está aqui.** Decide a forma de quase toda tabela do sistema
(coluna `tenant_id`? schema por tenant? banco por tenant?), e a escolha errada é
cara de desfazer. Tomá-la sem produto seria adivinhação com custo alto.

**Gatilho.** O primeiro app derivado cujo cliente seja uma organização e não uma
pessoa.

**Custo enquanto isso.** Nenhum imediato — o `auth` é por pessoa e funciona. O
custo é futuro: retrofit de multi-tenancy num schema que não o previu toca todas
as tabelas e todas as queries.

---

## Criptografia em repouso

**O que é.** Cifrar colunas sensíveis no banco (column-level, `pgcrypto`, ou
cifra na aplicação).

**Por que não está aqui.** O `auth` não guarda dado sensível: guarda e-mail, hash
de senha (que é o oposto de reversível) e metadado de sessão. Não havia o que
cifrar.

**Gatilho.** O primeiro módulo que guarde dado sensível de verdade — saldo,
transação, dado de saúde.

**Custo enquanto isso.** Nenhum hoje. Mas o `auth` **estabelece o precedente**:
o módulo que guardar o dado vai copiar o padrão que encontrar, e hoje o padrão é
"texto puro no Postgres".

---

## Custo do argon2 acima do mínimo

**O que é.** Subir os parâmetros de tempo e memória do hash de senha.

**Por que não está aqui.** Os 7,3 ms / 19 MB atuais são o **mínimo recomendado
pela OWASP**, e tunar acima disso exige uma máquina-alvo para medir. O comentário
do adapter já registra isso como "hardening, once there is a target machine".

**Gatilho.** Existir uma máquina de produção definida para medir contra.

**Custo enquanto isso.** Cada tentativa de força bruta custa o mínimo aceitável,
não o máximo que a infraestrutura aguentaria. Junto com a ausência de lockout e
de checagem de senha vazada, é a terceira perna da mesma defesa.

---

## Step-up / reautenticação para operação de valor alto

**O que é.** Exigir a senha de novo (ou o segundo fator) antes de uma operação
sensível, com base em *há quanto tempo* e *por qual método* o usuário se
autenticou.

**Por que não está aqui.** O access token não carrega `auth_time` nem `amr`,
pela regra que o `ports/token-signer.ts` enuncia: um contrato nasce com o
consumidor dele, e nenhuma rota pergunta isso hoje. A deleção de conta, que seria
a candidata, resolveu com reapresentação da senha atual.

**Gatilho.** A primeira rota que precise distinguir "logado" de "logado agora" —
transferência de valor, mudança de dado bancário, exportação em massa.

**Custo enquanto isso.** Sentar os claims agora é barato; depois é migração de
formato de token, com janela de coordenação se já houver cliente em produção.
É a mesma aritmética do `kid` abaixo.

---

## `kid` no JWT (rotação da chave de assinatura)

**O que é.** Etiquetar o header do access token com o nome da chave que o
assinou, permitindo que o servidor tenha uma chave que assina e outras que só
verificam.

**Por que não está aqui.** Adiado em 2026-09-20. Verificado no código:
`POST /auth/refresh` não passa pelo guard e não lê o access token —
consome só o refresh token opaco. Trocar o `JWT_SECRET` ao vivo **não desloga
ninguém**: cada cliente toma um `401`, chama `/refresh` e segue, que é o mesmo
caminho que já percorre a cada expiração. O que o `kid` compra é **timing**, não
segurança: evita que todos renovem no mesmo instante. Sem usuário em produção,
essa estampida é de zero requisições.

**Gatilho — e ele é anterior à necessidade, de propósito.** Reabrir **antes** do
primeiro app derivado ir a produção, não quando a estampida aparecer. O `kid`
muda o formato do header do token, barato de mudar enquanto não há cliente lá
fora e caro depois.

**Custo enquanto isso.** Uma troca de chave produz um pico de refreshes
simultâneo. Nada quebra; o banco trabalha mais por alguns segundos.

**O desenho já explorado**, para quem retomar: manter `JWT_SECRET` como a chave
que assina, com um `JWT_SECRET_KID` nomeando-a e uma variável verify-only com as
aposentadas (compatível com todo `.env` existente) — preferido sobre uma lista
JSON única, que quebra os ambientes, e sobre um `kid` derivado por hash do
segredo, que fica opaco para o operador. Existe uma meia-entrega: emitir o `kid`
no header agora, uma linha e zero config, deixando a verificação multi-chave
para depois.

---

## Colisão de nome de tabela entre módulos

**O que é.** Nada impede dois módulos declararem uma tabela `users`. O
`drizzle-kit` junta os globs e gera a migration com as duas — e o erro aparece
no `db:migrate`, não no lint.

**Por que não está aqui.** Decidido ficar em `public` por ora. As saídas
possíveis são disciplina, prefixo por módulo (`auth_users`) ou um schema do
Postgres por módulo (`pgSchema('auth')`), e `ALTER TABLE ... SET SCHEMA` torna a
migração posterior barata — então adiar custa pouco.

**Gatilho.** O segundo módulo com persistência própria.

**Custo enquanto isso.** Uma colisão passa pelo lint de fronteira e falha na
migration, longe da causa.
