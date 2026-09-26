# Decisões (ADRs)

Decisões reais, já tomadas neste projeto — nenhuma inventada. Este
documento é uma **vista curada** em formato ADR; o registro completo,
com data, medição e o texto exato da exceção, está em `CONSTRAINTS.md`
(raiz) e em `CLAUDE.md` (raiz). Onde os dois divergirem, eles são a
fonte — corrija esta vista.

## ADR-001 — Banco de dados dedicado, nunca compartilhado com outro produto

**Status:** adopted

**Context:** San Checkout processa dado de terceiro (contratantes e
seus pagadores) e dinheiro. Compartilhar o banco com outro produto
reduziria custo de administração, mas aumentaria o raio de dano de
qualquer incidente.

**Decision:** San Checkout tem seu próprio projeto Supabase
(`San_Checkout`, `zacuaroarelaqnzjjlcz`), nunca compartilhado com
projetos-contratantes nem com qualquer outro serviço. Confirmado: é o
único projeto Supabase que este repositório referencia em código ou
configuração.

**Reason:** Raio de dano (migration errada ou credencial vazada fica
contida a este serviço); mistura de responsabilidade (dado de cliente
de terceiro nunca convive com dado de outro produto no mesmo banco);
isolamento de contrato (contratantes acessam o Checkout só pela
`API.md`, nunca por acesso direto ao banco).

**Consequences:** Toda integração entre San Checkout e um contratante
passa por API autenticada — nunca por acesso a banco. Ver
`ARCHITECTURE.md`.

---

## ADR-002 — Modelo pull para o motor de pagamento

**Status:** adopted

**Context:** O Checkout precisa saber o que cobrar sem se tornar
acoplado ao catálogo/regra de negócio de cada contratante.

**Decision:** O Checkout nunca recebe valor/dado do link — ele liga de
volta na API do contratante (`GET /pedido/{id}`) para obter o valor real
e cobra isso, nunca o que veio na URL.

**Reason:** Isolamento de dado (skill `classificar`) e segurança:
adulterar o link não muda o valor cobrado.

**Consequences:** Todo contratante precisa manter um endpoint disponível
com resposta em até 45s; cold start de hospedagem gratuita já foi
medido como o pior caso a calibrar.

---

## ADR-003 — Pagamento em sandbox com backend em produção real

**Status:** adopted (exceção com gatilho de saída)

**Context:** A Estação 5 (Construção) do processo `san-co` normalmente
exige deploy apontando para o ambiente real do provedor, inclusive
pagamento.

**Decision:** O backend está em produção real (domínio, banco, deploy
automático) mas a Asaas continua em modo sandbox.

**Reason:** Decisão do dono, condicionada a o MostrAí (contratante)
bater o mesmo ponto de equilíbrio do lado dele antes da troca.

**Consequences:** Nenhuma cobrança real acontece hoje; a troca para
produção é uma ação explícita e documentada (`RUNBOOK.md` §6.2), não
uma consequência automática de nenhum deploy. Ver `PROJECT_STATE.md`.

---

## ADR-004 — Sem split de pagamento: 100% na conta-mãe

**Status:** adopted (exceção registrada, Lei 7)

**Context:** O modelo original previa possível split de pagamento entre
contratante e conta-mãe via subconta Asaas.

**Decision:** Sem split hoje; toda cobrança cai inteira na conta-mãe.

**Reason:** Subconta Asaas exige que a conta-mãe seja PJ no registro —
a conta é PF (pessoa física, em transição, ver ADR-006). Virou
atualização futura.

**Consequences:** `docs/proximas-versoes.md` — sem split, o modelo de
repasse a contratantes (se vier a existir) precisa de outro mecanismo.

---

## ADR-005 — scrypt no lugar de Argon2id

**Status:** adopted (exceção registrada, Lei 3)

**Context:** Argon2id é o KDF recomendado atualmente para hash de senha.

**Decision:** Usar scrypt (`src/utils/senhaAdmin.js`, N=2^17, medido
~1–1,3s por hash).

**Reason:** Registrado em `CONSTRAINTS.md` §3 com a justificativa e o
parâmetro medido — consultar lá para o detalhe técnico completo
(disponibilidade de biblioteca no runtime, custo medido).

**Consequences:** Login do admin tem esse custo de CPU por tentativa —
aceitável para uma única conta de operador, seria um problema em
escala de usuário final.

---

## ADR-006 — Documentos legais identificam pessoa física, em transição

**Status:** adopted (exceção registrada, Lei 10)

**Context:** O operador do Checkout mudou de CNPJ para CPF como
identidade legal de cobrança.

**Decision:** Termos de Uso e Política de Privacidade (v3) identificam
o CPF `552.085.198-01` como o operador, não mais o CNPJ antigo.

**Reason:** Registrado em `CONSTRAINTS.md` §3 — decisão do dono,
motivada pela estrutura societária em transição.

**Consequences:** Toda superfície pública que cita a identidade do
operador precisa citar o CPF, não o CNPJ antigo — já houve um caso de
divergência real corrigido (`docs/erros/2026-09-19-...` via `CLAUDE.md`
19/09/2026, rodapé do checkout citando o CNPJ antigo).

---

## ADR-007 — Credencial Cloudflare no ambiente é a conta inteira (Global API Key)

**Status:** adopted (exceção registrada, risco aceito conscientemente)

**Context:** Operações contra a Cloudflare (DNS, Pages, Access) exigem
credencial; o ideal de segurança é um token escopado por operação.

**Decision:** O ambiente de agente tem `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL`
— a Global API Key, que dá acesso à conta inteira, não só à zona deste
projeto.

