#!/usr/bin/env node
/**
 * tests/escrita-de-estado-e-condicional.js
 *
 * CLASSE CR-07 da remediação da Estação 6: escrita de estado financeiro
 * fora do CAS. Três escritores que gravavam "por cima" do que estivesse na
 * linha, sem conferir o estado que eles mesmos tinham lido:
 *
 *   SEC-022 — a conciliação do contratante (`GET /cobranca/...`) relia a
 *   Asaas e gravava `confirmado` incondicionalmente. Um estorno que o
 *   webhook gravasse entre a leitura e a escrita era apagado.
 *
 *   SEC-025 — `liberarReservaCobranca` apagava a reserva pelo id, sem
 *   condição. Entre decidir liberar e o `delete`, a linha podia ter
 *   ganhado um pagamento — e apagá-la era perder um pagamento de vista.
 *
 *   SEC-020 — os eventos de autorização do Pix Automático gravavam
 *   `confirmado`/`cancelado` sem olhar o estado, e a reentrega repetia o
 *   aviso ao contratante.
 *
 * Código real (controlador, serviços, receptor do webhook), banco falso,
 * Asaas roteirizada. A corrida é SIMULADA de verdade: a Asaas de mentira
 * grava o estorno no banco no meio da chamada, como o webhook faria.
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

const LOJA = { id: 'loja', nome: 'Loja', api_key: 'segredo-da-loja', webhook_url: 'https://loja.exemplo/hook', metodos_habilitados: null, arquivado_em: null };
const linha = (extra = {}) => ({
  id: '7a7a7a7a-0000-4000-8000-000000000001', contratante_id: 'loja', pedido_id: 'ped_1', metodo_pagamento: 'pix', status: 'pendente',
  charge_id: 'pay_1', asaas_checkout_id: null, valor_cobrado: 50, valor_cheio: 50, ambiente: 'sandbox', e_teste: false,
  criado_em: new Date(Date.now() - 600_000).toISOString(), contratantes: LOJA, ...extra
});

async function rodar({ tabelas, codigo }) {
  const pasta = mkdtempSync(join(tmpdir(), 'escrita-condicional-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [LOJA], assinaturas: [], outbox_notificacoes: [], webhook_inbox: [], ...tabelas } }));
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', BANCO_FALSO_ARQUIVO: arquivo }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  if (status !== 0) throw new Error(`processo filho falhou:\n${stderr}`);
  return { saida: JSON.parse(stdout.trim().split('\n').pop()), banco: JSON.parse(readFileSync(arquivo, 'utf8')).tabelas };
}

/* A Asaas de mentira: `GET /v3/payments/pay_1` responde CONFIRMED — e, se
   pedido, grava no banco o estorno que o webhook teria gravado ENQUANTO a
   conciliação esperava a resposta. */
const asaas = (estornarNoMeio) => `
  const { readFileSync, writeFileSync } = await import('node:fs');
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api-sandbox.asaas.com') return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    if ((opcoes.method ?? 'GET') === 'GET' && u.pathname === '/v3/payments/pay_1') {
      if (${estornarNoMeio}) {
        const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
        const l = estado.tabelas.cobrancas.find((c) => c.charge_id === 'pay_1');
        l.status = 'estornado'; l.valor_estornado = 50;
        writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
      }
      return new Response(JSON.stringify({ id: 'pay_1', status: 'CONFIRMED', value: 50 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"errors":[{"description":"fora do roteiro"}]}', { status: 500 });
  };
`;
const consultar = `
  const { consultarCobranca } = await import('./src/controllers/cobrancaConsultaController.js');
  const res = { _s: 200, _j: null, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; } };
  await consultarCobranca({ params: { contratanteId: 'loja', pedidoId: 'ped_1' }, get: (h) => (h.toLowerCase() === 'x-checkout-key' ? 'segredo-da-loja' : undefined) }, res);
  console.log(JSON.stringify({ http: res._s, status: res._j?.status }));
`;

