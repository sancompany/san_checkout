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

async function rodar({ tabelas, falhas = {}, asaas = {}, passos }) {
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
