# Spec — Troca de plano redireciona o pagador ao Checkout

Data: 20-21/09/2026. Autorizado a construir em 21/09/2026.

> Desenhado num relay de quatro rodadas entre o dono, esta sessão e um
> chat GPT externo — o dono trazia o julgamento de produto, o GPT
> propunha arquitetura, esta sessão verificava cada proposta contra o
> código real e corrigia o que não batia. Este documento é o resultado
> fechado, não a transcrição do relay.

## Problema

`POST /api/checkout/trocar-plano` (`API.md` §5.6, construído em 17/09,
no ar desde 18/09) é servidor-a-servidor: o contratante chama, o acerto
proporcional é cobrado no cartão salvo **sem o pagador ver nada**, e a
tela de "troca feita" é do contratante. Era decisão deliberada — "quem
troca de plano não decide o próprio plano pelo checkout" — registrada em
17/09/2026.

O dono testou o MostrAí em 20/09/2026 e reverteu a decisão: **quando há
valor a pagar, o pagador precisa consentir explicitamente na tela do
Checkout antes de a cobrança acontecer.** Três restrições dele, ditas
por inteiro:

1. A tela **não** deixa o pagador escolher plano — só aprovar o valor
   exato do acerto que o contratante já decidiu.
2. Consentimento explícito para qualquer cobrança — a rota silenciosa
   está errada.
3. Sem acerto a pagar (rebaixamento, absorção abaixo de R$ 5,00), **não
   há redirecionamento** — a troca acontece como hoje.

## Por que isto não é um patch na rota existente

A rota de hoje é **atômica e síncrona**: puxa plano → recusa cedo →
reivindica arrendamento → cobra → altera na Asaas → relê → grava →
responde, tudo numa chamada HTTP do contratante. Inserir um redirect no
meio quebra essa forma — a cobrança passa a acontecer numa requisição
**diferente**, disparada pelo **pagador**, chegando bem depois (segundos
a minutos) da chamada original do contratante. Isso introduz um estado
que não existia: "troca pedida, ainda não aprovada, pode nunca ser". A
coreografia inteira — arrendamento, fail-closed, releitura pós-`PUT` —
foi desenhada para uma operação só; vira uma máquina de estados.

## Desenho fechado

### As três saídas de `POST /trocar-plano`

O contratante continua chamando a mesma rota, com o mesmo contrato de
entrada. O que muda é a resposta:

| Acerto | HTTP | O que acontece |
|---|---|---|
| `acerto.cobra === false` (rebaixamento) | `200`, como hoje | Troca imediata, sem cobrança, sem redirect |
| `0 < acerto < R$ 5,00` (absorvido) | `200`, como hoje | Troca imediata, sem cobrança, sem redirect |
| `acerto >= R$ 5,00` | **`202 Accepted`** | Nada é cobrado nem alterado ainda. Corpo: `{ code: 'PLAN_CHANGE_APPROVAL_REQUIRED', status: 'approval_required', approvalUrl, expiresAt, amount }` |

O `202` é o único comportamento novo desta rota. As validações que já
recusam cedo (piso, ciclo, cobrança do período não confirmada, dado
incoerente, assinatura sem cartão salvo) continuam rodando **antes** de
criar a intenção — nada disso precisa da aprovação do pagador para ser
recusado.

### A tabela nova — intenção de troca

Migration `0011`. Uma linha por tentativa de troca com acerto devido,
com um **retrato congelado** no momento da criação — porque entre a
criação da intenção e a aprovação (até 15 minutos depois) o plano, o
ciclo ou a assinatura podem ter mudado, e a aprovação nunca recalcula às
cegas:

- **Identidade**: id opaco (é o que vai na URL), `assinatura_id`,
  `contratante_id`.
- **Retrato congelado**: `plano_id`, `plano_novo_id`, nomes e valores dos
  dois planos, ciclo atual e novo, `valor_pago_do_periodo`, vencimento,
  dias restantes, crédito, débito, valor do acerto — tudo que
  `calcularAcertoDeTroca` já produz hoje, persistido em vez de
  recalculado na aprovação.
- **Correlação financeira**: `metodo_pagamento: 'acerto_troca'`
  (reaproveita o que já existe), `externalReference` da cobrança Asaas
  = `troca:<intentId>` (hoje é `troca:<assinaturaId>:<planoNovoId>` —
  muda, porque agora precisa apontar para a intenção, não para o par
  assinatura/plano).