/* ── SEC-022, controle: sem corrida, a conciliação confirma ─────────── */
{
  const { saida, banco } = await rodar({ tabelas: { cobrancas: [linha()] }, codigo: asaas(false) + consultar });
  igual([saida.http, saida.status], [200, 'confirmado'], 'controle: pago na Asaas e pendente aqui, a conciliação confirma');
  igual(banco.cobrancas[0].status, 'confirmado', 'e grava');
  ok(Boolean(banco.cobrancas[0].confirmado_em), 'com o carimbo de confirmação');
}

/* ── C1-10: a conciliação pela tela tem o mesmo binding de valor do webhook ── */
{
  const { saida, banco } = await rodar({ tabelas: { cobrancas: [linha({ valor_cobrado: 60, valor_cheio: 60 })] }, codigo: asaas(false) + consultar });
  igual(banco.cobrancas[0].status, 'pendente', 'C1-10: pago na Asaas por 50 e cobrado aqui por 60 — a consulta NÃO confirma sozinha');
  igual(saida.status, 'pendente', 'e a tela não diz "pago"');
}

/* ── SEC-022: o estorno que chegou no meio NÃO é apagado ────────────── */
{
  const { saida, banco } = await rodar({ tabelas: { cobrancas: [linha()] }, codigo: asaas(true) + consultar });
  igual(banco.cobrancas[0].status, 'estornado', 'SEC-022: o estorno gravado durante a consulta à Asaas sobrevive — o `confirmado` atrasado perdeu a corrida');
  igual(banco.cobrancas[0].valor_estornado, 50, 'e o valor estornado também');
  ok(saida.status !== 'confirmado', `e o contratante não ouve "confirmado" de uma cobrança estornada (${saida.status})`);
}

/* ── SEC-025: a reserva só é apagada enquanto é reserva ─────────────── */
{
  const reservaPura = { id: 'res-pura', contratante_id: 'loja', pedido_id: 'p1', metodo_pagamento: 'pix', status: 'pendente', charge_id: null, asaas_checkout_id: null };
  const comPagamento = { ...reservaPura, id: 'res-paga', pedido_id: 'p2', charge_id: 'pay_novo' };
  const comSessao = { ...reservaPura, id: 'res-sessao', pedido_id: 'p3', metodo_pagamento: 'cartao_credito', asaas_checkout_id: 'chk_1' };
  const confirmada = { ...reservaPura, id: 'res-confirmada', pedido_id: 'p4', status: 'confirmado' };
  const { saida, banco } = await rodar({
    tabelas: { cobrancas: [reservaPura, comPagamento, comSessao, confirmada] },
    codigo: `
      const { liberarReservaCobranca } = await import('./src/services/cobrancaService.js');
      const r = [];
      for (const id of ['res-pura', 'res-paga', 'res-sessao', 'res-confirmada']) r.push(await liberarReservaCobranca(id));
      console.log(JSON.stringify(r));
    `
  });
  igual(saida, [true, false, false, false], 'SEC-025: só a reserva pura é apagada; as outras três respondem que não');
  igual(banco.cobrancas.map((c) => c.id).sort(), ['res-confirmada', 'res-paga', 'res-sessao'], 'a que ganhou pagamento, a que ganhou sessão e a confirmada continuam no banco');
}

