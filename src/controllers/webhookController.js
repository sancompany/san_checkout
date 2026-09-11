/**
 * SAN CHECKOUT v2 — src/controllers/webhookController.js
 * Recebe webhooks da Asaas e repassa a confirmação pro webhook_url do
 * contratante. Dois vocabulários de evento diferentes chegam no MESMO
 * endpoint — precisam de tratamento separado:
 *
 *   1. PAYMENT_* — Pix e Boleto cobrados direto, E TAMBÉM cada ciclo
 *      recorrente de Assinatura a partir do 2º mês (a 1ª cobrança de
 *      uma assinatura chega como CHECKOUT_PAID, item 2 abaixo; os
 *      ciclos seguintes são cobrança avulsa de verdade, identificados
 *      só pelo campo `payment.subscription`, sem passar pela pop-up
 *      de novo). Identifica pelo `payment.id`.
 *   2. CHECKOUT_* — Cartão/Assinatura via pop-up (Boleto NÃO usa mais
 *      Asaas Checkout — confirmado que ele só aceita CREDIT_CARD/PIX,
 *      ver `checkoutController.js`). Identifica pelo `checkout.id`
 *      (nosso `asaas_checkout_id`) — o `charge_id` de verdade só existe
 *      DEPOIS que `CHECKOUT_PAID` chega.
 *
 * Nota fiscal e e-mail de confirmação NÃO são mais responsabilidade
 * daqui — cada contratante recebe todo evento de mudança de status
 * (confirmado/estornado/vencido) no próprio `webhook_url` e decide o
 * que fazer do lado dele (ver `montarPayloadConfirmacaoPedido`).
 *
 * ⚠️ NUNCA TESTADO AO VIVO nesta v2. O formato do payload de PAYMENT_*
 * já foi confirmado numa versão anterior deste projeto. O formato
 * exato de CHECKOUT_* (onde exatamente vem o `payment.id` criado —
 * dentro de `checkout.payment` ou solto em `payment`?) NÃO foi
 * confirmado — o código abaixo tenta os dois caminhos, e o
 * console.log existe de propósito pra você ver o payload real assim
 * que o primeiro webhook de teste chegar e corrigir se precisar.
 *
 * ⚠️ NOMES DE EVENTO NOVOS NESTA RODADA (07/09) — pesquisados na doc
 * oficial da Asaas, mas SEM confirmação em sandbox ainda (esta v2
 * nunca recebeu um webhook de verdade): PAYMENT_REFUND_IN_PROGRESS,
 * PAYMENT_REFUND_DENIED, PAYMENT_PARTIALLY_REFUNDED, PAYMENT_OVERDUE,
 * e o campo `payment.subscription`. Se algum vier com nome diferente,
 * o pior caso é o evento cair no "não mapeado" e ser ignorado
 * silenciosamente — nada quebra, só não atualiza o status. Conferir
 * contra o console.log assim que o primeiro evento de cada tipo
 * chegar de verdade.
 */

import {
  buscarCobranca,
  atualizarStatusCobranca,
  buscarCobrancaPorCheckoutId,
  vincularChargeIdAoCheckout,
  atualizarStatusPorCheckoutId,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta
} from '../services/cobrancaService.js';
import { upsertAssinatura, atualizarStatusAssinatura } from '../services/assinaturaService.js';
import { cancelarAssinatura as cancelarAssinaturaNaAsaas } from '../services/asaasService.js';
import { compararSeguro } from '../utils/validadores.js';
import { assinarPayload } from '../utils/assinaturaWebhook.js';

/**
 * Aplicado em webhookRoutes.js antes de receberWebhookAsaas. A Asaas
 * reenvia, em cada webhook, o "Token de acesso" configurado no painel
 * dela (Integrações → Webhooks) no header abaixo — sem isso, qualquer
 * um que descobrisse a URL podia forjar CHECKOUT_PAID/PAYMENT_CONFIRMED
 * e liberar pedido sem pagar. Fail-closed: sem env configurada, recusa
 * tudo (mesmo padrão do verificarAdminKey em adminController.js).
 * ⚠️ Nome do header confirmado na doc oficial da Asaas; conferir contra
 * o primeiro webhook real assim que o token for configurado no painel.
 */