- **Controle de concorrência**: `mutation_version` da assinatura no
  momento da criação (para revalidar na aprovação — ver abaixo) e um
  campo de arrendamento curto (`aprovando_em`), só durante a janela ativa
  de aprovação→conclusão.
- **Consentimento**: `assinatura_id` já identifica quem aprovou (é o
  vínculo com o cartão salvo); **sem IP, sem User-Agent** — decisão
  explícita, ver "O que ficou de fora" abaixo.
- **Estado**: `status` (enum de 10 valores, abaixo), `criada_em`,
  `expira_em` (TTL 15 min), `aprovada_em`, `concluida_em`.

### A máquina de estados

```
PENDING_APPROVAL ──(token válido, aprovar)──> PROCESSING_PAYMENT
PENDING_APPROVAL ──(TTL ou virada de dia civil)──> EXPIRED
PENDING_APPROVAL ──(mutation_version não bate)──> STALE

PROCESSING_PAYMENT ──(cobrança confirmada)──> PAYMENT_CONFIRMED
PROCESSING_PAYMENT ──(cobrança recusada, definitivo)──> PAYMENT_DECLINED
PROCESSING_PAYMENT ──(status ambíguo/rede caiu)──> PAYMENT_UNKNOWN

PAYMENT_UNKNOWN ──(sweeper confirma)──> PAYMENT_CONFIRMED
PAYMENT_UNKNOWN ──(sweeper vê recusa)──> PAYMENT_DECLINED
PAYMENT_UNKNOWN ──(2-3 tentativas sem resolver)──> RECONCILIATION_REQUIRED

PAYMENT_CONFIRMED ──(PUT + releitura ok)──> APPLYING_PLAN ──> COMPLETED
PAYMENT_CONFIRMED ──(PUT não pegou)──> RECONCILIATION_REQUIRED
RECONCILIATION_REQUIRED ──(resolvido à mão/sweeper)──> APPLYING_PLAN | COMPLETED
```

`EXPIRED` e `STALE` só saem de `PENDING_APPROVAL` — nada foi cobrado
ainda, então são terminais sem custo. Todo estado a partir de
`PROCESSING_PAYMENT` já pode ter dinheiro em trânsito, e por isso nenhum
deles volta para `PENDING_APPROVAL`: uma segunda tentativa depois de
`PAYMENT_DECLINED` é uma intenção **nova**, criada por uma nova chamada
de `POST /trocar-plano`.

### O classificador financeiro canônico

Hoje existem **duas** fontes que classificam o mesmo dinheiro:
`STATUS_ACERTO_PAGO` (`asaasService.js`, caminho síncrono) e
`mapearStatusPayment` (`webhookController.js`, caminho assíncrono). Uma
terceira lista para este fluxo teria sido a mesma falha que a "referência
única" dos eventos de webhook (`CONSTRAINTS.md` §2.2) existe para evitar.

**A correção é uma só função no adaptador Asaas**, que os dois caminhos
chamam: recebe ou um `status` de resposta síncrona ou um `event` de
webhook, e devolve um de três vereditos —

- **`PAID`** — `status` em `CONFIRMED`/`RECEIVED`, ou evento
  `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`.
- **`DECLINED_FINAL`** — só a partir de sinal que a Asaas documenta como
  recusa **definitiva**: evento `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`
  ("Credit card payment failed.") ou
  `PAYMENT_REPROVED_BY_RISK_ANALYSIS`. **Nunca** a partir de status
  síncrono sozinho — ver a nota de medição abaixo.
- **`UNKNOWN`** — o default obrigatório. Qualquer `status`/`event` fora
  das duas listas acima cai aqui, **inclusive `PAYMENT_AUTHORIZED`**
  (que nunca deveria chegar: é o evento de captura manual com CVV, e
  este projeto não tem esse fluxo — `CONSTRAINTS.md` §1.1/§1.2 — mas se
  chegar por engano de configuração, tratar como recusa seria pior que
  tratar como ambíguo).

