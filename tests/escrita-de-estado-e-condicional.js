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

console.log(`escrita-de-estado-e-condicional: ${checagens} checagens OK`);