export function verificarWebhookAsaas(requisicao, resposta, proximo) {
  const { ASAAS_WEBHOOK_TOKEN } = process.env;
  if (!ASAAS_WEBHOOK_TOKEN) {
    return resposta.status(503).json({ erro: 'ASAAS_WEBHOOK_TOKEN não configurado no .env — webhook desativado.' });
  }
  if (!compararSeguro(requisicao.get('asaas-access-token'), ASAAS_WEBHOOK_TOKEN)) {
    return resposta.status(401).json({ erro: 'Token de webhook inválido.' });
  }
  proximo();
}

const EVENTOS_PAYMENT_CONFIRMACAO = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
const EVENTOS_PAYMENT_ESTORNO = ['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED'];
const EVENTOS_PAYMENT_ESTORNO_PROGRESSO = ['PAYMENT_REFUND_IN_PROGRESS'];
const EVENTOS_PAYMENT_ESTORNO_NEGADO = ['PAYMENT_REFUND_DENIED'];
const EVENTOS_PAYMENT_VENCIDO = ['PAYMENT_OVERDUE'];

/**
 * Pagamento parado na análise antifraude da Asaas — nem aprovado nem
 * recusado. O contratante precisa saber pra NÃO liberar o pedido
 * ainda, e pra não tratar como falha também.
 */
const EVENTOS_PAYMENT_EM_ANALISE = ['PAYMENT_AWAITING_RISK_ANALYSIS'];

/**
 * Recusa definitiva: antifraude reprovou, ou a captura do cartão
 * falhou. Antes esses eventos caíam no "não mapeado" e o pedido ficava
 * eternamente pendente do lado do contratante, sem ninguém saber por
 * quê.
 */
const EVENTOS_PAYMENT_RECUSADO = [
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'
];

/**
 * O portador contestou a compra no banco. É dinheiro saindo, e o
 * contratante costuma precisar suspender a entrega na hora — por isso
 * é repassado, mesmo que a disputa em si seja tratada fora do checkout.
 */
const EVENTOS_PAYMENT_CHARGEBACK = [
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'
];

/** Baixa manual desfeita na Asaas — o que estava pago voltou a pendente. */
const EVENTOS_PAYMENT_PENDENTE_DE_NOVO = ['PAYMENT_RECEIVED_IN_CASH_UNDONE'];

const EVENTOS_PAYMENT_TRATADOS = [
  ...EVENTOS_PAYMENT_CONFIRMACAO,
  ...EVENTOS_PAYMENT_ESTORNO,
  ...EVENTOS_PAYMENT_ESTORNO_PROGRESSO,
  ...EVENTOS_PAYMENT_ESTORNO_NEGADO,
  ...EVENTOS_PAYMENT_VENCIDO,
  ...EVENTOS_PAYMENT_EM_ANALISE,
  ...EVENTOS_PAYMENT_RECUSADO,
  ...EVENTOS_PAYMENT_CHARGEBACK,
  ...EVENTOS_PAYMENT_PENDENTE_DE_NOVO
];

/**
 * Versão do contrato do webhook (INTEGRACAO.md seção 4.4). Vai em todo
 * payload pra que o contratante possa ramificar se um dia existir uma
 * v2 — a regra é só ADICIONAR campo, nunca remover nem renomear, então
 * este número deve mudar raramente ou nunca.
 */
const VERSAO_WEBHOOK = 1;

/** Os dois jeitos de assinar. Ambos falam o vocabulário de assinatura
 *  no webhook do contratante, não o de pedido avulso. */
const METODOS_DE_ASSINATURA = ['assinatura', 'assinatura_pix'];

