#!/usr/bin/env node
/**
 * tests/instrumento-obsoleto-nunca-volta.js
 *
 * CLASSE CR-03 da remediação da Estação 6 (SEC-004, SEC-005): instrumento
 * de pagamento entregue sem reconferir o estado.
 *
 * Pix e boleto (a guarda de pedido pago e a cotação ANTES do
 * reaproveitamento, o obsoleto que não volta, o preço mudado que exclui o
 * antigo antes de criar o novo) estão no autoteste de
 * `checkoutController.js`, com as dependências dele. Aqui ficam as duas
 * peças que não moram lá:
 *
 *  1. a SESSÃO de pop-up (cartão avulso e assinatura): aberta por outro
 *     preço, outro número de parcelas ou outro ciclo, ela é encerrada na
 *     Asaas antes de nascer outra — nunca reaproveitada, nunca duas
 *     pagáveis ao mesmo tempo;
 *  2. "a cobrança do pedido" da tela de status e da consulta do
 *     contratante: a que segura dinheiro, não a mais recente.
 */
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { abrirSessaoComReserva, sessaoDoCartaoServe, sessaoDaAssinaturaServe } = await import('../src/controllers/asaasCheckoutController.js');
const { escolherCobrancaRepresentativa } = await import('../src/services/cobrancaService.js');

let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

/** Um banco de pop-up que honra o índice único de `pendente`, e uma Asaas
 *  cuja resposta ao "encerrar sessão" é escolhida pelo cenário. */
function mundo({ existente, respostaDoCancelamento = { status: 'CANCELED' } }) {
  const linhas = new Map();
  if (existente) linhas.set('chave', { id: 'res_antiga', status: 'pendente', ...existente });
  const chamadas = [];
  let novas = 0;
  const deps = {
    reservarCobrancaPopup: async () => {
      chamadas.push('reservar');
      const atual = linhas.get('chave');
      if (atual && atual.status === 'pendente') return { reservada: false, existente: { ...atual } };
      novas += 1;
      linhas.set('chave', { id: `res_nova_${novas}`, status: 'pendente', asaas_checkout_id: null });
      return { reservada: true, id: `res_nova_${novas}` };
    },
    liberarReservaCobranca: async () => {},
    registrarErro: async () => {},
    foiRecusaLimpaDaAsaas: () => false,
    cancelarSessaoDeCheckout: async (id) => {
      chamadas.push(`cancelar:${id}`);
      if (respostaDoCancelamento instanceof Error) throw respostaDoCancelamento;
      return respostaDoCancelamento;
    },
    aplicarTransicaoPorCheckoutId: async (id, { de, para }) => {
      chamadas.push(`transicao:${de}->${para}`);
      const atual = linhas.get('chave');
      if (atual?.asaas_checkout_id === id && atual.status === de) { atual.status = para; return true; }
      return false;
    }
  };
  const sessoesCriadas = [];
  const abrir = (sessaoServe) => abrirSessaoComReserva({
    contexto: 'cartao',
    reserva: { contratanteId: 'c1', pedidoId: 'ped_1', metodoPagamento: 'cartao_credito' },
    criarSessao: async (ref) => { sessoesCriadas.push(ref); return { asaasCheckoutId: `chk_nova_${sessoesCriadas.length}` }; },
    completar: async (id, asaasCheckoutId) => { const l = linhas.get('chave'); if (l?.id === id) l.asaas_checkout_id = asaasCheckoutId; },
    sessaoServe
  }, deps);
  return { linhas, chamadas, sessoesCriadas, abrir };
}

const SESSAO_1X = { asaas_checkout_id: 'chk_antiga', valor_cobrado: 105.5, parcelas: 1, sessao_concluida_em: null, obsoleta_desde: null };
// A regra REAL do controlador do cartão, não uma cópia dela no teste.
const serveSe = (valor, parcelas) => (e) => sessaoDoCartaoServe(e, { valorCobrado: valor, parcelas });

/* ---- 1. a MESMA sessão (mesmo valor e parcelas): reaproveitada, nada encerrado ---- */
{
  const m = mundo({ existente: SESSAO_1X });
  const r = await m.abrir(serveSe(105.5, 1));
  igual([r.tipo, r.asaasCheckoutId], ['reaproveitada', 'chk_antiga'], 'mesmo valor e parcelas: reaproveita');
  ok(!m.chamadas.some((c) => c.startsWith('cancelar')), 'e não encerra nada');
  igual(m.sessoesCriadas.length, 0, 'nem abre outra');
}