/* ── SEC-020: Pix Automático por CAS ─────────────────────────────────── */
{
  const autorizacao = (status) => ({ ...linha({ id: `aut-${status}`, metodo_pagamento: 'assinatura_pix', status, charge_id: null, asaas_checkout_id: `aut_${status}`, plano_id: 'plano_pro', documento: '11144477735', ciclo: 'MONTHLY' }) });
  const eventos = (id, tipo) => ({ id: `evt_${id}_${tipo}`, event: tipo, dateCreated: '2026-09-25 10:00:00', authorization: { id } });
  const { saida, banco } = await rodar({
    tabelas: { cobrancas: [autorizacao('pendente'), autorizacao('estornado')] },
    codigo: `
      globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      const wc = await import('./src/controllers/webhookController.js');
      const r = [];
      for (const corpo of ${JSON.stringify([
        eventos('aut_pendente', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED'),
        { ...eventos('aut_pendente', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED'), id: 'evt_reentregue' },
        eventos('aut_estornado', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED'),
        eventos('aut_estornado', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED')
      ])}) {
        const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
        await wc.receberWebhookAsaas({ body: corpo, get: () => undefined, ip: '52.67.12.206' }, res);
        r.push(res._s);
      }
      await new Promise((x) => setTimeout(x, 200));
      console.log(JSON.stringify(r));
    `
  });
  ok(saida.every((s) => s === 200), `o receptor aceitou os quatro eventos (${saida})`);
  const porId = Object.fromEntries(banco.cobrancas.map((c) => [c.id, c.status]));
  igual(porId['aut-pendente'], 'confirmado', 'controle: autorização ativada sobre `pendente` confirma');
  igual(porId['aut-estornado'], 'estornado', 'SEC-020: nem ativar nem encerrar grava por cima de um estorno');
  const criadas = (banco.outbox_notificacoes ?? []).filter((o) => o.evento === 'criada');
  igual(criadas.length, 1, 'SEC-020: a reentrega do mesmo ACTIVATED não repete o aviso `criada` ao contratante');
  igual((banco.outbox_notificacoes ?? []).filter((o) => o.evento === 'cancelada').length, 0, 'e o CANCELLED sobre um estorno não avisa `cancelada`');
}

/* ── C1-09: a refeitura depois de a transição já ter sido gravada ──────
   A passagem que gravou `pendente → confirmado` e morreu antes de criar a
   assinatura e o aviso deixava a linha `confirmado` e mais nada: a
   refeitura via "não está pendente" e saía. */
{
  const autorizacao = (id, status) => ({ ...linha({ id, metodo_pagamento: 'assinatura_pix', status, charge_id: null, asaas_checkout_id: id, plano_id: 'plano_pro', documento: '11144477735', ciclo: 'MONTHLY' }) });
  const ev = (id, tipo, n) => ({ id: `evt_${id}_${n}`, event: tipo, dateCreated: '2026-09-25 10:00:00', authorization: { id } });
  const { saida, banco } = await rodar({
    tabelas: { cobrancas: [autorizacao('aut_meio_ativada', 'confirmado'), autorizacao('aut_meio_encerrada', 'cancelado')] },
    codigo: `
      globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      const wc = await import('./src/controllers/webhookController.js');
      const r = [];
      for (const corpo of ${JSON.stringify([
        ev('aut_meio_ativada', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 1),
        ev('aut_meio_ativada', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 2),
        ev('aut_meio_encerrada', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 1)
      ])}) {
        const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
        await wc.receberWebhookAsaas({ body: corpo, get: () => undefined, ip: '52.67.12.206' }, res);
        r.push(res._s);
      }
      await new Promise((x) => setTimeout(x, 200));
      console.log(JSON.stringify(r));
    `
  });
  ok(saida.every((x) => x === 200), 'o receptor aceitou os três');
  ok((banco.assinaturas ?? []).some((a) => a.id === 'aut_meio_ativada'), 'C1-09: a refeitura sobre `confirmado` cria a assinatura que ficou faltando');
  igual((banco.outbox_notificacoes ?? []).filter((o) => o.evento === 'criada').length, 1, 'C1-09: e manda o `criada` — uma vez só, mesmo com duas entregas');
  igual((banco.outbox_notificacoes ?? []).filter((o) => o.evento === 'cancelada').length, 1, 'C1-09: o encerramento que não chegou a avisar avisa na refeitura');
  igual(Object.fromEntries(banco.cobrancas.map((c) => [c.id, c.status])), { aut_meio_ativada: 'confirmado', aut_meio_encerrada: 'cancelado' }, 'e nenhum status se move');
}

