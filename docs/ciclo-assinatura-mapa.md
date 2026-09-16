# Mapa completo do ciclo de assinatura — e todo erro achado em cada etapa

Feito em 16/09/2026, a pedido do dono: mapear o ciclo inteiro primeiro,
depois catalogar TODO erro dentro de cada etapa (não só grave). Isto não
substitui `docs/funcional.md` (RN por RN) nem `docs/pendencias.md`
(lista de trabalho) — é a view ORGANIZADA POR ETAPA DO CICLO, pra ver de
uma vez o que cada estágio já passou e o que ainda falta.

Convenção: **[CORRIGIDO]** já está no código, testado. **[DECLARADO]**
é pendência conhecida, não corrigida às cegas — exige medir algo antes.
**[GRAVE, ABERTO]** precisa de decisão do dono antes de eu tocar.

---

## Atores

| Ator | O que controla |
|---|---|
| **Assinante** (quem paga) | Digita os dados no formulário do checkout — nada disso é autenticado |
| **Projeto contratante** | `GET /plano/{id}`, `webhook_url`, decide quando mandar o link de renovação |
| **San Checkout** (este projeto) | Tudo em `src/` |
| **Asaas** | Processa o cartão, manda webhook `PAYMENT_*`/`CHECKOUT_*` |

## Estados

- **Cobrança/sessão** (`cobrancas.status`): `pendente` → `confirmado` | `cancelado` | `expirado` | `recusado` | `em_analise` | `estornado` | `estorno_solicitado` | `estorno_negado` | `chargeback` | `vencido`
- **Assinatura** (`assinaturas.status`): `ativa` | `pausada` | `cancelada`

---

## T1 — Criação da sessão (link `?assinatura=...`, pop-up abre)

**Rota:** `POST /api/checkout/assinatura/:contratanteId/:planoId` — **pública, sem `X-Checkout-Key`**, por desenho (é o pop-up quem chama).
**Código:** `asaasCheckoutController.criarCheckoutAssinatura` (linha 200-333).

Valida CPF/telefone/endereço/plano, monta a sessão `RECURRENT` na Asaas,
grava a cobrança (`registrarCobrancaPendentePopup`) já com `ciclo`
fixado e, se `renovar: true` no body, com `substitui_assinatura_id`
apontando pra uma assinatura achada só por `contratanteId+planoId+documento`.

| Erro | Status |
|---|---|
| `renovar=1` acha e amarra a assinatura antiga usando `documento` **do body, não autenticado** — base do achado abaixo (T4) | **[GRAVE, ABERTO]** — achado 16/09, rodada 3 |
| `limitadorCriacao` era uma única instância de `rateLimit()` compartilhada entre esta e mais 6 rotas (assinatura-pix, estornar, cancelar/pausar/retomar-assinatura, e reaproveitada também em pix/boleto) — um IP consumia o mesmo balde em todas | **[CORRIGIDO]** `73294d2` — virou fábrica (`criarLimitadorCriacao`) |
| Header do front (`assinaturaCheckoutHandler.js`) dizia "endpoint não existe" — não era verdade, endpoint funciona | **[CORRIGIDO]** |

## T2 — Pop-up fechada sem pagar

**Eventos:** `CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED`.
**Código:** `webhookController.processarEventoCheckout`, ramos `CHECKOUT_EXPIRED`/`CHECKOUT_CANCELED` (linha 850-874).

`expirado`/`cancelado` grava no banco. `CHECKOUT_CANCELED` notifica
`evento: cancelada` **só se NÃO for renovação** (`substitui_assinatura_id`
ausente) — senão a assinatura antiga continua intocada e nada é
notificado.

| Erro | Status |
|---|---|
| Até 15/09, mandava `cancelada` mesmo numa renovação abandonada — mentia pro contratante que o assinante cancelou | **[CORRIGIDO]** RN-20 |
| Comentário citava `INTEGRACAO.md seção 4/6.1`, desatualizado | **[CORRIGIDO]** agora, aponta pro `API.md §4.3.5` |
| Se a pop-up nem abre (bloqueador), o botão travava pra sempre sem erro — front nunca chega a este estágio | **[CORRIGIDO]** RN-24 |

## T3 — Pop-up paga, primeira vez (`CHECKOUT_PAID`)

**Código:** `processarEventoCheckout`, ramo `CHECKOUT_PAID` (linha 795-848).

