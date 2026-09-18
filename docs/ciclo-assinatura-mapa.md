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
| `renovar=1` achava e amarrava a assinatura antiga usando `documento` **do body, não autenticado** — base do achado abaixo (T4) | **[CORRIGIDO]** — `renovar` agora precisa ser um token HMAC-SHA256 gerado pelo contratante com a própria `api_key` (`utils/tokenRenovacao.js`, `API.md §7.3`); sem token válido, degrada pra assinatura nova comum, sem amarrar nada |
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
| **Era aqui que o achado de T1 se concretizava**: `encerrarAssinaturaSubstituida` cancelava a assinatura antiga com base só no `documento` não autenticado que T1 amarrava — sem checar se quem pagou agora é o mesmo titular | **[CORRIGIDO]** — junto com T1, o mesmo fix (`assinaturaSubstituida` só existe com token válido, então `substitui_assinatura_id` nunca é gravado sem prova) |
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
| `status` da própria assinatura (`ativa`/`pausada`/`cancelada`) nunca era reconferido contra a Asaas — só `ultimaCobranca` era. Se cancelar/pausar/retomar perdesse a confirmação por timeout depois de a Asaas já ter processado, o banco local ficava desatualizado pra sempre, sem detecção | **[CORRIGIDO]** RN-26 — `consultarAssinaturaNaAsaas` trata os dois formatos que a doc não esclarece (`deleted: true` ou `404`), então não depende de adivinhar; `404` não vira `cancelada` automática |
| Cancelada e pausada respondem o MESMO `status: "INACTIVE"` — olhar o status antes do `deleted` marcaria toda cancelada como `pausada` | **[MEDIDO 16/09 e travado]** a ordem (`deleted` primeiro) é a correção inteira; autoteste de `cobrancaConsultaController.js`, verificado por sabotagem |
| `ciclo` gravado errado (`MONTHLY`) em toda assinatura criada antes de 15/09 ficaria errado pra sempre — a correção de origem só valeu pras novas | **[CORRIGIDO]** RN-26.1 — a conciliação lê `cycle` do `GET /v3/subscriptions/{id}` e repara o registro. Medido: `sub_qut6521d50496vkn` era `YEARLY` lá e `MONTHLY` aqui |
| `proximaCobranca` sempre `null` — nenhum payload de webhook traz `nextDueDate` | **[CORRIGIDO]** RN-26 — a fonte não era webhook: `nextDueDate` vem no `GET /v3/subscriptions/{id}`, que a conciliação agora lê |

## T11 — Assinatura encerrada FORA do nosso fluxo

Cancelada direto no painel da Asaas, ou encerrada por ela após falhas
seguidas de cobrança.

| Erro | Status |
|---|---|
| Grupo de eventos `SUBSCRIPTION_*` não é tratado nem marcado no painel — nunca chega por aviso | **[MEDIDO 16/09, ainda aberto]** — `GET /v3/webhooks` de dentro do container: **zero `SUBSCRIPTION_*` entre os 53 eventos configurados**. Não era ambiguidade: a Asaas de fato nunca nos avisa. **Mitigado por T10**: a conciliação detecta e corrige o estado real, então a divergência deixou de ser permanente — mas continua chegando por *pull*, com o atraso de quem concilia |

## T12 — Preço ou ciclo alterado direto na Asaas (etapa nova, 17/09)

Esta etapa é a alteração feita **fora do nosso fluxo**: pelo painel da
Asaas, ou por API direta. A troca de plano pedida pelo contratante ganhou
etapa própria (T13, mais abaixo) no fim de 17/09 — até então esta seção
dizia "não existe rota nossa", que era verdade naquela hora do dia. Medido no sandbox
em 17/09/2026, em assinatura de cartão e de boleto, com fixtures
descartáveis: `PUT /v3/subscriptions/{id}` aceita `value` para cima
(30 → 45) e para baixo (45 → 12), aceita `cycle` novo, e aceita as duas
coisas até em assinatura **pausada**. Recusa só abaixo do piso de
R$ 5,00 (`400 invalid_value`, com mensagem por meio de pagamento).