/* ── C2-L1: a refeitura NÃO passa por cima da assinatura que já existe ── */
{
  const autorizacao = { ...linha({ id: 'aut_pausada', metodo_pagamento: 'assinatura_pix', status: 'confirmado', charge_id: null, asaas_checkout_id: 'aut_pausada', plano_id: 'plano_pro', documento: '11144477735', ciclo: 'MONTHLY' }) };
  const { banco } = await rodar({
    tabelas: { cobrancas: [autorizacao], assinaturas: [{ id: 'aut_pausada', contratante_id: 'loja', plano_id: 'plano_novo', documento: '11144477735', status: 'pausada', valor: 80, ciclo: 'MONTHLY' }] },
    codigo: `
      globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      const wc = await import('./src/controllers/webhookController.js');
      const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
      await wc.receberWebhookAsaas({ body: { id: 'evt_reentrega_tardia', event: 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', dateCreated: '2026-09-25 10:00:00', authorization: { id: 'aut_pausada' } }, get: () => undefined, ip: '52.67.12.206' }, res);
      await new Promise((x) => setTimeout(x, 200));
      console.log(JSON.stringify(res._s));
    `
  });
  const a = banco.assinaturas.find((x) => x.id === 'aut_pausada');
  igual([a.status, a.plano_id, a.valor], ['pausada', 'plano_novo', 80], 'C2-L1: a assinatura pausada e trocada de plano continua como estava');
  igual((banco.outbox_notificacoes ?? []).filter((o) => o.evento === 'criada').length, 0, 'C2-L1: e nenhum `criada` de novo');
}

/* ── D-1: o PAYMENT_REFUND_DENIED reabre a operação que registrou o pedido ── */
{
  const { banco } = await rodar({
    tabelas: {
      cobrancas: [linha({ id: 'b-negado', metodo_pagamento: 'boleto', status: 'estorno_solicitado', charge_id: 'pay_negado' })],
      estornos: [
        { id: 'op-negada', cobranca_id: 'b-negado', contratante_id: 'loja', charge_id: 'pay_negado', chave_idempotencia: 'total-b-negado', valor_centavos: 5000, total: true, estado: 'CONFIRMED', status_resultado: 'estorno_solicitado', marcador: 'm1' },
        { id: 'op-de-outra', cobranca_id: 'outra', contratante_id: 'loja', charge_id: 'pay_x', chave_idempotencia: 'k', valor_centavos: 100, total: false, estado: 'CONFIRMED', status_resultado: 'estorno_solicitado', marcador: 'm2' },
        /* CP2-10: um estorno que DE FATO devolveu dinheiro, na MESMA cobrança */
        { id: 'op-que-devolveu', cobranca_id: 'b-negado', contratante_id: 'loja', charge_id: 'pay_negado', chave_idempotencia: 'parcial-30', valor_centavos: 3000, total: false, estado: 'CONFIRMED', status_resultado: 'estornado_parcialmente', marcador: 'm4' }
      ]
    },
    codigo: `
      globalThis.fetch = async (url, opcoes = {}) => {
        const u = new URL(String(url));
        if (u.hostname === 'api-sandbox.asaas.com' && u.pathname === '/v3/payments/pay_negado') return new Response(JSON.stringify({ id: 'pay_negado', status: 'RECEIVED', value: 50, externalReference: 'reserva-b-negado' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const wc = await import('./src/controllers/webhookController.js');
      const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
      await wc.receberWebhookAsaas({ body: { id: 'evt_negado', event: 'PAYMENT_REFUND_DENIED', dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_negado' } }, get: () => undefined, ip: '52.67.12.206' }, res);
      await new Promise((x) => setTimeout(x, 200));
      console.log(JSON.stringify(res._s));
    `
  });
  const op = (id) => banco.estornos.find((o) => o.id === id);
  igual(banco.cobrancas[0].status, 'estorno_negado', 'controle: a negativa foi aplicada');
  igual(op('op-negada').estado, 'FAILED_RETRYABLE', 'D-1: a operação do pedido negado reabre — a mesma chave pode pedir de novo');
  igual(op('op-de-outra').estado, 'CONFIRMED', 'e a de outra cobrança não é tocada');
  igual(op('op-que-devolveu').estado, 'CONFIRMED', 'CP2-10: e o estorno que DEVOLVEU dinheiro, na mesma cobrança, nunca é reaberto — reabrir mandaria o valor de novo');
}