export async function receberWebhookAsaas(requisicao, resposta) {
  console.log('[webhook/asaas] payload recebido:', JSON.stringify(requisicao.body, null, 2));

  try {
    const corpo = requisicao.body;
    const evento = corpo?.event;

    if (evento?.startsWith('CHECKOUT_')) {
      await processarEventoCheckout(corpo);
    } else if (EVENTOS_PAYMENT_TRATADOS.includes(evento)) {
      await processarEventoPayment(corpo);
    } else if (evento?.startsWith('ACCOUNT_STATUS_')) {
      await processarEventoSubconta(corpo);
    } else if (evento?.startsWith('ACCESS_TOKEN_')) {
      registrarAlertaChaveApi(corpo);
    } else if (evento?.startsWith('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_')) {
      await processarAutorizacaoPixAutomatico(corpo);
    }
    // outros eventos (ex.: PAYMENT_CREATED, CHECKOUT_CREATED, INVOICE_*)
    // chegam aqui mas não fazem nada — nota fiscal é responsabilidade
    // de cada contratante, não do San Checkout.
  } catch (erro) {
    console.error('[webhook/asaas] erro ao processar:', erro.message);
  }

  // sempre 200 — a Asaas para de reenviar se receber erro repetido
  resposta.status(200).json({ recebido: true });
}

/** Traduz o nome do evento Asaas pro nosso status local — devolve
 *  `null` pra evento que chegou até aqui mas não deveria mudar status
 *  (não deve acontecer, já que a rota acima já filtra, mas evita
 *  gravar um status incorreto se um evento novo entrar na lista de
 *  tratados sem entrar aqui também). */
function mapearStatusPayment(evento) {
  if (EVENTOS_PAYMENT_CONFIRMACAO.includes(evento)) return 'confirmado';
  if (EVENTOS_PAYMENT_ESTORNO.includes(evento)) return 'estornado';
  if (EVENTOS_PAYMENT_ESTORNO_PROGRESSO.includes(evento)) return 'estorno_solicitado';
  if (EVENTOS_PAYMENT_ESTORNO_NEGADO.includes(evento)) return 'estorno_negado';
  if (EVENTOS_PAYMENT_VENCIDO.includes(evento)) return 'vencido';
  if (EVENTOS_PAYMENT_EM_ANALISE.includes(evento)) return 'em_analise';
  if (EVENTOS_PAYMENT_RECUSADO.includes(evento)) return 'recusado';
  if (EVENTOS_PAYMENT_CHARGEBACK.includes(evento)) return 'chargeback';
  if (EVENTOS_PAYMENT_PENDENTE_DE_NOVO.includes(evento)) return 'pendente';
  return null;
}

/** Só usado pra notificação de Assinatura — traduz o status local pro
 *  vocabulário já documentado no INTEGRACAO.md seção 6.1
 *  (criada/cobranca_confirmada/cobranca_falhou/cancelada). */
/**
 * Fecha a assinatura antiga depois que a renovação foi paga.
 *
 * Ordem importa: cancelar primeiro e cobrar depois deixaria o assinante
 * sem nada se o pagamento falhasse. Aqui a antiga só cai com a nova já
 * confirmada — no pior caso ele fica com duas por alguns segundos, o
 * que é recuperável; ficar com zero não é.
 *
 * Falha ao cancelar não derruba a confirmação: o dinheiro da nova já
 * entrou, e uma assinatura velha sobrando é problema menor (e visível
 * no painel da Asaas) do que devolver erro pra quem acabou de pagar.
 */