Marca `confirmado`. **`payment` nunca vem** neste evento (medido); o
vínculo de verdade só acontece em T4. Notifica `evento: criada` sempre
(a exceção de "sem `chargeId` não notifica", linha 833, não vale pra
assinatura — ela sempre notifica `criada` aqui).

| Erro | Status |
|---|---|
| Cabeçalho do arquivo dizia que `payment.id` vinha "dentro de `checkout.payment` ou solto em `payment`" — nunca vem em nenhum dos dois | **[CORRIGIDO]** RN-17, sessão anterior |
| **Verificado nesta rodada e descartado como bug:** se `CHECKOUT_PAID` for entregue duas vezes (retry), `criada` seria notificado duas vezes — mas como `criada` só acontece UMA vez na vida da assinatura, a dedup documentada (`planoId+documento+evento`, §4.3.6) já filtra a repetição do lado do contratante. Diferente do caso de T5 (evento se repete todo ciclo, dedup não filtra) | Não é bug — confirmado por raciocínio, não corrigido porque não precisa |

## T4 — `PAYMENT_CONFIRMED` da primeira cobrança

**Código:** `processarEventoPayment` → `vincularPrimeiraCobrancaDoCheckout` → `amarrarAssinaturaACobranca` (linha 618-733).

Vincula `charge_id`/`asaas_subscription_id`, cria a linha em
`assinaturas` (nasce `ativa`), grava `ciclo` (da própria cobrança, não
do webhook). **Se for renovação, é AQUI que `encerrarAssinaturaSubstituida`
cancela a assinatura antiga na Asaas** — depois do pagamento novo
confirmar, nunca antes.

| Erro | Status |
|---|---|
| Vínculo dependia de `payment.checkoutSession`, não confirmado até 15/09 | **[CORRIGIDO]** RN-17 |
| `ciclo` vinha de `payment.cycle`, que não existe — caía no default `MONTHLY` | **[CORRIGIDO]**, sessão anterior |
| **É AQUI que o achado de T1 se concretiza**: `encerrarAssinaturaSubstituida` cancela a assinatura antiga com base só no `documento` não autenticado que T1 amarrou — sem checar se quem pagou agora é o mesmo titular | **[GRAVE, ABERTO]** — mesmo achado de T1, consequência final |
| Duas entregas concorrentes deste evento (retry) rodam `amarrarAssinaturaACobranca` duas vezes — `upsertAssinatura` é upsert (seguro) e `encerrarAssinaturaSubstituida` chama `DELETE` duas vezes na Asaas, capturado por try/catch (sem dano, só log de erro espúrio) | Verificado, sem correção necessária — upsert já é seguro por natureza |

## T5 — Ciclos seguintes (2º mês em diante)

**Código:** `processarEventoPayment` → `registrarNovoCicloAssinatura` (linha 742-781).

`charge_id` chega pronto (a Asaas cobra sozinha); usa a cobrança mais
recente da assinatura como "molde".

| Erro | Status |
|---|---|
| `ciclo` não era copiado do molde — se perdia a partir do 3º ciclo | **[CORRIGIDO]**, sessão anterior |
| **Condição de corrida real**: duas entregas do mesmo `PAYMENT_CONFIRMED` (retry) liam a cobrança como inexistente antes de qualquer uma inserir — as duas inseriam, o `unique` de `charge_id` barrava a 2ª, mas nada sinalizava isso, e a perdedora notificava `cobranca_confirmada` de novo pro MESMO ciclo (sem `chargeId` no payload pra o contratante perceber) | **[CORRIGIDO]** RN-23, rodada 2 |

## T6 — Ciclo falha