/* ── CP1-01: a negativa VELHA não reabre o pedido que está vivo na Asaas ──
   Passada limpa 1: a negativa do 1º pedido, reprocessada depois de um 2º
   pedido aceito, marcava `estorno_negado` e reabria a operação viva — o
   próximo `/estornar` mandaria o estorno de novo. A negativa só vale com
   o pagamento DE VOLTA a pago na Asaas. */
{
  const { banco } = await rodar({
    tabelas: {
      cobrancas: [linha({ id: 'b-vivo', metodo_pagamento: 'boleto', status: 'estorno_solicitado', charge_id: 'pay_vivo' })],
      estornos: [{ id: 'op-viva', cobranca_id: 'b-vivo', contratante_id: 'loja', charge_id: 'pay_vivo', chave_idempotencia: 'total-b-vivo', valor_centavos: 5000, total: true, estado: 'CONFIRMED', status_resultado: 'estorno_solicitado', marcador: 'm3' }]
    },
    codigo: `
      globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        if (u.hostname === 'api-sandbox.asaas.com' && u.pathname === '/v3/payments/pay_vivo') return new Response(JSON.stringify({ id: 'pay_vivo', status: 'REFUND_REQUESTED', value: 50, externalReference: 'reserva-b-vivo' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      console.error = () => {};
      const wc = await import('./src/controllers/webhookController.js');
      const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
      await wc.receberWebhookAsaas({ body: { id: 'evt_negativa_velha', event: 'PAYMENT_REFUND_DENIED', dateCreated: '2026-09-25 09:00:00', payment: { id: 'pay_vivo' } }, get: () => undefined, ip: '52.67.12.206' }, res);
      await new Promise((x) => setTimeout(x, 200));
      console.log(JSON.stringify(res._s));
    `
  });
  igual(banco.cobrancas[0].status, 'estorno_solicitado', 'CP1-01: com a Asaas mostrando o pedido de estorno em curso, a negativa não é aplicada');
  igual(banco.estornos[0].estado, 'CONFIRMED', 'CP1-01: e a operação viva não é reaberta — nada de segundo estorno');
  igual((banco.outbox_notificacoes ?? []).filter((o) => /estorno_negado/.test(JSON.stringify(o.payload ?? {}))).length, 0, 'e o contratante não recebe um "negado" falso');
}

/* ---- C1-08: a guarda do estorno, na função REAL contra o banco falso ----
   "Só grava sobre status estornável, e o valor estornado só sobe" (SEC-022)
   era provada numa CÓPIA escrita à mão da função — e o banco falso nem
   poderia prová-la: comparava `lt` como texto. */
{
  const { saida, banco } = await rodar({
    tabelas: { cobrancas: [
      linha({ id: 'e-sobe', charge_id: 'pay_sobe', status: 'estornado_parcialmente', valor_estornado: 5 }),
      linha({ id: 'e-desce', charge_id: 'pay_desce', status: 'estornado_parcialmente', valor_estornado: 30 }),
      linha({ id: 'e-nulo', charge_id: 'pay_nulo', status: 'confirmado', valor_estornado: null }),
      linha({ id: 'e-pendente', charge_id: 'pay_pend', status: 'pendente', valor_estornado: null })
    ] },
    codigo: `
      const { registrarEstorno } = await import('./src/services/cobrancaService.js');
      const r = {};
      r.sobe = await registrarEstorno('pay_sobe', { status: 'estornado_parcialmente', valorEstornado: 30 });
      r.desce = await registrarEstorno('pay_desce', { status: 'estornado_parcialmente', valorEstornado: 5 });
      r.nulo = await registrarEstorno('pay_nulo', { status: 'estornado_parcialmente', valorEstornado: 20 });
      r.pendente = await registrarEstorno('pay_pend', { status: 'estornado', valorEstornado: 50 });
      console.log(JSON.stringify(r));
    `
  });
  igual(saida, { sobe: true, desce: false, nulo: true, pendente: false }, 'SEC-022/C1-08: sobe de 5 para 30 grava; de 30 para 5 não; sobre nulo grava; sobre `pendente` nunca');
  const v = Object.fromEntries(banco.cobrancas.map((c) => [c.id, [c.status, c.valor_estornado]]));
  igual(v['e-sobe'], ['estornado_parcialmente', 30], 'o valor subiu');
  igual(v['e-desce'], ['estornado_parcialmente', 30], 'o valor NÃO desceu');
  igual(v['e-pendente'], ['pendente', null], 'e o não-estornável ficou intocado');
}

