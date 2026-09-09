/**
 * SAN CHECKOUT v2 — src/services/cobrancaService.js
 * Registra cada cobrança criada, liga com o contratante/pedido de
 * origem, e serve de consulta pro webhook e pro estorno.
 */

import { supabase } from '../config/supabase.js';

export async function registrarCobranca(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    charge_id: dados.chargeId,
    contratante_id: dados.contratanteId,
    pedido_id: dados.pedidoId,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ? Number(dados.cidadeIbge) : null,
    itens: dados.itens ?? null,
    valor_cheio: dados.valorCheio,
    desconto: dados.desconto ?? 0,
    cupom: dados.cupom ?? null,
    valor_com_desconto: dados.valorComDesconto,
    frete: dados.frete ?? 0,
    taxa_do_projeto: dados.taxaDoProjeto ?? 0,
    taxa_asaas: dados.taxaAsaas,
    taxa_propria: dados.taxaPropria,
    taxa_isenta: dados.taxaIsenta ?? false,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: dados.metodoPagamento
  });

  if (error) console.error('[cobrancaService.registrarCobranca]', error.message);
}

/**
 * Registra uma cobrança do fluxo POP-UP (Cartão/Boleto/Assinatura) —
 * criada ANTES de existir charge_id, só com asaas_checkout_id. O
 * charge_id de verdade é preenchido depois, via
 * `vincularChargeIdAoCheckout`, quando o webhook CHECKOUT_PAID chegar.
 */
export async function registrarCobrancaPendentePopup(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    asaas_checkout_id: dados.asaasCheckoutId,
    contratante_id: dados.contratanteId,
    pedido_id: dados.pedidoId ?? null,
    plano_id: dados.planoId ?? null,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ? Number(dados.cidadeIbge) : null,
    itens: dados.itens ?? null,
    valor_cheio: dados.valorCheio,
    desconto: dados.desconto ?? 0,
    cupom: dados.cupom ?? null,
    valor_com_desconto: dados.valorComDesconto,
    frete: dados.frete ?? 0,
    taxa_do_projeto: dados.taxaDoProjeto ?? 0,
    taxa_asaas: dados.taxaAsaas,
    taxa_propria: dados.taxaPropria,
    taxa_isenta: dados.taxaIsenta ?? false,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: dados.metodoPagamento,
    parcelas: dados.parcelas ?? 1,
    status: 'pendente'
  });

  if (error) console.error('[cobrancaService.registrarCobrancaPendentePopup]', error.message);
}

/**
 * Registra um CICLO NOVO de assinatura recorrente — diferente de
 * `registrarCobrancaPendentePopup` (usada só na 1ª cobrança, criada
 * ANTES de existir charge_id). A partir do 2º ciclo, a Asaas cobra
 * sozinha e o charge_id já vem pronto no próprio webhook de pagamento
 * (`payment.id`), então esta função insere direto com ele — sem passar
 * pelo estado intermediário "pendente popup". `dados` é montado a
 * partir da cobrança-modelo (a mais recente daquela assinatura, ver
 * `buscarCobrancaPorSubscriptionId`), copiando contratante/plano/CPF/
 * telefone/endereço, só trocando charge_id e valor.
 */
export async function registrarCicloAssinatura(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    charge_id: dados.chargeId,
    asaas_subscription_id: dados.asaasSubscriptionId,
    contratante_id: dados.contratanteId,
    plano_id: dados.planoId ?? null,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ?? null,
    valor_cheio: dados.valorCheio,
    valor_com_desconto: dados.valorComDesconto,
    taxa_asaas: 0,
    taxa_propria: 0,
    taxa_isenta: true,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: 'assinatura',
    parcelas: 1,
    status: 'pendente'
  });

  if (error) console.error('[cobrancaService.registrarCicloAssinatura]', error.message);
}

/** Busca pelo id da SESSÃO (asaas_checkout_id) — é o que o front tem
 *  logo depois de criar, antes de qualquer charge_id existir. Usado
 *  pelo endpoint de status/polling. */
export async function buscarCobrancaPorCheckoutId(asaasCheckoutId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('asaas_checkout_id', asaasCheckoutId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Preenche o charge_id de verdade quando o webhook CHECKOUT_PAID
 *  chegar — até então a cobrança só tinha asaas_checkout_id. */
export async function vincularChargeIdAoCheckout(asaasCheckoutId, chargeId) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ charge_id: chargeId, atualizado_em: new Date().toISOString() })
    .eq('asaas_checkout_id', asaasCheckoutId);

  if (error) console.error('[cobrancaService.vincularChargeIdAoCheckout]', error.message);
}

/** Atualiza status por asaas_checkout_id — usado pelos eventos
 *  CHECKOUT_PAID/CHECKOUT_CANCELED/CHECKOUT_EXPIRED, que identificam
 *  a sessão, não a cobrança (diferente do webhook de Pix, que já
 *  identifica direto pelo payment/charge_id). */
export async function atualizarStatusPorCheckoutId(asaasCheckoutId, status) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ status, atualizado_em: new Date().toISOString() })
    .eq('asaas_checkout_id', asaasCheckoutId);

  if (error) console.error('[cobrancaService.atualizarStatusPorCheckoutId]', error.message);
}

/** Grava o id da assinatura na Asaas (`subscription`) na cobrança da
 *  1ª cobrança — chamado só uma vez, junto do CHECKOUT_PAID, pra
 *  depois servir de "cobrança-modelo" quando ciclos seguintes
 *  chegarem (ver `buscarCobrancaPorSubscriptionId`). */
export async function atualizarSubscriptionIdDaCobranca(chargeId, subscriptionId) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ asaas_subscription_id: subscriptionId, atualizado_em: new Date().toISOString() })
    .eq('charge_id', chargeId);

  if (error) console.error('[cobrancaService.atualizarSubscriptionIdDaCobranca]', error.message);
}

/** Busca a cobrança mais recente de uma assinatura — serve de "molde"
 *  (contratante/plano/documento/telefone/endereço) pra registrar um
 *  ciclo novo, que chega no webhook só com o id da assinatura, sem
 *  nenhum outro dado do pagador. */
export async function buscarCobrancaPorSubscriptionId(subscriptionId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('asaas_subscription_id', subscriptionId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Busca a cobrança + contratante dono dela (join), usado pelo webhook
 *  e pelo estorno. */
export async function buscarCobranca(chargeId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*, contratantes(webhook_url, nome)')
    .eq('charge_id', chargeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Busca a cobrança mais recente de um pedido — usado no /estornar,
 *  que recebe pedidoId (não chargeId) do contratante. */
export async function buscarCobrancaPorPedido(contratanteId, pedidoId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('pedido_id', pedidoId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function atualizarStatusCobranca(chargeId, status) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ status, atualizado_em: new Date().toISOString() })
    .eq('charge_id', chargeId);

  if (error) console.error('[cobrancaService.atualizarStatusCobranca]', error.message);
}