**Eventos:** `PAYMENT_OVERDUE`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`.
**Efeito:** notifica `cobranca_falhou`. O contratante decide mandar o
link `&renovar=1` pro assinante.

| Erro | Status |
|---|---|
| Nenhum achado nesta etapa em si | — |
| **É o gatilho do fluxo vulnerável** (T1/T4): o link que o contratante manda não carrega nada que prove quem deveria usá-lo | Ver T1 |

## T7 — Estorno de um ciclo

**Rota:** `POST /estornar` (autenticada). **Eventos:** `PAYMENT_REFUNDED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`.

| Erro | Status |
|---|---|
| Nenhum achado específico de assinatura nesta etapa | — |
| Ver T10 — sem o fix de lá, um estorno numa cobrança de renovação ficava escondido atrás do ciclo antigo na conciliação | Coberto por T10 |

## T8 — Pausar / Retomar

**Rotas:** `/pausar-assinatura`, `/retomar-assinatura`.

| Erro | Status |
|---|---|
| Nenhum bug de busca aqui — sempre aceitaram `ativa`+`pausada` corretamente (o bug de estado estava só em cancelar, T9) | — |
| Rate limit compartilhado com outras 6 rotas | **[CORRIGIDO]** `73294d2` |

## T9 — Cancelar

**Rota:** `POST /cancelar-assinatura`.

| Erro | Status |
|---|---|
| Buscava só `ativa` — assinatura `pausada` ficava incancelável | **[CORRIGIDO]** RN-19, sessão anterior |
| Nunca notificava o contratante — só resposta síncrona, quebrando a seta do `API.md` §7.4 | **[CORRIGIDO]** RN-21, hoje |
| `API.md` prometia `jaEstava` também pro cancelar — não existe, cancelar-de-novo é `404` | **[CORRIGIDO na doc]** §5.5 |

## T10 — Conciliação (`POST /consultar-assinatura`)

| Erro | Status |
|---|---|
| `ultimaCobranca` confundia tentativa de renovação abandonada (`cancelado`/`expirado`) com o ciclo real, mais recente | **[CORRIGIDO]** RN-22, rodada 1 |
| Correção acima, na 1ª versão, também escondia uma renovação que confirmou e **depois foi estornada** (exigia `status='confirmado'` exato) | **[CORRIGIDO]** RN-22 revisado, rodada 2 |
| `status` da própria assinatura (`ativa`/`pausada`/`cancelada`) nunca é reconferido contra a Asaas — só `ultimaCobranca` é. Se cancelar/pausar/retomar perder a confirmação por timeout depois de a Asaas já ter processado, o banco local fica desatualizado pra sempre, sem detecção | **[DECLARADO]** — exige medir o formato real de `GET /v3/subscriptions/{id}` antes de codificar |

## T11 — Assinatura encerrada FORA do nosso fluxo

Cancelada direto no painel da Asaas, ou encerrada por ela após falhas
seguidas de cobrança.

| Erro | Status |
|---|---|
| Grupo de eventos `SUBSCRIPTION_*` não é tratado nem marcado no painel — nunca chega até nós; `consultar-assinatura` continua dizendo `ativa` pra sempre | **[DECLARADO]** — exige medir quais eventos a Asaas oferece antes de tratar |

## T-PixAuto — variante sem cartão (Pix Automático)

Caminho paralelo — mesmo vocabulário de webhook, sem pop-up, sem
endereço, **sem `renovar`** (a feature de renovação não existe aqui, então
não tem o furo de T1).

| Erro | Status |
|---|---|
| `ciclo` não era gravado — reintroduzia o bug de T5 por outra porta | **[CORRIGIDO]**, rodada 1 |
| `charge_id`/`asaas_subscription_id` nunca gravados na cobrança | **[DECLARADO]** — sem dano hoje, Pix Automático desligado nesta conta |
| Split (`wallet_id`) não é aplicado nesta rota, diferente das outras duas | **[DECLARADO]**, pré-existente |

## Documentação (transversal, achado nesta rodada)

| Erro | Status |
|---|---|
| Comentário de `mapearEventoAssinatura` ficou órfão, colado em `encerrarAssinaturaSubstituida` (função errada) — provável resto de reorganização de código | **[CORRIGIDO]** |
| 3 citações a `INTEGRACAO.md` desatualizadas no mesmo arquivo (a 4ª já batia certo, deixada como está) | **[CORRIGIDO]** |

---

## O que ainda está aberto, resumido

1. **[GRAVE, ABERTO]** T1/T4 — renovação sem autenticação permite cancelar a assinatura de outra pessoa. Precisa de decisão de desenho (token de uso único ou equivalente) antes de eu tocar no código.
2. **[DECLARADO]** T10 — sem reconciliação de `status` da assinatura contra a Asaas quando uma chamada nossa perde a confirmação.
3. **[DECLARADO]** T11 — assinatura encerrada fora do nosso fluxo nunca chega até nós.
4. **[DECLARADO]** T-PixAuto — vínculo de `charge_id` e split, adiados até a liberação do Pix Automático na conta.

Nada mais foi encontrado nesta passada — o ciclo inteiro, etapa por
etapa, código lido de novo do zero.