/* ---- C1-12: o banco falso responde como o PostgREST onde isso decide teste ---- */
{
  const { saida } = await rodar({
    tabelas: { cobrancas: [linha({ id: 'f1', charge_id: 'pay_f1', status: 'confirmado' }), linha({ id: 'f2', charge_id: 'pay_f2', status: 'cancelado', pedido_id: 'ped_1' })] },
    codigo: `
      const { supabase } = await import('./src/config/supabase.js');
      const duas = await supabase.from('cobrancas').select('*').eq('pedido_id', 'ped_1').maybeSingle();
      const naoIn = await supabase.from('cobrancas').select('id').or('status.not.in.(pendente,cancelado)');
      const dup = await supabase.from('cobrancas').update({ charge_id: 'pay_f1' }).eq('id', 'f2').select('id');
      const proj = await supabase.from('cobrancas').update({ atualizado_em: 'x' }).eq('id', 'f1').select('id');
      const umaSo = await supabase.from('cobrancas').update({ ciclo: 'MUDOU' }).eq('pedido_id', 'ped_1').select('id').maybeSingle();
      const juntas = await supabase.from('cobrancas').update({ charge_id: 'pay_igual' }).eq('pedido_id', 'ped_1').select('id');
      const { readFileSync } = await import('node:fs');
      const depois = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8')).tabelas.cobrancas;
      console.log(JSON.stringify({ duas: duas.error?.code ?? null, naoIn: naoIn.data.map((l) => l.id), dup: dup.error?.code ?? null, proj: proj.data,
        umaSo: umaSo.error?.code ?? null, gravouMesmoAssim: depois.some((l) => l.ciclo === 'MUDOU'), juntas: juntas.error?.code ?? null, chargesDepois: depois.map((l) => l.charge_id).sort() }));
    `
  });
  igual(saida.duas, 'PGRST116', 'maybeSingle com duas linhas é erro, não "a primeira"');
  igual(saida.naoIn, ['f1'], '`status.not.in.(…)` dentro de .or() é entendido, não lido como coluna `status.not`');
  igual(saida.dup, '23505', 'o UPDATE também respeita o índice único');
  igual(saida.proj, [{ id: 'f1' }], "`update().select('id')` devolve só o id");
  igual([saida.umaSo, saida.gravouMesmoAssim], ['PGRST116', false], 'C2-L2b: maybeSingle numa escrita que casa duas linhas é erro E nada é gravado (a transação volta)');
  igual(saida.juntas, '23505', 'C2-L3b: duas linhas do MESMO update indo para a mesma chave única também violam');
  igual(saida.chargesDepois, ['pay_f1', 'pay_f2'], 'e nenhuma das duas foi gravada');
}