**Reason:** Registrado em `CONSTRAINTS.md` §3 — praticidade operacional
sobre uma conta pequena, de um único operador. Nota de risco: a mesma
zona Cloudflare (`sancocore.com.br`) hospeda registros DNS de outros
projetos além deste repositório (confirmado via `list dns_records` —
ver `runbooks/cloudflare.md`), então essa credencial JÁ alcança mais do
que só San Checkout, mesmo sem cruzar organização.

**Consequences:** Qualquer chamada usando essa credencial precisa ser
tratada como potencialmente afetando toda a conta Cloudflare, não só
`sancocore.com.br`. Ver `RISKS.md` e `runbooks/cloudflare.md`. Migrar
para token escopado é melhoria registrada, não executada — não quebrar
a integração existente só para trocar de credencial fora de uma tarefa
que peça isso especificamente.

---

## ADR-008 — Mesclar na `main` sem pedir, quando o CI está verde

**Status:** adopted (18/09/2026)

**Context:** Pedir "posso mesclar?" a cada PR, quando a única porta real
é o CI, é atrito sem ganho de segurança — quem aprova muitos merges por
dia aprova o último sem olhar.

**Decision:** O dono autorizou mesclar na `main` sem pedir, sempre que
o CI estiver verde. Mesclar aqui é publicar (deploy automático).

**Reason:** `CLAUDE.md` (raiz), seção "Mesclar é decisão tomada".

**Consequences:** A pergunta dispensada é "posso mesclar?" — a lista
curta de itens que exigem autorização para **construir** (caminho de
dinheiro, segredo, migration destrutiva, contrato consumido por outro
projeto) continua exigindo autorização, antes de a mudança existir,
não no momento de mesclar. Ver `AUTONOMY.md`.

---

## ADR-009 — Reconciliar `valor` da assinatura contra a Asaas, e denunciar divergência

**Status:** adopted (18/09/2026)

**Context:** A conciliação de assinatura reconferia `status`/`ciclo`/
`proximaCobranca` contra a Asaas, mas devolvia `valor` sem reconferir —
preço alterado no painel da Asaas deixava o registro do Checkout errado
para sempre, sem sintoma.

**Decision:** A conciliação passou a reconferir e corrigir `valor`
também, **e** a devolver `divergenciaDeValor` quando encontrar
diferença — as duas coisas juntas, não uma alternativa à outra.

**Reason:** Quem debita o cartão é a Asaas — um número divergente do
Checkout não é opinião, é informação falsa. Corrigir calado trocaria um
erro visível por uma mudança invisível; o contratante é quem fala com o
assinante (RN-35) e precisa saber que o preço mudou.

**Consequences:** `API.md` §5.3 e §7.5 mudaram de "não confie neste
campo" para "é a verdade reconferida". Comparação feita em centavos,
não em reais (ponto flutuante criaria divergência falsa).

---

## ADR-010 — Ano comercial de 360 dias (mês de 30) para o cálculo proporcional

**Status:** adopted (17/09/2026)

**Context:** O acerto proporcional de troca de plano precisa de uma
convenção de dias por ciclo — calendário real (365/366, meses
desiguais) ou convenção comercial.

**Decision:** Mês comercial de 30 dias, logo ano de 360 —
`src/services/proporcionalService.js`, `DIAS_DO_CICLO`.

**Reason:** Decisão do dono, registrada com o exemplo numérico
(anual de R$ 2.400 dá resultado diferente com 360 vs. 365 dias — a
decisão muda o número cobrado de verdade).

**Consequences:** Todo cálculo de dias restantes usa essa convenção;
mudar exigiria reabrir a decisão e recalcular casos já registrados
como corretos nos testes (`proporcionalService.js`, autoteste com 42
checagens).

---

## ADR-011 — Assinatura de cartão não troca de valor neste lançamento

**Status:** adopted (26/09/2026)

**Context:** Na homologação real, com a assinatura anual paga no cartão,
a Asaas recusou o rebaixamento: `400` "Não é possível alterar o valor de
assinaturas via cartão de crédito que já possuam faturas pagas". Pelo
Checkout, toda assinatura de cartão nasce com a primeira fatura paga.

**Decision:** `DIRECT_CARD_SUBSCRIPTION_PRICE_CHANGE = UNSUPPORTED`. A
rota `POST /trocar-plano` recusa assinatura de cartão com `409
troca_de_valor_nao_suportada` antes de qualquer efeito. Cancelar e
recriar não é construído agora.

**Reason:** Decisão do dono para o MVP: a opção simples. Recusar cedo
evita o pior caso, que é o upgrade cobrar o acerto no cartão e depois a
Asaas recusar mudar o valor.

**Consequences:** Para mudar o preço de quem assina no cartão, o
contratante cancela e o assinante assina o plano novo. A infraestrutura
de troca (intenção, aprovação, sweeper) continua valendo para os outros
meios. Reabrir exige desenhar o cancelar-e-recriar e medir o reuso do
token do cartão (`docs/pendencias.md`).

---

## Onde ver as decisões que não viraram ADR aqui

`CONSTRAINTS.md` (raiz) tem a lista completa e é a fonte — inclui, além
das acima: piso de R$ 5,00 por parcela, teto de chamada de saída,
migrations numeradas e imutáveis, cada evento de webhook marcado/
desmarcado e por quê, os limites de rate limiting e o que eles
entregam, e mais. Este `DECISIONS.md` não duplica a lista inteira —
adicione um ADR aqui quando a decisão for **arquitetural** (afeta como
agentes futuros devem pensar sobre o sistema), não quando for um
detalhe de implementação já coberto em `CONSTRAINTS.md`.