/* ---- 2. OUTRO número de parcelas (a tela diz 3x, a pop-up antiga é 1x) ---- */
{
  const m = mundo({ existente: SESSAO_1X });
  const r = await m.abrir(serveSe(111.2, 3));
  igual(r.tipo, 'criada', 'parcelas diferentes: nasce uma sessão nova');
  const iCancelar = m.chamadas.indexOf('cancelar:chk_antiga');
  const iTransicao = m.chamadas.indexOf('transicao:pendente->cancelado');
  ok(iCancelar >= 0 && iTransicao > iCancelar, 'a antiga é encerrada na Asaas e a linha sai de pendente, nessa ordem');
  igual(m.sessoesCriadas.length, 1, 'uma sessão nova, uma só');
  ok(m.chamadas.lastIndexOf('reservar') > iTransicao, 'a reserva nova vem DEPOIS de a antiga sair — nunca duas pagáveis');
}

/* ---- 3. OUTRO preço (cupom depois da primeira pop-up) ---- */
{
  const m = mundo({ existente: SESSAO_1X });
  const r = await m.abrir(serveSe(90, 1));
  igual(r.tipo, 'criada', 'preço diferente: sessão nova pelo preço novo');
  ok(m.chamadas.includes('cancelar:chk_antiga'), 'e a do preço antigo foi encerrada');
}

/* ---- 4. a antiga já foi PAGA: não se substitui ---- */
{
  const m = mundo({ existente: SESSAO_1X, respostaDoCancelamento: { status: 'PAID' } });
  const r = await m.abrir(serveSe(90, 1));
  igual([r.tipo, r.asaasCheckoutId], ['em_processamento', 'chk_antiga'], 'antiga paga: a tela acompanha a que existe');
  igual(m.sessoesCriadas.length, 0, 'nenhuma sessão nova');
  ok(!m.chamadas.some((c) => c.startsWith('transicao')), 'e a linha paga não é tocada');
}

/* ---- 5. encerrar FALHOU (timeout, 5xx): nada novo nasce ---- */
{
  const m = mundo({ existente: SESSAO_1X, respostaDoCancelamento: Object.assign(new Error('A Asaas não respondeu a tempo.'), { status: 504 }) });
  const r = await m.abrir(serveSe(90, 1));
  igual(r.tipo, 'em_andamento', 'encerrar falhou: "tente de novo", sem sessão nova');
  igual(m.sessoesCriadas.length, 0, 'nenhuma sessão nova enquanto a antiga pode estar viva');
}

/* ---- 6. resposta estranha ao encerrar (ACTIVE): é "não sei" ---- */
{
  const m = mundo({ existente: SESSAO_1X, respostaDoCancelamento: { status: 'ACTIVE' } });
  igual((await m.abrir(serveSe(90, 1))).tipo, 'em_andamento', 'ACTIVE depois de encerrar: não sei, nada novo');
}

/* ---- 7. sessão CONCLUÍDA pelo pagador (RN-47) nunca é substituída ---- */
{
  const m = mundo({ existente: { ...SESSAO_1X, sessao_concluida_em: '2026-09-25T12:00:00Z' } });
  const r = await m.abrir(serveSe(90, 3));
  igual(r.tipo, 'em_processamento', 'concluída: o dinheiro vem no evento de pagamento, não se abre outra');
  ok(!m.chamadas.some((c) => c.startsWith('cancelar')), 'e ela não é encerrada');
}

/* ---- 8. sessão OBSOLETA (outra cobrança do pedido pagou): nunca reaproveitada ---- */
{
  const m = mundo({ existente: { ...SESSAO_1X, obsoleta_desde: '2026-09-25T12:00:00Z' } });
  const r = await m.abrir(serveSe(105.5, 1));
  ok(r.tipo !== 'reaproveitada', `obsoleta: nunca volta a ser entregue (veio ${r.tipo})`);
  ok(m.chamadas.includes('cancelar:chk_antiga'), 'é encerrada');
}

/* ---- 9. sem `sessaoServe` (quem ainda não pediu a regra): comportamento antigo ---- */
{
  const m = mundo({ existente: SESSAO_1X });
  igual((await m.abrir(null)).tipo, 'reaproveitada', 'sem a regra, reaproveita como antes (nenhum chamador ficou nesse caso)');
}