async function encerrarAssinaturaSubstituida(cobranca, novaAssinaturaId) {
  const antigaId = cobranca.substitui_assinatura_id;
  if (!antigaId || antigaId === novaAssinaturaId) return;

  try {
    await cancelarAssinaturaNaAsaas(antigaId);
    await atualizarStatusAssinatura(antigaId, 'cancelada');
    console.log(`[assinatura/renovacao] ${antigaId} encerrada; substituída por ${novaAssinaturaId}`);
  } catch (erro) {
    console.error(
      `[assinatura/renovacao] a nova assinatura ${novaAssinaturaId} foi paga, mas NÃO consegui cancelar a antiga ` +
      `${antigaId}: ${erro.message}. Cancele na mão no painel da Asaas pra não cobrar duas vezes.`
    );
  }
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 3 — eventos de CONTA (subcontas e chave de API)
------------------------------------------------------------------ */

/**
 * Alertas de chave de API vivos neste processo, expostos em
 * `/api/saude`. A Asaas EXPIRA chave por inatividade: sem escutar isso,
 * a integração morre sozinha um dia e ninguém sabe por quê. Guardar em
 * memória basta — o boot limpa, e a Asaas reavisa antes de expirar.
 *
 * ponytail: sem tabela nem serviço de alerta; um array e um campo no
 * health check que o cron-job.org já consulta a cada poucos dias.
 */
const alertasChaveApi = [];

export function obterAlertasChaveApi() {
  return alertasChaveApi;
}

function registrarAlertaChaveApi(corpo) {
  const evento = corpo?.event;
  // CREATED/ENABLED são rotina; só o que ameaça a integração vira alerta.
  if (!['ACCESS_TOKEN_EXPIRING_SOON', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_DISABLED', 'ACCESS_TOKEN_DELETED'].includes(evento)) {
    return;
  }

  const alerta = { evento, em: new Date().toISOString() };
  alertasChaveApi.push(alerta);
  console.error(
    `[ALERTA/chave-asaas] ${evento} — a chave de API da Asaas está para expirar ou foi desativada. ` +
    'Gere uma nova no painel da Asaas e atualize ASAAS_API_KEY no Render ANTES que ela caia, ' +
    'senão toda cobrança para de funcionar sem aviso.'
  );
}

/**
 * Autorização de Pix Automático mudou de estado.
 *
 * A autorização é criada como CREATED e só vira ACTIVE quando o pagador
 * lê o QR e paga a primeira cobrança no app do banco — é nesse momento
 * que a assinatura por Pix existe de verdade. Antes disso, nada foi
 * cobrado e nada foi autorizado.
 *
 * Guardamos a autorização em `cobrancas.asaas_checkout_id` (ela faz o
 * papel da sessão de pop-up no fluxo de cartão), então é por ali que a
 * cobrança é localizada.
 *
 * ⚠️ NUNCA TESTADO — depende de a Asaas habilitar Pix Automático na
 * conta. O console.log existe pra você ver o payload real do primeiro
 * evento e corrigir se o campo do id vier com outro nome.
 */
async function processarAutorizacaoPixAutomatico(corpo) {
  const evento = corpo?.event;
  // Não confirmado byte a byte: tenta os caminhos plausíveis do id.
  const autorizacaoId = corpo?.authorization?.id ?? corpo?.pixRecurringAuthorization?.id ?? corpo?.id;
  if (!autorizacaoId) return;

  const cobranca = await buscarCobrancaPorCheckoutId(autorizacaoId);
  if (!cobranca) return;

  const ATIVOU = 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED';
  const ENCERROU = [
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED',
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED',
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED'
  ];

  if (evento === ATIVOU) {
    await atualizarStatusPorCheckoutId(autorizacaoId, 'confirmado');
    await upsertAssinatura({
      id: autorizacaoId,
      contratanteId: cobranca.contratante_id,
      planoId: cobranca.plano_id,
      documento: cobranca.documento,
      valor: cobranca.valor_cobrado,
      ciclo: corpo?.authorization?.frequency ?? null,
      proximaCobranca: null
    });
    return notificarConformeMetodo(cobranca, { confirmado: true, eventoAssinatura: 'criada' });
  }

  if (ENCERROU.includes(evento)) {
    await atualizarStatusPorCheckoutId(autorizacaoId, 'cancelado');
    return notificarConformeMetodo(cobranca, { confirmado: false, eventoAssinatura: 'cancelada' });
  }
}

/**
 * Aprovação de subconta. Antes disso, criar subconta via API deixava o
 * operador conferindo na mão se a Asaas já tinha liberado. O
 * `account.id` do payload é o nosso `subcontas.asaas_account_id`.
 *
 * Formato confirmado na doc oficial ("Webhook para verificar situação
 * da conta"): { event, account: { id }, accountStatus: { general,
 * commercialInfo, bankAccountInfo, documentation } }.
 */
async function processarEventoSubconta(corpo) {
  const asaasAccountId = corpo?.account?.id;
  if (!asaasAccountId) return;

  const situacao = corpo?.accountStatus ?? {};
  await atualizarSituacaoSubconta(asaasAccountId, {
    geral: situacao.general ?? null,
    comercial: situacao.commercialInfo ?? null,
    bancaria: situacao.bankAccountInfo ?? null,
    documentos: situacao.documentation ?? null
  });
}

function mapearEventoAssinatura(status) {
  if (status === 'confirmado') return 'cobranca_confirmada';
  // Recusa de cartão num ciclo é, pro assinante, a mesma coisa que a
  // cobrança não ter entrado — mesmo evento do vencimento.
  if (status === 'vencido' || status === 'recusado') return 'cobranca_falhou';
  if (status === 'estornado' || status === 'estorno_solicitado') return 'cobranca_estornada';
  if (status === 'chargeback') return 'cobranca_contestada';
  // 'em_analise' e 'pendente' são estados de passagem — não viram
  // evento de assinatura pra não gerar ruído no contratante.
  return null;
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 1 — Pix/Boleto direto (payment.id = nosso charge_id) E
   ciclos de Assinatura a partir do 2º mês (payment.subscription).
------------------------------------------------------------------ */
async function processarEventoPayment(corpo) {
  const evento = corpo?.event;
  const payment = corpo?.payment;
  const chargeId = payment?.id;
  if (!chargeId) return;

  const novoStatus = mapearStatusPayment(evento);
  if (!novoStatus) return;

  let cobranca = await buscarCobranca(chargeId);

  if (!cobranca) {
    // Charge_id desconhecido: só vale a pena investigar se for um
    // ciclo novo de assinatura (a Asaas manda o id da assinatura de
    // origem no campo `subscription`) — qualquer outra cobrança
    // avulsa desconhecida não é nossa, ignora.
    if (!payment?.subscription) return;
    cobranca = await registrarNovoCicloAssinatura(payment);
    if (!cobranca) return;
  }

  if (cobranca.status === novoStatus) return; // já processado — evita duplicar notificação/e-mail

  await atualizarStatusCobranca(chargeId, novoStatus);

  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    return notificarConformeMetodo(cobranca, {
      confirmado: novoStatus === 'confirmado',
      chargeId,
      eventoAssinatura: mapearEventoAssinatura(novoStatus)
    });
  }

  // Pix/Boleto avulso — repassa TODA mudança de status (confirmado,
  // estornado, vencido...) pro contratante, que decide do lado dele o
  // que fazer (nota fiscal, e-mail ao cliente, lembrete de vencimento
  // etc.) — não é mais responsabilidade do San Checkout.
  const webhookUrlDoContratante = cobranca.contratantes?.webhook_url;
  if (webhookUrlDoContratante) {
    await notificarContratante(
      webhookUrlDoContratante,
      montarPayloadConfirmacaoPedido(cobranca, chargeId, novoStatus),
      cobranca.contratantes?.api_key
    );
  }
}

/**
 * Ciclo novo de assinatura (2º mês em diante): a Asaas cobra sozinha e
 * o `charge_id` chega pronto no payload — não existe registro local
 * ainda porque só a 1ª cobrança passa pela pop-up/CHECKOUT_PAID. Usa a
 * cobrança mais recente daquela assinatura como "molde" (contratante,
 * plano, CPF, telefone, endereço) pra montar o registro do ciclo novo.
 */
async function registrarNovoCicloAssinatura(payment) {
  const subscriptionId = payment.subscription;
  const modelo = await buscarCobrancaPorSubscriptionId(subscriptionId);
  if (!modelo) {
    console.error(`[webhook/assinatura] ciclo novo da subscription ${subscriptionId} sem cobrança-modelo local — ignorando (nunca vimos a 1ª cobrança dela?).`);
    return null;
  }

  await registrarCicloAssinatura({
    chargeId: payment.id,
    asaasSubscriptionId: subscriptionId,
    contratanteId: modelo.contratante_id,
    planoId: modelo.plano_id,
    documento: modelo.documento,
    email: modelo.email,
    telefone: modelo.telefone,
    endereco: modelo.endereco,
    enderecoNumero: modelo.endereco_numero,
    complemento: modelo.endereco_complemento,
    bairro: modelo.bairro,
    cep: modelo.cep,
    cidade: modelo.cidade,
    uf: modelo.uf,
    cidadeIbge: modelo.cidade_ibge,
    valorCheio: payment.value ?? modelo.valor_cheio,
    valorComDesconto: payment.value ?? modelo.valor_com_desconto,
    valorCobrado: payment.value ?? modelo.valor_cobrado
  });

  return buscarCobranca(payment.id);
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 2 — Cartão/Boleto/Assinatura via pop-up
   (checkout.id = nosso asaas_checkout_id)
------------------------------------------------------------------ */
async function processarEventoCheckout(corpo) {
  const evento = corpo?.event;
  const asaasCheckoutId = corpo?.checkout?.id ?? corpo?.id;
  if (!asaasCheckoutId) return;

  const cobranca = await buscarCobrancaPorCheckoutId(asaasCheckoutId);
  if (!cobranca) return;

  if (evento === 'CHECKOUT_PAID') {
    // o payment recém-criado pode vir em dois lugares, dependendo de
    // como a Asaas realmente estrutura isso — tenta os dois.
    const payment = corpo?.checkout?.payment ?? corpo?.payment ?? null;
    const chargeId = payment?.id ?? null;
    if (chargeId) await vincularChargeIdAoCheckout(asaasCheckoutId, chargeId);
    await atualizarStatusPorCheckoutId(asaasCheckoutId, 'confirmado');

    const chargeIdFinal = chargeId ?? cobranca.charge_id;

    // Assinatura: a partir daqui a Asaas revela o id da assinatura
    // (`payment.subscription`) — grava ele na cobrança (vira a
    // "cobrança-modelo" dos ciclos seguintes) e cria a linha em
    // `assinaturas` (usada só pro /cancelar-assinatura achar o id).
    if (cobranca.metodo_pagamento === 'assinatura' && payment?.subscription && chargeIdFinal) {
      await atualizarSubscriptionIdDaCobranca(chargeIdFinal, payment.subscription);
      await upsertAssinatura({
        id: payment.subscription,
        contratanteId: cobranca.contratante_id,
        planoId: cobranca.plano_id,
        documento: cobranca.documento,
        valor: cobranca.valor_cobrado,
        ciclo: payment.cycle ?? null, // ⚠️ não confirmado se a Asaas manda isso aqui
        proximaCobranca: payment.nextDueDate ?? null // ⚠️ idem
      });

      // Renovação: só AGORA a antiga é cancelada — com o pagamento novo
      // já confirmado. Se a renovação tivesse falhado, o assinante
      // continuaria com a assinatura anterior, sem ficar sem nenhuma.
      await encerrarAssinaturaSubstituida(cobranca, payment.subscription);
    }

    return notificarConformeMetodo(cobranca, {
      confirmado: true,
      chargeId: chargeIdFinal
    });
  }

  if (evento === 'CHECKOUT_CANCELED') {
    await atualizarStatusPorCheckoutId(asaasCheckoutId, 'cancelado');
    return notificarConformeMetodo(cobranca, { confirmado: false, eventoAssinatura: 'cancelada' });
  }

  if (evento === 'CHECKOUT_EXPIRED') {
    await atualizarStatusPorCheckoutId(asaasCheckoutId, 'expirado');
    // Sem notificação: nem o webhook de pedido (INTEGRACAO.md seção 4)
    // nem o de assinatura (seção 6.1) documentam um status/evento pra
    // expiração — só atualizamos nosso próprio banco.
  }
}

/**
 * Assinatura usa um FORMATO DE WEBHOOK DIFERENTE do pedido avulso
 * (INTEGRACAO.md seção 6.1 vs seção 4) — por isso ramifica aqui por
 * `metodo_pagamento` antes de montar o payload. `eventoAssinatura`
 * explícito (usado pelos ciclos recorrentes, cancelamento) tem
 * prioridade; sem ele, `confirmado: true` cai no default 'criada'
 * (1ª cobrança, via CHECKOUT_PAID).
 */
async function notificarConformeMetodo(cobranca, { confirmado, chargeId, eventoAssinatura }) {
  const webhookUrlDoContratante = cobranca.contratantes?.webhook_url;
  if (!webhookUrlDoContratante) return;
  const segredo = cobranca.contratantes?.api_key;

  // Assinatura por cartão e por Pix Automático usam o MESMO vocabulário
  // de webhook (INTEGRACAO.md 6.1) — pro contratante é a mesma coisa,
  // muda só como o assinante pagou.
  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    const evento = eventoAssinatura ?? (confirmado ? 'criada' : null);
    if (!evento) return;
    return notificarContratante(webhookUrlDoContratante, {
      versao: VERSAO_WEBHOOK,
      tipo: 'assinatura',
      planoId: cobranca.plano_id,
      documento: cobranca.documento,
      evento
    }, segredo);
  }

  // Cartão/Boleto avulso — só notifica em confirmação (cancelamento
  // de tentativa não tem status documentado no INTEGRACAO.md seção 4,
  // então não inventamos um aqui).
  if (confirmado) {
    return notificarContratante(
      webhookUrlDoContratante,
      montarPayloadConfirmacaoPedido(cobranca, chargeId, 'confirmado'),
      segredo
    );
  }
}

function montarPayloadConfirmacaoPedido(cobranca, chargeId, status) {
  return {
    versao: VERSAO_WEBHOOK,
    pedidoId: cobranca.pedido_id,
    chargeId,
    status,
    valorCheio: cobranca.valor_cheio,
    desconto: cobranca.desconto,
    cupom: cobranca.cupom,
    valorComDesconto: cobranca.valor_com_desconto,
    frete: cobranca.frete,
    taxaDoProjeto: cobranca.taxa_do_projeto,
    taxaAsaas: cobranca.taxa_asaas,
    taxaPropria: cobranca.taxa_propria,
    taxaIsenta: cobranca.taxa_isenta,
    taxasTotais: Number(cobranca.taxa_do_projeto ?? 0) + Number(cobranca.taxa_asaas ?? 0) + Number(cobranca.taxa_propria ?? 0),
    metodoPagamento: cobranca.metodo_pagamento,
    valorCobrado: cobranca.valor_cobrado
  };
}

// ponytail: retry em memória (setTimeout), sem fila persistente — se o
// processo reiniciar entre tentativas, a notificação pendente se perde.
// É o mesmo teto que o INTEGRACAO.md já documenta ("3 tentativas,
// espaçadas em alguns minutos"); subir pra fila persistente (ex.: tabela
// no Supabase + worker) só quando isso passar a ser um problema real.
const ATRASOS_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];

async function tentarNotificar(url, dados, segredo) {
  // O corpo é serializado UMA vez e a MESMA string é assinada e
  // enviada. Serializar de novo pra mandar poderia gerar bytes
  // diferentes (ordem de chave, espaçamento) e a assinatura não
  // fecharia do outro lado.
  const corpoCru = JSON.stringify(dados);
  const timestamp = Math.floor(Date.now() / 1000);

  const resposta = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Checkout-Signature': assinarPayload(corpoCru, segredo, timestamp),
      'X-Checkout-Timestamp': String(timestamp)
    },
    body: corpoCru
  });
  if (!resposta.ok) throw new Error(`contratante respondeu ${resposta.status}`);
}

async function notificarContratante(url, dados, segredo, tentativa = 0) {
  if (!segredo) {
    // Sem api_key não dá pra assinar, e mandar sem assinatura é
    // exatamente o buraco que essa mudança fecha — então não manda.
    // Na prática não acontece: api_key é `not null` na tabela.
    console.error(`[webhook/asaas] contratante sem api_key — notificação para ${url} NÃO enviada.`);
    return;
  }

  try {
    await tentarNotificar(url, dados, segredo);
  } catch (erro) {
    const atraso = ATRASOS_RETRY_MS[tentativa];
    if (atraso === undefined) {
      console.error(`[webhook/asaas] desistindo de notificar ${url} após ${tentativa + 1} tentativas:`, erro.message);
      return;
    }
    console.error(`[webhook/asaas] falha ao notificar ${url} (tentativa ${tentativa + 1}), nova tentativa em ${atraso / 1000}s:`, erro.message);
    setTimeout(() => notificarContratante(url, dados, segredo, tentativa + 1), atraso);
  }
}