/* ---- CP3: o filtro de CADA escrita condicional, isolado, na função real ----
   Achado da passada CP3 por sabotagem: tirar o `.eq('status', …)` (ou o
   `.eq('mutation_version', …)`) destes escritores deixava a suíte inteira
   verde. As guardas de cima (quem chama lê antes, o webhook confere na
   Asaas) escondiam a falta — mas a leitura e a escrita não são atômicas,
   e o filtro da escrita é a ÚNICA coisa que decide a corrida. Aqui cada
   escritor recebe exatamente a linha que "mudou entre ler e gravar", ao
   lado de um controle que tem de passar, para o teste não aprovar um
   escritor que simplesmente nunca grava. */
{
  const futuro = new Date(Date.now() + 3600_000).toISOString();
  const passado = new Date(Date.now() - 3600_000).toISOString();
  const intencao = (id, status, expira_em = futuro) => ({ id, assinatura_id: `sub-${id}`, status, expira_em, charge_id: null, tentativas_sweeper: 0 });
  const { saida, banco } = await rodar({
    tabelas: {
      cobrancas: [
        linha({ id: 'chk-pend', pedido_id: 'ped_chk_1', metodo_pagamento: 'cartao_credito', charge_id: null, asaas_checkout_id: 'chk_pend', status: 'pendente' }),
        linha({ id: 'chk-est', pedido_id: 'ped_chk_2', metodo_pagamento: 'cartao_credito', charge_id: null, asaas_checkout_id: 'chk_est', status: 'estornado' })
      ],
      intencoes_troca_plano: [
        intencao('ti-pendente', 'PENDING_APPROVAL'),
        intencao('ti-concluida', 'COMPLETED'),
        intencao('ti-vencida', 'PENDING_APPROVAL', passado),
        intencao('ti-desconhecida', 'PAYMENT_UNKNOWN'),
        intencao('ti-recusada', 'PAYMENT_DECLINED'),
        intencao('ti-pendente-2', 'PENDING_APPROVAL'),
        intencao('ti-processando', 'PROCESSING_PAYMENT')
      ],
      assinaturas: [{ id: 'as-v3', contratante_id: 'loja', plano_id: 'plano_a', documento: '11144477735', status: 'ativa', valor: 50, ciclo: 'MONTHLY', mutation_version: 3 }],
      webhook_inbox: [
        { id: 'in-falhou', impressao_digital: 'd1', status: 'falhou', ultimo_erro: 'esgotado', proxima_tentativa_em: null },
        { id: 'in-processando', impressao_digital: 'd2', status: 'processando', ultimo_erro: null, proxima_tentativa_em: futuro },
        { id: 'in-recebido', impressao_digital: 'd3', status: 'recebido', ultimo_erro: null, proxima_tentativa_em: futuro }
      ]
    },
    codigo: `
      const cs = await import('./src/services/cobrancaService.js');
      const ti = await import('./src/services/trocaIntencaoService.js');
      const as = await import('./src/services/assinaturaService.js');
      const inbox = await import('./src/services/webhookInboxService.js');
      const id = (l) => (l ? l.id : null);
      const r = {};
      r.chkControle = await cs.aplicarTransicaoPorCheckoutId('chk_pend', { de: 'pendente', para: 'confirmado' });
      r.chkEstornado = await cs.aplicarTransicaoPorCheckoutId('chk_est', { de: 'pendente', para: 'confirmado' });
      r.reivControle = id(await ti.reivindicarProcessamento('ti-pendente'));
      r.reivConcluida = id(await ti.reivindicarProcessamento('ti-concluida'));
      r.reivVencida = id(await ti.reivindicarProcessamento('ti-vencida'));
      r.confControle = id(await ti.marcarConfirmada('ti-desconhecida'));
      r.confRecusada = id(await ti.marcarConfirmada('ti-recusada'));
      r.staleControle = id(await ti.marcarStaleSePendente('ti-pendente-2'));
      r.staleProcessando = id(await ti.marcarStaleSePendente('ti-processando'));
      const troca = { planoNovoId: 'plano_b', planoAnteriorId: 'plano_a', valor: 80, ciclo: 'MONTHLY' };
      r.mvVelho = await as.aplicarTrocaDePlano('as-v3', { ...troca, mutationVersionEsperada: 2 });
      r.mvCerto = await as.aplicarTrocaDePlano('as-v3', { ...troca, valor: 90, mutationVersionEsperada: 3 });
      r.reconciladas = await inbox.marcarReconciladas(['in-falhou', 'in-processando', 'in-recebido']);
      console.log(JSON.stringify(r));
    `
  });
  const st = (tabela) => Object.fromEntries(banco[tabela].map((l) => [l.id, l.status]));

  /* cs-porcheckout-cas: o webhook da pop-up lê `pendente` e grava
     `confirmado`; um estorno gravado no meio seria apagado sem o filtro. */
  igual(saida.chkControle, true, 'CP3 controle: `pendente` → `confirmado` pelo checkout id grava');
  igual([saida.chkEstornado, st('cobrancas')['chk-est']], [false, 'estornado'], 'CP3 cs-porcheckout-cas: aplicarTransicaoPorCheckoutId com `de: pendente` NÃO grava por cima de um estorno que chegou no meio — sem o `.eq(status, de)` o estorno virava `confirmado`');

  /* b2-ti-reiv-*: a reivindicação é a porta da cobrança do acerto. Sem o
     filtro de status, a intenção CONCLUÍDA volta a PROCESSING_PAYMENT e
     o acerto é cobrado de novo; sem o de prazo, o link vencido cobra. */
  igual(saida.reivControle, 'ti-pendente', 'CP3 controle: intenção pendente e no prazo é reivindicada');
  igual([saida.reivConcluida, st('intencoes_troca_plano')['ti-concluida']], [null, 'COMPLETED'], 'CP3 b2-ti-reiv-status: reivindicarProcessamento recusa intenção que não está PENDING_APPROVAL — a concluída não volta a cobrar o acerto');
  igual([saida.reivVencida, st('intencoes_troca_plano')['ti-vencida']], [null, 'PENDING_APPROVAL'], 'CP3 b2-ti-reiv-exp: reivindicarProcessamento recusa intenção com `expira_em` no passado — link vencido não cobra');

  /* b2-ti-cas: a transição genérica, nos dois ramos (lista e status único). */
  igual(saida.confControle, 'ti-desconhecida', 'CP3 controle: PAYMENT_UNKNOWN → PAYMENT_CONFIRMED avança');
  igual([saida.confRecusada, st('intencoes_troca_plano')['ti-recusada']], [null, 'PAYMENT_DECLINED'], 'CP3 b2-ti-cas: marcarConfirmada (origem em LISTA) não transforma uma recusa em confirmação — o plano seria aplicado sem o acerto pago');
  igual(saida.staleControle, 'ti-pendente-2', 'CP3 controle: PENDING_APPROVAL → STALE avança');
  igual([saida.staleProcessando, st('intencoes_troca_plano')['ti-processando']], [null, 'PROCESSING_PAYMENT'], 'CP3 b2-ti-cas: marcarStaleSePendente (origem ÚNICA) não derruba uma intenção que já está cobrando');

  /* b2-as-mv-cas: a cerca de concorrência otimista da troca de plano. */
  const as = banco.assinaturas.find((a) => a.id === 'as-v3');
  igual(saida.mvVelho, false, 'CP3 b2-as-mv-cas: aplicarTrocaDePlano com mutation_version VELHO (2, a linha está em 3) recusa — nada de sobrescrever às cegas o que mudou depois do retrato');
  igual([saida.mvCerto, as.mutation_version, as.valor], [true, 4, 90], 'CP3 controle: com o mutation_version certo grava, e a versão sobe uma vez só (a escrita velha não gravou nada)');

  /* b2-in-reconciladas-falhou: fechar como "reconciliada" só a linha que
     ESGOTOU. A que está sendo reprocessada agora (ou foi reaberta) seria
     marcada `processado` e o evento nunca mais seria aplicado. */
  igual(saida.reconciladas, 1, 'CP3 b2-in-reconciladas-falhou: marcarReconciladas conta só a linha `falhou`');
  igual(st('webhook_inbox'), { 'in-falhou': 'processado', 'in-processando': 'processando', 'in-recebido': 'recebido' }, 'CP3 b2-in-reconciladas-falhou: a linha em reprocessamento e a reaberta continuam onde estavam — só a esgotada fecha');
}

console.log(`escrita-de-estado-e-condicional: ${checagens} checagens OK`);