/* ---- 9b. as duas regras de sessão vigente, direto, e a fiação delas ---- */
{
  const base = { valor_cobrado: 105.5, parcelas: 3, ciclo: 'MONTHLY', obsoleta_desde: null };
  ok(sessaoDoCartaoServe(base, { valorCobrado: 105.5, parcelas: 3 }), 'cartão: mesmo valor e parcelas serve');
  ok(!sessaoDoCartaoServe(base, { valorCobrado: 105.5, parcelas: 1 }), 'cartão: outra parcela NÃO serve');
  ok(!sessaoDoCartaoServe(base, { valorCobrado: 105.51, parcelas: 3 }), 'cartão: um centavo diferente NÃO serve');
  ok(sessaoDoCartaoServe(base, { valorCobrado: 105.50000000000001, parcelas: 3 }), 'cartão: comparação em centavos, sem ruído de ponto flutuante');
  ok(!sessaoDoCartaoServe({ ...base, obsoleta_desde: 'x' }, { valorCobrado: 105.5, parcelas: 3 }), 'cartão: obsoleta nunca serve');
  ok(sessaoDaAssinaturaServe(base, { valor: 105.5, ciclo: 'MONTHLY' }), 'assinatura: mesmo valor e ciclo serve');
  ok(!sessaoDaAssinaturaServe(base, { valor: 105.5, ciclo: 'YEARLY' }), 'assinatura: outro ciclo NÃO serve');
  ok(!sessaoDaAssinaturaServe(base, { valor: 99, ciclo: 'MONTHLY' }), 'assinatura: outro valor NÃO serve');
  ok(!sessaoDaAssinaturaServe({ ...base, obsoleta_desde: 'x' }, { valor: 105.5, ciclo: 'MONTHLY' }), 'assinatura: obsoleta nunca serve');
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../src/controllers/asaasCheckoutController.js', import.meta.url), 'utf8');
  ok(/sessaoServe: \(existente\) => sessaoDoCartaoServe\(existente, \{ valorCobrado, parcelas: parcelasOfertadas \}\)/.test(fonte), 'o cartão passa a regra dele ao abrir a sessão');
  ok(/sessaoServe: \(existente\) => sessaoDaAssinaturaServe\(existente, \{ valor, ciclo \}\)/.test(fonte), 'e a assinatura, a dela');
}

/* ---- 10. SEC-005: a cobrança do pedido é a que SEGURA dinheiro ---- */
{
  const pix = { id: 'a', status: 'confirmado', criado_em: '2026-09-25T10:00:00Z' };
  const popupAbandonada = { id: 'b', status: 'cancelado', criado_em: '2026-09-25T11:00:00Z' };
  igual(escolherCobrancaRepresentativa([popupAbandonada, pix])?.id, 'a', 'Pix pago + pop-up abandonada depois: a tela diz pago');

  const boletoQueFicou = { id: 'c', status: 'pendente', criado_em: '2026-09-25T11:30:00Z' };
  igual(escolherCobrancaRepresentativa([boletoQueFicou, pix])?.id, 'a', 'irmã boleto pendente mais recente não oferece credenciais num pedido pago');

  const irma = { id: 'd', status: 'cancelado_por_outro_pagamento', criado_em: '2026-09-25T12:00:00Z' };
  igual(escolherCobrancaRepresentativa([irma, pix])?.id, 'a', 'a irmã cancelada por outro pagamento nunca é escolhida');

  const estornado = { id: 'e', status: 'estornado', criado_em: '2026-09-25T09:00:00Z' };
  const novoPix = { id: 'f', status: 'pendente', criado_em: '2026-09-25T13:00:00Z' };
  igual(escolherCobrancaRepresentativa([novoPix, estornado])?.id, 'f', 'estornado por inteiro e comprado de novo: a tentativa nova é a do pedido');

  const obsoleta = { id: 'g', status: 'pendente', obsoleta_desde: '2026-09-25T12:00:00Z', criado_em: '2026-09-25T12:30:00Z' };
  const recusada = { id: 'h', status: 'recusado', criado_em: '2026-09-25T12:10:00Z' };
  igual(escolherCobrancaRepresentativa([obsoleta, recusada])?.id, 'g', 'sem dinheiro retido e sem pendente vigente: a mais recente');
  igual(escolherCobrancaRepresentativa([{ id: 'x', status: 'pendente', criado_em: '1' }, { id: 'y', status: 'pendente', criado_em: '2' }])?.id, 'y', 'duas pendentes vigentes: a mais recente');
  igual(escolherCobrancaRepresentativa([]), null, 'pedido sem cobrança: nada');
  igual(escolherCobrancaRepresentativa([irma]), null, 'só a irmã cancelada: nada — ela não é "a do pedido"');
  igual(escolherCobrancaRepresentativa([{ id: 'z', status: 'chargeback', criado_em: '1' }, novoPix])?.id, 'z', 'contestação segura dinheiro: vence a tentativa nova');
}

console.log(`instrumento-obsoleto-nunca-volta: ${checagens} checagens OK`);
