#!/usr/bin/env node
/**
 * tests/assinatura-nasce-inteira.js
 *
 * CLASSES CR-06 e CR-08 da remediação da Estação 6 (SEC-014, SEC-011):
 * o vínculo da assinatura que ficava pela metade, calado.
 *
 *   SEC-014 — `upsertAssinatura`, `atualizarSubscriptionIdDaCobranca` e
 *   `vincularChargeIdAoCheckout` só registravam o erro no log. Uma falha
 *   do banco no meio da primeira confirmação deixava a cobrança
 *   `confirmado`, o contratante avisado de `criada`, e nenhuma linha em
 *   `assinaturas`: cancelar, pausar e consultar respondiam 404 enquanto a
 *   Asaas seguia cobrando. E a retentativa decidia "é a primeira?" por um
 *   vínculo JÁ gravado — nunca refazia.
 *
 *   SEC-011 — o id da assinatura só era gravado no primeiro `confirmado`.
 *   Primeiro ciclo recusado: nenhuma linha daqui apontava para a
 *   assinatura, que seguia viva na Asaas, e o ciclo seguinte chegava como
 *   "assinatura desconhecida" — descartado com uma linha de log.
 *
 * Código real (receptor, inbox, serviços), banco falso com FALHA INJETADA
 * (o erro volta como o PostgREST devolve, sem lançar — é o caso que era
 * engolido), Asaas roteirizada.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const LOJA = { id: 'loja', nome: 'Loja', api_key: 'segredo-da-loja', webhook_url: 'https://loja.exemplo/hook', metodos_habilitados: null };
const linhaDaPopup = (extra = {}) => ({
  id: '5e5e5e5e-0000-4000-8000-000000000001', contratante_id: 'loja', plano_id: 'plano_pro', documento: '11144477735',
  metodo_pagamento: 'assinatura', status: 'pendente', charge_id: null, asaas_checkout_id: 'chk_a', asaas_subscription_id: null,
  ciclo: 'MONTHLY', valor_cobrado: 50, valor_cheio: 50, valor_com_desconto: 50, ambiente: 'sandbox', e_teste: false,
  criado_em: new Date(Date.now() - 3600_000).toISOString(), contratantes: LOJA, ...extra
});
const pagamento = (id, status, extra = {}) => ({ status: 200, corpo: { id, status, value: 50, deleted: false, refunds: [], subscription: 'sub_a', ...extra } });

async function rodar({ tabelas, falhas = {}, asaas = {}, passos, atrasoDaAsaasMs = 0 }) {
  const pasta = mkdtempSync(join(tmpdir(), 'assinatura-inteira-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [LOJA], assinaturas: [], outbox_notificacoes: [], webhook_inbox: [], ...tabelas }, falhas }));
  const codigo = `
    const roteiro = ${JSON.stringify(asaas)};
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api-sandbox.asaas.com') return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      const r = roteiro[(opcoes.method ?? 'GET') + ' ' + u.pathname];
      if (!r) return new Response('{"errors":[{"description":"fora do roteiro"}]}', { status: 500 });
      if (${atrasoDaAsaasMs}) await new Promise((ok) => setTimeout(ok, Math.random() * ${atrasoDaAsaasMs})); // a rede: sem ela, passadas concorrentes não se intercalam
      return new Response(JSON.stringify(r.corpo), { status: r.status, headers: { 'content-type': 'application/json' } });
    };
    const wc = await import('./src/controllers/webhookController.js');
    const cobrancas = await import('./src/services/cobrancaService.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const resultados = [];
    for (const passo of ${JSON.stringify(passos)}) {
      try {
        if (passo.receber) {
          const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
          await wc.receberWebhookAsaas({ body: passo.receber, get: () => undefined, ip: '52.67.12.206' }, res);
          resultados.push(res._s);
        }
        if (passo.reprocessar) {
          const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
          for (const l of estado.tabelas.webhook_inbox ?? []) if (l.proxima_tentativa_em) l.proxima_tentativa_em = new Date(Date.now() - 1000).toISOString();
          writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
          resultados.push(await wc.reprocessarInbox());
        }
        if (passo.vincularCheckout) resultados.push(await cobrancas.vincularChargeIdAoCheckout(...passo.vincularCheckout));
        if (passo.receberJuntos) {
          const rs = passo.receberJuntos.map(() => ({ _s: null, status(c) { this._s = c; return this; }, json() { return this; } }));
          await Promise.all(passo.receberJuntos.map((corpo, i) => wc.receberWebhookAsaas({ body: corpo, get: () => undefined, ip: '52.67.12.206' }, rs[i])));
          await new Promise((r) => setTimeout(r, 300));
          resultados.push(rs.map((r) => r._s));
        }
        if (passo.registrarCiclo) resultados.push(await cobrancas.registrarCicloAssinatura(passo.registrarCiclo));
        if (passo.ajustar) {
          const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
          const l = estado.tabelas[passo.ajustar.tabela].find((x) => x.id === passo.ajustar.id);
          Object.assign(l, passo.ajustar.campos);
          writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
          resultados.push(null);
        }
      } catch (e) { resultados.push('LANCOU: ' + e.message); }
    }
    await new Promise((r) => setTimeout(r, 200));
    console.log(JSON.stringify({ resultados }));
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', BANCO_FALSO_ARQUIVO: arquivo }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  if (status !== 0) throw new Error(`processo filho falhou:\n${stderr}`);
  const { resultados } = JSON.parse(stdout.trim().split('\n').pop());
  const banco = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas;
  return { resultados, banco, stderr };
}

const evento = (id, tipo, chargeId) => ({ id, event: tipo, dateCreated: '2026-09-25 10:00:00', payment: { id: chargeId } });
const avisos = (banco, evento) => (banco.outbox_notificacoes ?? []).filter((o) => o.evento === evento);

/* ── A) SEC-014: o banco falha NO MEIO da primeira confirmação ─────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup()] },
    falhas: { 'assinaturas.upsert': 1 },
    asaas: { 'GET /v3/payments/pay_a': pagamento('pay_a', 'CONFIRMED', { checkoutSession: 'chk_a' }) },
    passos: [{ receber: evento('evt_a1', 'PAYMENT_CONFIRMED', 'pay_a') }, { reprocessar: true }]
  });
  const linha = r.banco.cobrancas[0];
  igual([linha.charge_id, linha.status, linha.asaas_subscription_id], ['pay_a', 'confirmado', 'sub_a'], 'o pagamento foi aplicado');
  igual(r.banco.assinaturas.map((a) => [a.id, a.status]), [['sub_a', 'ativa']], 'SEC-014: a assinatura NASCE — na refeitura, porque a primeira passada não engoliu o erro');
  igual(avisos(r.banco, 'criada').length, 1, 'e o contratante ouve `criada` uma vez — depois de a assinatura existir, não antes');
  igual(r.resultados[1], { examinadas: 1, processadas: 1, falhas: 0 }, 'a inbox guardou a falha e o worker refez');
  igual((r.banco.webhook_inbox ?? [])[0]?.status, 'processado');
}

/* ── controle: sem falha, nasce na primeira passada ────────────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup()] },
    asaas: { 'GET /v3/payments/pay_a': pagamento('pay_a', 'CONFIRMED', { checkoutSession: 'chk_a' }) },
    passos: [{ receber: evento('evt_a1', 'PAYMENT_CONFIRMED', 'pay_a') }]
  });
  igual(r.banco.assinaturas.length, 1, 'controle: sem falha, a assinatura nasce na primeira passada');
  igual((r.banco.webhook_inbox ?? [])[0]?.status, 'processado');
}

/* ── B) SEC-011: 1º ciclo recusado, e o ciclo seguinte pago ────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup({ sessao_concluida_em: new Date(Date.now() - 3000_000).toISOString() })] },
    asaas: {
      'GET /v3/payments/pay_c1': pagamento('pay_c1', 'PENDING', { checkoutSession: 'chk_a' }),
      'GET /v3/payments/pay_c2': pagamento('pay_c2', 'CONFIRMED')
    },
    passos: [
      { receber: evento('evt_c1', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'pay_c1') },
      { receber: evento('evt_c2', 'PAYMENT_CONFIRMED', 'pay_c2') }
    ]
  });
  const primeira = r.banco.cobrancas.find((c) => c.charge_id === 'pay_c1');
  igual([primeira.status, primeira.asaas_subscription_id], ['recusado', 'sub_a'], 'SEC-011: o 1º ciclo recusado já deixa a assinatura apontada');
  ok((r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.primeiroCicloFalhou'), 'SEC-011: e um humano é chamado — ela segue viva na Asaas');
  const segundo = r.banco.cobrancas.find((c) => c.charge_id === 'pay_c2');
  ok(segundo && segundo.status === 'confirmado', 'SEC-011: o ciclo seguinte PAGO é reconhecido (antes: "assinatura desconhecida", descartado)');
  igual(r.banco.assinaturas.map((a) => a.id), ['sub_a'], 'e a assinatura nasce com o primeiro dinheiro');
  ok(!(r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.assinaturaDesconhecida'), 'sem alarme de assinatura desconhecida');
}

/* ── D) CP3-05: o alerta sobrevive à falha DEPOIS da transição ─────── */
/* A sessão substituída (`cancelado`) que a Asaas liquidou chama um
   humano. Se a amarração lança depois de a transição estar gravada, a
   retentativa chega como reentrega — e o alerta, que dependia de
   "transição aplicada NESTA passada", nunca saía. */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup({ status: 'cancelado' })] },
    falhas: { 'assinaturas.upsert': 1 },
    asaas: { 'GET /v3/payments/pay_a': pagamento('pay_a', 'CONFIRMED', { checkoutSession: 'chk_a' }) },
    passos: [{ receber: evento('evt_d1', 'PAYMENT_CONFIRMED', 'pay_a') }, { reprocessar: true }]
  });
  igual(r.banco.cobrancas[0].status, 'confirmado', 'CP3-05: a sessão substituída paga é aplicada');
  igual(r.banco.assinaturas.map((a) => a.id), ['sub_a'], 'CP3-05: e a assinatura nasce na refeitura');
  ok((r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.assinaturaSubstituidaPaga'), 'CP3-05: e um humano é chamado MESMO com a primeira passada morrendo depois da transição');
}
/* controle: a sessão que não foi substituída não chama ninguém */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup()] },
    falhas: { 'assinaturas.upsert': 1 },
    asaas: { 'GET /v3/payments/pay_a': pagamento('pay_a', 'CONFIRMED', { checkoutSession: 'chk_a' }) },
    passos: [{ receber: evento('evt_d2', 'PAYMENT_CONFIRMED', 'pay_a') }, { reprocessar: true }]
  });
  ok(!(r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.assinaturaSubstituidaPaga'), 'controle: sessão pendente paga não é "substituída"');
}
/* SEC-011 pelo mesmo caminho: a leitura da assinatura falha uma vez */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup({ sessao_concluida_em: new Date(Date.now() - 3000_000).toISOString() })] },
    falhas: { 'assinaturas.select': 1 },
    asaas: { 'GET /v3/payments/pay_c1': pagamento('pay_c1', 'PENDING', { checkoutSession: 'chk_a' }) },
    passos: [{ receber: evento('evt_d3', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'pay_c1') }, { reprocessar: true }]
  });
  igual(r.banco.cobrancas[0].status, 'recusado', 'CP3-05: o 1º ciclo recusado é aplicado');
  ok((r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.primeiroCicloFalhou'), 'CP3-05: e o humano é chamado mesmo com a leitura da assinatura falhando uma vez');
}

/* ── E) FP1A-1: o ciclo pago que esbarra na reserva de uma renovação ──
   A linha do ciclo 2+ (`assinatura`, `pendente`, com plano e documento,
   sem pedido) cai no índice único da reserva de pop-up. Com a renovação
   do mesmo plano aberta, o `23505` era lido como "charge repetido": o
   ciclo pago sumia sem linha, sem aviso e com a inbox `processado`. */
{
  const primeiro = linhaDaPopup({ status: 'confirmado', charge_id: 'pay_1', asaas_subscription_id: 'sub_a', criado_em: new Date(Date.now() - 40 * 86400_000).toISOString() });
  const renovacao = linhaDaPopup({ id: '5e5e5e5e-0000-4000-8000-000000000009', asaas_checkout_id: 'chk_renova', criado_em: new Date(Date.now() - 10 * 60_000).toISOString() });
  const assinatura = { id: 'sub_a', contratante_id: 'loja', plano_id: 'plano_pro', documento: '11144477735', valor: 50, ciclo: 'MONTHLY', status: 'ativa', mutation_version: 0 };
  const r = await rodar({
    tabelas: { cobrancas: [primeiro, renovacao], assinaturas: [assinatura] },
    asaas: { 'GET /v3/payments/pay_2': pagamento('pay_2', 'CONFIRMED', { externalReference: `reserva-${primeiro.id}` }) },
    passos: [
      { receber: evento('evt_e1', 'PAYMENT_CONFIRMED', 'pay_2') },
      { ajustar: { tabela: 'cobrancas', id: renovacao.id, campos: { status: 'expirado' } } },
      { reprocessar: true }
    ]
  });
  const ciclo = r.banco.cobrancas.find((c) => c.charge_id === 'pay_2');
  ok(ciclo && ciclo.status === 'confirmado', `FP1A-1: o ciclo pago NÃO se perde — com a reserva resolvida, a retentativa o grava (veio ${JSON.stringify(ciclo?.status)})`);
  igual(r.resultados[2], { examinadas: 1, processadas: 1, falhas: 0 }, 'FP1A-1: a primeira passada LANÇOU (a inbox guardou para refazer), não marcou processado');
  igual((r.banco.webhook_inbox ?? [])[0]?.status, 'processado', 'FP1A-1: e só então o evento fica processado');
  /* O aviso ao contratante não é conferido aqui: a linha nova do ciclo
     nasce sem o `contratantes(...)` que o banco falso não junta. */
}
/* controle: o `23505` de um charge que JÁ existe continua sendo reentrega */
{
  const existente = linhaDaPopup({ status: 'confirmado', charge_id: 'pay_rep', asaas_subscription_id: 'sub_a', asaas_checkout_id: null });
  const r = await rodar({
    tabelas: { cobrancas: [existente] },
    passos: [{ registrarCiclo: { chargeId: 'pay_rep', asaasSubscriptionId: 'sub_a', contratanteId: 'loja', planoId: 'plano_pro', documento: '11144477735', valorCheio: 50, valorComDesconto: 50, valorCobrado: 50 } }]
  });
  igual(r.resultados[0], { duplicado: true }, 'controle: charge repetido de verdade continua `duplicado` (a entrega perdedora não notifica — RN-23)');
}

/* ── F) FP1R-A-1: dois eventos DIFERENTES do mesmo ciclo novo, juntos ──
   O vencimento (ou a recusa) e a confirmação disputam a inserção da linha
   do ciclo. Quem perde lia "duplicado" e parava — se a perdedora era a
   confirmação, o ciclo ficava `vencido` com a Asaas dizendo pago, a inbox
   `processado` e ninguém avisado. Agora a perdedora segue com a linha que
   existe: perde o UPDATE condicional, lança, e a inbox a refaz. */
for (const [tipo, antes] of [['PAYMENT_OVERDUE', 'vencido'], ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'recusado']]) {
  const primeiro = linhaDaPopup({ status: 'confirmado', charge_id: 'pay_1', asaas_subscription_id: 'sub_a', criado_em: new Date(Date.now() - 40 * 86400_000).toISOString() });
  const assinatura = { id: 'sub_a', contratante_id: 'loja', plano_id: 'plano_pro', documento: '11144477735', valor: 50, ciclo: 'MONTHLY', status: 'ativa', mutation_version: 0 };
  const r = await rodar({
    tabelas: { cobrancas: [primeiro], assinaturas: [assinatura] },
    asaas: { 'GET /v3/payments/pay_2': pagamento('pay_2', 'CONFIRMED', { externalReference: `reserva-${primeiro.id}` }) },
    passos: [
      { receberJuntos: [
        { id: `evt_f_${tipo}`, event: tipo, dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_2' } },
        { id: 'evt_f_conf', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-25 10:00:05', payment: { id: 'pay_2' } }
      ] },
      { reprocessar: true }
    ]
  });
  const ciclo = r.banco.cobrancas.filter((c) => c.charge_id === 'pay_2');
  igual(ciclo.length, 1, `FP1R-A-1 (${tipo}): uma linha só para o ciclo`);
  igual(ciclo[0]?.status, 'confirmado', `FP1R-A-1 (${tipo} junto com a confirmação): o ciclo que a Asaas diz pago termina confirmado, não "${antes}"`);
  ok((r.banco.webhook_inbox ?? []).every((l) => l.status === 'processado'), `FP1R-A-1 (${tipo}): e só depois de aplicada a confirmação sai da inbox`);
}

/* ── G) FP1R-A-2: parcela 2..N de cartão parcelado não é "reserva sem linha" ── */
{
  const reserva = linhaDaPopup({ metodo_pagamento: 'cartao_credito', plano_id: null, pedido_id: 'ped_parc', status: 'confirmado', charge_id: 'pay_parc_1', asaas_subscription_id: null });
  const r = await rodar({
    tabelas: { cobrancas: [reserva] },
    asaas: { 'GET /v3/payments/pay_parc_2': pagamento('pay_parc_2', 'CONFIRMED', { subscription: null, installment: 'ins_1', externalReference: `reserva-${reserva.id}` }) },
    passos: [{ receber: evento('evt_g', 'PAYMENT_CONFIRMED', 'pay_parc_2') }]
  });
  ok(!(r.banco.erros ?? []).some((e) => e.contexto === 'webhookController.reservaSemLinha'), 'FP1R-A-2: a parcela 2 de uma reserva que existe NÃO manda um humano estornar');
}

/* ── H) FP2A-1/FP2A-2: CONFIRMED e RECEIVED do mesmo charge, juntos ──
   A primeira cobrança de uma RENOVAÇÃO. Duas passadas simultâneas
   terminavam em qualquer ordem: a que aplicou a transição, achando a
   chave do fato já gravada pela outra, enfileirava um SEGUNDO `criada`
   com `eventoId` novo, e as duas cancelavam a assinatura antiga na
   Asaas. Agora uma passada por charge: um aviso, um DELETE. Rodado
   algumas vezes porque a intercalação depende do agendador. */
for (let rodada = 0; rodada < 6; rodada += 1) {
  const renovacao = linhaDaPopup({ substitui_assinatura_id: 'sub_old' });
  const antiga = { id: 'sub_old', contratante_id: 'loja', plano_id: 'plano_pro', documento: '11144477735', valor: 50, ciclo: 'MONTHLY', status: 'ativa', mutation_version: 0 };
  const r = await rodar({
    tabelas: { cobrancas: [renovacao], assinaturas: [antiga] },
    asaas: {
      'GET /v3/payments/pay_a': pagamento('pay_a', 'RECEIVED', { checkoutSession: 'chk_a', externalReference: `reserva-${renovacao.id}` }),
      'DELETE /v3/subscriptions/sub_old': { status: 200, corpo: { deleted: true, id: 'sub_old' } }
    },
    passos: [{ receberJuntos: [
      { id: `evt_h_c${rodada}`, event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_a' } },
      { id: `evt_h_r${rodada}`, event: 'PAYMENT_RECEIVED', dateCreated: '2026-09-25 10:00:03', payment: { id: 'pay_a' } }
    ] }, { reprocessar: true }],
    atrasoDaAsaasMs: 20
  });
  igual(avisos(r.banco, 'criada').length, 1, `FP2A-1 (rodada ${rodada}): o contratante ouve \`criada\` UMA vez — duas passadas do mesmo charge não se intercalam`);
  igual(r.banco.assinaturas.filter((a) => a.id === 'sub_old').map((a) => a.status), ['cancelada'], `FP2A-2 (rodada ${rodada}): a antiga termina cancelada`);
}

/* ── C) o vínculo do charge à sessão é CAS ─────────────────────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linhaDaPopup({ charge_id: 'pay_primeiro' }), linhaDaPopup({ id: '5e5e5e5e-0000-4000-8000-000000000002', asaas_checkout_id: 'chk_b' })] },
    passos: [{ vincularCheckout: ['chk_a', 'pay_intruso'] }, { vincularCheckout: ['chk_b', 'pay_b'] }]
  });
  igual(r.resultados, [false, true], 'a sessão que já tem charge não aceita outro; a vazia aceita');
  igual(r.banco.cobrancas.find((c) => c.asaas_checkout_id === 'chk_a').charge_id, 'pay_primeiro', 'o charge da primeira cobrança não é sobrescrito');
}

console.log(`assinatura-nasce-inteira: ${checagens} checagens OK`);