> ⚠️ **`nao-conferido`, contra a doc pública consultada em
> 21/09/2026 (`docs.asaas.com`, via busca assistida — não a leitura
> direta que este projeto normalmente faz): o enum de `status` de
> pagamento documentado (`PaymentGetResponsePaymentStatus`) NÃO tem
> nenhum valor tipo `REFUSED`/`DECLINED`.** Isso é compatível com o que
> já estava medido aqui (`cobrarNoCartaoSalvo`, 17/09: "cartão recusado
> também responde com status próprio" — mas o valor exato desse status
> síncrono nunca foi registrado por escrito). Duas leituras possíveis: a
> Asaas devolve algo como `PENDING` também para o caso recusado
> (captura acontece depois, de forma assíncrona, e só o webhook confirma
> o resultado final) — ou existe um valor fora do enum documentado.
> **Por isso o classificador nunca deriva `DECLINED_FINAL` do status
> síncrono sozinho** — é a leitura mais conservadora, e é consistente
> com o desenho de UNKNOWN-por-padrão. Fica como pendência de medição
> ao vivo (cartão de teste de recusa contra o sandbox, dentro do
> container) antes de relaxar esta regra — não bloqueia a construção,
> porque o desenho não depende de relaxá-la.

**Isto expõe e corrige um furo já existente** na rota de hoje: ela trata
"qualquer status que não seja `CONFIRMED`/`RECEIVED`" como recusa
definitiva (`402`) e libera o arrendamento na hora. Se a leitura acima
estiver certa — recusa síncrona não é distinguível de "ainda
processando" —, isso classificava ambiguidade como recusa. Com o
classificador novo, o caminho síncrono de aprovação vai para
`PAYMENT_UNKNOWN` (não `PAYMENT_DECLINED`) sempre que o status não for
`PAID` nem um evento de recusa definitiva já recebido — o sweeper (abaixo)
resolve a partir daí.

### O sweeper

`setInterval(..., 60_000).unref()` em `src/server.js`, no mesmo padrão de
`expurgarErros`/`rodarExpurgo` que já existe. **60 segundos**, não 24h:
é o intervalo mais curto do projeto, justificado por `PAYMENT_AUTHORIZED`
nunca chegar por webhook (§2.2) — sem um poll frequente, uma intenção em
`PAYMENT_UNKNOWN` ficaria presa até alguém olhar. Varre só
`PAYMENT_UNKNOWN` / `PAYMENT_CONFIRMED` (com `PUT` pendente) /
`APPLYING_PLAN` (com releitura pendente) / `RECONCILIATION_REQUIRED`.
Nunca cria cobrança nova — só `GET` de estado e avanço por CAS
(`mutation_version`). Depois de 2-3 tentativas automáticas sem resolver,
escalona para `RECONCILIATION_REQUIRED` (tabela `erros`, Lei 8, já
existe). Sem eleição de líder: `GET` duplicado entre instâncias é
tolerado, e todo efeito real passa por CAS.

### As três rotas do pagador

- **`POST /troca/contexto`** — token no corpo. Devolve o que a tela
  precisa mostrar (nomes dos planos, crédito, débito, valor do acerto,
  dias restantes) — nunca cartão, nunca documento, nunca chave de
  ninguém. Não muda estado.
- **`POST /troca/aprovar`** — token no corpo, idempotente, CAS-driven.
  Antes de cobrar, **revalida** o plano (repuxa da API do contratante),
  o estado da assinatura na Asaas e o `mutation_version` — qualquer
  divergência vira `STALE` (nunca recálculo silencioso). Respostas:
  `200` concluída, `202` em processamento (poll de novo), `402`
  `PLAN_CHANGE_DECLINED`, `409` `PLAN_CHANGE_STALE`, `410`
  `PLAN_CHANGE_EXPIRED`.
- Cada rota tem **instância própria** de limitador (`src/middlewares/
  limitadores.js`), como todas as outras — nunca uma instância
  compartilhada (`docs/erros/2026-09-10-rate-limit-balde-compartilhado.md`).

### O token

Opaco, ≥128 bits, **na URL como fragmento** (`/troca#t=<token>`) — nunca
query string, porque fragmento não viaja para o servidor em nenhum log
de acesso, proxy ou `Referer`. Lido uma vez por JS no carregamento,
`history.replaceState` remove o fragmento da barra de endereço
imediatamente, e o valor fica **só em memória** (variável de módulo) —
não em `sessionStorage`: este domínio já carrega o Web Analytics da
Cloudflare, terceiro não auditado quanto a acesso a storage
(`.ia/INTEGRATIONS.md`), e não em `localStorage`/cookie pelo mesmo
motivo, agravado por persistência entre sessões. As duas chamadas
(`/contexto`, `/aprovar`) levam o token no **corpo do POST**. Custo
aceito: recarregar a página perde o token — a tela mostra estado neutro
("link expirado, peça um novo") em vez de reconstituir.

### A tela