| Erro | Status |
|---|---|
| Alteração de `value` na Asaas não chega por evento nenhum, e a conciliação (T10) não reconferia `valor` — só `status`, `ciclo` e `proximaCobranca`. O registro local ficava errado para sempre | **[CORRIGIDO 18/09]** — RN-34, por decisão do dono. A conciliação reconfere `valor`, grava a correção e devolve `divergenciaDeValor: { nosso, asaas }` na mesma resposta: corrigir calado trocaria um número errado por uma mudança invisível. Comparação em centavos, senão ponto flutuante inventa divergência. Continua **sem aviso proativo** — o contratante descobre quando roda a conciliação |
| `cycle` novo **não move** `nextDueDate` — o ciclo novo conta a partir da data já marcada | **[MEDIDO 17/09]**, sem dano: é o comportamento do provedor, e está escrito no `API.md` §7.5 para o integrador não errar por onze meses |
| A cobrança pendente já gerada só muda com `updatePendingPayments: true` | **[MEDIDO 17/09]** nas duas formas: sem a bandeira fica no valor antigo, com ela muda mantendo id e vencimento |
| `value` **não está no schema documentado** do `PUT`, e funciona | **[DECLARADO 17/09]** — comportamento não documentado pode mudar sem aviso; quem construir precisa de teste que fique vermelho nesse dia |

**A armadilha que essa etapa revelou, e vale para toda a integração:** a
Asaas responde `200` e **ignora em silêncio** campo que não conhece
(controle negativo com um nome inventado: `200`, sem erro, nada mudou).
Status HTTP não prova alteração nesta API — quem prova é o `GET` de
volta.

## T13 — Troca de plano pedida pelo contratante (etapa nova, 17/09, fim do dia)

**Rota:** `POST /trocar-plano` (`API.md` §5.6). Autorizada pelo dono no
mesmo dia, com as sete regras do acerto decididas por ele. A ordem é a
regra inteira, e cada passo dela existe por um erro possível:

1. plano de destino **puxado da API do contratante** — valor e ciclo
   nunca vêm do corpo (`tests/valor-vem-do-servidor.js` é a mesma regra
   no pedido avulso);
2. recusa cedo o que a Asaas recusaria (piso de R$ 5,00, ciclo fora dos
   sete) e o que não dá para calcular (período não pago, dado
   incoerente);
3. **arrendamento** (`assinaturas.trocando_em`) antes de cobrar;
4. acerto **cobrado no cartão salvo**, e o plano só muda se confirmar;
5. `PUT` e **releitura** — status HTTP não prova alteração nesta API
   (a armadilha que T12 revelou, agora usada a favor);
6. o nosso banco escrito na mesma operação (nada vai contar depois:
   zero eventos `SUBSCRIPTION_*`, T11);
7. `evento: 'plano_trocado'` para o contratante. O assinante é avisado
   **por ele** — RN-35.

