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
  registrarCicloAssinatura
} from '../services/cobrancaService.js';
import { upsertAssinatura } from '../services/assinaturaService.js';
import { compararSeguro } from '../utils/validadores.js';

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
const EVENTOS_PAYMENT_TRATADOS = [
  ...EVENTOS_PAYMENT_CONFIRMACAO,
  ...EVENTOS_PAYMENT_ESTORNO,
  ...EVENTOS_PAYMENT_ESTORNO_PROGRESSO,
  ...EVENTOS_PAYMENT_ESTORNO_NEGADO,
  ...EVENTOS_PAYMENT_VENCIDO
];

export async function receberWebhookAsaas(requisicao, resposta) {
  console.log('[webhook/asaas] payload recebido:', JSON.stringify(requisicao.body, null, 2));

  try {
    const corpo = requisicao.body;
    const evento = corpo?.event;

    if (evento?.startsWith('CHECKOUT_')) {
      await processarEventoCheckout(corpo);
    } else if (EVENTOS_PAYMENT_TRATADOS.includes(evento)) {
      await processarEventoPayment(corpo);
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
  return null;
}

/** Só usado pra notificação de Assinatura — traduz o status local pro
 *  vocabulário já documentado no INTEGRACAO.md seção 6.1
 *  (criada/cobranca_confirmada/cobranca_falhou/cancelada). */
function mapearEventoAssinatura(status) {
  if (status === 'confirmado') return 'cobranca_confirmada';
  if (status === 'vencido') return 'cobranca_falhou';
  if (status === 'estornado' || status === 'estorno_solicitado') return 'cobranca_estornada';
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

  if (cobranca.metodo_pagamento === 'assinatura') {
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
    await notificarContratante(webhookUrlDoContratante, montarPayloadConfirmacaoPedido(cobranca, chargeId, novoStatus));
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
    cpf: modelo.cpf,
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
        cpf: cobranca.cpf,
        valor: cobranca.valor_cobrado,
        ciclo: payment.cycle ?? null, // ⚠️ não confirmado se a Asaas manda isso aqui
        proximaCobranca: payment.nextDueDate ?? null // ⚠️ idem
      });
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

  if (cobranca.metodo_pagamento === 'assinatura') {
    const evento = eventoAssinatura ?? (confirmado ? 'criada' : null);
    if (!evento) return;
    return notificarContratante(webhookUrlDoContratante, {
      tipo: 'assinatura',
      planoId: cobranca.plano_id,
      cpf: cobranca.cpf,
      evento
    });
  }

  // Cartão/Boleto avulso — só notifica em confirmação (cancelamento
  // de tentativa não tem status documentado no INTEGRACAO.md seção 4,
  // então não inventamos um aqui).
  if (confirmado) {
    return notificarContratante(webhookUrlDoContratante, montarPayloadConfirmacaoPedido(cobranca, chargeId, 'confirmado'));
  }
}

function montarPayloadConfirmacaoPedido(cobranca, chargeId, status) {
  return {
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

async function notificarContratante(url, dados) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });
  } catch (erro) {
    console.error(`[webhook/asaas] falha ao notificar o contratante em ${url}:`, erro.message);
  }
}