Estática, hospedada como as outras (`public/troca.html` + JS módulo,
sem SSR, sem template — este projeto não tem nenhum dos dois). Geometria
do cartão reservada do primeiro paint (~560–680px conforme viewport) —
nunca revelar conteúdo depois de um `await` que empurre layout (a mesma
lição do CLS de 0,409 na tela de assinatura, 17/09). Skeleton/CTA
ocupam o espaço final antes de os valores chegarem; nunca mostrar
"Aprovar" com valor placeholder. `noindex` nos dois caminhos
(`/troca` e `/troca.html`), verificado contra a resposta renderizada, não
só o redirect — repete a lição de `/admin`/`/status` (`CONSTRAINTS.md`
§2.6). Entra no conjunto monitorado de `npm run desempenho`, CLS ≤0,1
exigido (interno ≤0,05).

### O webhook

`PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` com `externalReference` no formato
`troca:<intentId>` resolve a intenção e chama a **mesma** rotina
idempotente de confirmação que o caminho síncrono de `/troca/aprovar`
chama — qual dos dois chega primeiro executa a transição real; o
segundo é no-op auditado. `chargeId` que não bate com o já confirmado é
anomalia (Lei 8), nunca uma segunda confirmação válida.

## O que ficou fora da v1, deliberadamente

- Outbox persistente para webhook ao contratante (defeito pré-existente,
  separado).
- SSR/renderização em edge — este projeto não tem, e não é o gatilho
  para introduzir.
- Sessão de verdade do pagador — o token da URL é o mecanismo inteiro.
- CVV / captura manual — seguiria exigindo receber CVV, que é o que a
  exceção registrada em `CONSTRAINTS.md` §3 e o veto §1.1/§1.2 evitam.
- Plataforma geral de fila/job — o sweeper é `setInterval`, como o resto
  do projeto.
- Eleição de líder / lock consultivo — desnecessário pelo desenho CAS.
- Estorno automático em falha irrecuperável — permanece `RECONCILIATION_
  REQUIRED` e reparo manual, como o resto do projeto já faz.
- Refatoração geral das outras rotas de mutação de assinatura — só
  `mutation_version` nasce aqui; cancelar/pausar/retomar adotam depois,
  incrementalmente, se fizer sentido.
- Novo sistema geral de auditoria — reaproveita `erros` (Lei 8).

## Decisões que este spec assume e que precisam ficar registradas

Nenhuma bloqueia a construção, mas nenhuma pode ser esquecida:

1. **Retenção da tabela de intenção** (proposto pelo GPT, não
   re-desafiado por esta sessão): `COMPLETED` (dinheiro moveu) → 5 anos,
   mesma régua de `cobrancas`; `PAYMENT_DECLINED` → 90 dias; `EXPIRED`/
   `STALE` nunca aprovada → 30 dias; `UNKNOWN`/`RECONCILIATION_REQUIRED`
   → retido até resolver, depois cai no bucket que o desfecho indicar.
   Entra na mesma migration `0011` e no inventário de dados —
   `docs/erros/2026-09-18-a-migration-que-acrescentou-coluna-not-null-
   nao-atualizou-a-lista-branca-do-expurgo.md` é a lição que torna isto
   não-opcional.
2. **Rollout por contratante**: dado que o MostrAí é o único integrador
   real hoje e o contrato de `POST /trocar-plano` muda (um `202` novo
   que ele precisa tratar), fica **sem** feature flag por contratante —
   o `202` é a única forma nova de resposta, o contrato antigo (200 nos
   dois casos sem redirect) continua idêntico, e um único integrador
   ativo não justifica a complexidade de uma coluna de capability
   dedicada. Se um segundo contratante existir antes de o MostrAí
   migrar, reabrir esta decisão.
3. **`CONSTRAINTS.md` §3** — a exceção "acerto cobrado sem reconfirmação
   de CVV" muda de justificativa: hoje ela diz "quem dispara é o
   contratante, o pagador não está no circuito"; passa a dizer "o
   pagador consente na nossa tela antes de qualquer cobrança, e é essa
   tela — não a ausência dele do circuito — que substitui o CVV".
4. **`API.md` §5.6 e `docs/funcional.md` RN-35/RN-36** — o contrato muda
   (nova resposta `202`, novas rotas do pagador); os dois documentos são
   reescritos na mesma entrega que o código, não depois.

## Métrica de sucesso desta mudança

Nenhuma troca com acerto ≥ R$ 5,00 cobra sem uma aprovação explícita
registrada (`aprovada_em` não nulo) na intenção correspondente — travado
por teste, não por convenção.