| Erro possível | Status |
|---|---|
| Alterar o plano antes de cobrar o acerto daria o plano caro de graça a quem tem cartão recusado | **[COBERTO]** ordem travada por autoteste, verificada por sabotagem (inverter a ordem reprova) |
| Duas chamadas simultâneas cobrariam o mesmo acerto duas vezes | **[COBERTO]** RN-36, arrendamento medido ao vivo dentro do contêiner (1ª ganha, 2ª não, expirado volta a poder) |
| O acerto carrega o mesmo `plano_id` e nasce depois do ciclo: sem filtro de método viraria a "última cobrança da assinatura" de T10, e `API.md` §5.3 manda ler `ultimaCobranca.valorCobrado` como o valor cobrado | **[COBERTO]** medido com as duas consultas lado a lado: sem o filtro vinha o acerto de R$ 30, com o filtro vem o ciclo de R$ 160 |
| O webhook `PAYMENT_CONFIRMED` do acerto chegaria ao receptor e, tratado como pedido avulso, anunciaria ao contratante a confirmação de um pedido com `pedidoId: null` | **[COBERTO]** método próprio (`acerto_troca`) e guarda explícita no receptor: grava o status, não notifica |
| O rebaixamento não gera cobrança nenhuma — trocaria o plano sem rastro no nosso banco | **[COBERTO]** `plano_anterior_id` e `trocado_em` (migration 0010) |
| `PUT` que a Asaas ignora em silêncio deixaria o nosso banco dizendo "trocou" | **[COBERTO]** releitura; se não pegou, `502`, nada gravado, erro registrado, e o `chargeId` do acerto vai na resposta para tratamento manual |
| Assinatura sem cartão salvo (Pix Automático) com acerto a cobrar | **[RECUSADO por desenho]** `409` — sem cartão não há como cobrar sem interação, e inventar um caminho aqui seria pior |
| Acerto estornado ou contestado DEPOIS da troca | **[DECLARADO]** a troca não é revertida. O status da cobrança do acerto é atualizado (o receptor grava), mas nada desfaz o plano — reverter sozinho tiraria o plano de quem já está usando. Decisão de operação, não de código |

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

1. **[MEDIDO, ainda aberto]** T11 — assinatura encerrada fora do nosso fluxo nunca chega até nós por webhook, e agora isso é fato medido, não suspeita: **zero eventos `SUBSCRIPTION_*` entre os 53 configurados** (`GET /v3/webhooks`, 16/09). **Mitigado em parte**: a conciliação (T10, RN-26) reconfere o estado real na Asaas, então a divergência deixa de ser permanente — mas continua dependendo de alguém chamar a rota, em vez de chegar sozinha por evento.
2. **[DECLARADO]** T-PixAuto — vínculo de `charge_id` e split, adiados até a liberação do Pix Automático na conta.
2b. **[CORRIGIDO 18/09]** T12 — `valor` passou a ser reconciliado contra a Asaas, com denúncia da divergência na mesma resposta (RN-34, decisão do dono). O que **continua aberto** é outra coisa, e menor: não há aviso PROATIVO — quem muda o preço no painel da Asaas não dispara nada, e o contratante só descobre na conciliação seguinte. Fechar isso dependeria de marcar `SUBSCRIPTION_*`/`PAYMENT_UPDATED` (§2.2), que é decisão de configuração do dono.
2c. **[DECLARADO 17/09]** T13 — acerto estornado depois da troca não reverte o plano. Nenhum dano ativo (a troca já aconteceu e o assinante está usando o plano novo); é decisão de operação.
3. **Falta confirmar ao vivo** (não muda comportamento): qual dos dois formatos a Asaas usa pra uma assinatura deletada — objeto com `deleted: true` ou `404`. O código trata os dois; medir só permitiria simplificar.

O achado grave de T1/T4 (renovação sem autenticação permitindo
cancelar a assinatura de outra pessoa) **foi corrigido** — `renovar`
agora exige um token HMAC assinado com a `api_key` do contratante
(`src/utils/tokenRenovacao.js`, `API.md §7.3`). **É uma mudança
incompatível**: qualquer integração usando `&renovar=1` (o formato
antigo) passa a criar uma assinatura nova comum, sem cancelar a antiga
— o MostrAí (e qualquer outro contratante usando renovação) precisa
adotar a nova fórmula de token antes de continuar mandando esses links.

Nada mais foi encontrado nesta passada — o ciclo inteiro, etapa por
etapa, código lido de novo do zero.

**Adendo de 17/09/2026, fim do dia:** o mapa ganhou **T13** (troca de
plano), e com ela o ciclo passou a ter **13 etapas mais a variante Pix
Automático**. T12 continua sendo o caso de fora do nosso fluxo.
