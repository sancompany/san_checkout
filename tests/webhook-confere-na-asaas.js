#!/usr/bin/env node
/**
 * tests/webhook-confere-na-asaas.js
 *
 * CLASSE CR-05 da remediação da Estação 6 (SEC-007, SEC-008, SEC-019,
 * JULES-004, SEC-023, SEC-024): estado financeiro aceito do CORPO do
 * evento, e evento fora de ordem tratado como descartável.
 *
 * Os furos, como estavam:
 *   - o único portão do webhook era o token estático do header. Vazado
 *     ele, um `PAYMENT_CONFIRMED` com um `payment.id` real confirmava a
 *     cobrança sem pagamento; o vínculo (`externalReference`,
 *     `checkoutSession`), o valor do ciclo e o carimbo vinham do corpo;
 *   - um `PAYMENT_REFUNDED` que chegasse antes da confirmação era
 *     "transição não permitida" e virava `processado` — a cobrança ficava
 *     paga com o dinheiro devolvido;
 *   - a liquidação D+30 de um cartão em disputa tirava a cobrança de
 *     `chargeback`;
 *   - evento esgotado na inbox deixava a cobrança divergente para sempre;
 *   - a reivindicação da inbox ignorava o recuo, e o reenvio não zerava
 *     as tentativas.
 *
 * Roda o CÓDIGO REAL — receptor, inbox, outbox, máquina de estados,
 * registro de erro e o reconciliador dirigido — num processo filho, com
 * o banco falso (`tests/banco-falso/`) e a Asaas substituída por um
 * `fetch` que segue um roteiro e registra cada chamada.
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

const LOJA = { webhook_url: 'https://loja.exemplo/hook', api_key: 'segredo-da-loja', nome: 'Loja' };
const agoraMenos = (min) => new Date(Date.now() - min * 60_000).toISOString();
const agoraMais = (min) => new Date(Date.now() + min * 60_000).toISOString();
let seq = 0;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Uma linha de `cobrancas` da `loja`, cada uma no seu pedido. */
const linha = (extra) => ({
  contratante_id: 'loja', pedido_id: `ped_${(seq += 1)}`, ambiente: 'sandbox', e_teste: false,
  valor_cobrado: 10, cancelamento_tentativas: 0, criado_em: agoraMenos(30), atualizado_em: agoraMenos(30),
  contratantes: LOJA, // o banco falso não faz join: a linha já traz o que o `select('*, contratantes(...)')` traria
  ...extra
});

const evento = (tipo, chargeId, extra = {}, raiz = {}) => ({
  id: `evt_${tipo}_${chargeId}_${(seq += 1)}`, event: tipo, dateCreated: '2026-09-25 10:00:00', payment: { id: chargeId, ...extra }, ...raiz
});

/** Linha esgotada da inbox (as oito tentativas gastas). */
const esgotada = (tipo, chargeId, extra = {}) => ({
  id: uuid(900 + (seq += 1)), provedor: 'asaas', impressao_digital: `asaas:evt_esgotado_${seq}`, evento_id_provedor: `evt_esgotado_${seq}`,
  tipo_evento: tipo, referencia_tipo: 'payment', referencia_id: chargeId, status: 'falhou', tentativas: 8,
  proxima_tentativa_em: null, recebido_em: agoraMenos(60), ultimo_erro: 'Asaas fora do ar', corpo_hash: 'x',
  corpo_minimo: { event: tipo, payment: { id: chargeId } }, ...extra
});

/* A Asaas, por status. `refunds: []` = a cobrança SEM estorno (lista presente e vazia). */
const naAsaas = (status, extra = {}) => ({ status: 200, corpo: { status, value: 10, deleted: false, refunds: [], ...extra } });

/**
 * Roda os `passos` num processo filho e devolve o banco final, as
 * chamadas feitas à Asaas, os erros lançados por passo e o que cada passo
 * devolveu.
 *   { webhook: corpo }         — processarWebhook(corpo)
 *   { receber: corpo }         — o receptor HTTP (inbox → processa → 200)
 *   { reprocessar: true }      — uma passada do worker da inbox
 *   { reconciliar: true }      — uma passada do reconciliador dirigido
 *   { vencerInbox: true }      — o relógio andou: todo recuo da inbox venceu
 *   { reivindicar: id }        — reivindicarProcessamento(id)
 *   { reivindicarEFalhar: id } — reivindica e grava uma falha, como o worker
 *   { reivindicarEnvio: id }   — outbox: reivindicarEnvio(id)
 *   { reenfileirar: id }       — o reenvio administrativo da inbox
 *   { vincularReserva: [id, dados] } — cobrancaService.vincularSessaoAReserva
 *   { esperar: ms }
 */
async function rodar({ tabelas = {}, asaas = {}, passos }) {
  const pasta = mkdtempSync(join(tmpdir(), 'webhook-asaas-'));
  const arquivo = join(pasta, 'banco.json');
  const cobrancas = (tabelas.cobrancas ?? []).map((c, i) => ({ id: uuid(i + 1), ...c }));
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [{ id: 'loja', ...LOJA }], ...tabelas, cobrancas } }));

  const codigo = `
    const roteiro = ${JSON.stringify(asaas)};
    const usadas = {};
    const chamadas = [];
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api-sandbox.asaas.com') {
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); // o contratante
      }
      const chave = (opcoes.method ?? 'GET') + ' ' + u.pathname;
      chamadas.push(chave);
      const lista = roteiro[chave];
      if (!lista) return new Response(JSON.stringify({ errors: [{ description: 'rota fora do roteiro: ' + chave }] }), { status: 500 });
      const i = Math.min(usadas[chave] ?? 0, lista.length - 1);
      usadas[chave] = (usadas[chave] ?? 0) + 1;
      const r = lista[i];
      if (r.timeout) { const e = new Error('abortado'); e.name = 'AbortError'; throw e; }
      const corpo = r.corpo && typeof r.corpo === 'object' && !Array.isArray(r.corpo) ? { id: u.pathname.split('/')[3], ...r.corpo } : (r.corpo ?? {});
      return new Response(JSON.stringify(corpo), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    const wc = await import('./src/controllers/webhookController.js');
    const inbox = await import('./src/services/webhookInboxService.js');
    const outbox = await import('./src/services/outboxService.js');
    const cobrancas = await import('./src/services/cobrancaService.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const erros = [];
    const resultados = [];
    const respostaFalsa = () => ({ _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } });
    for (const [indice, passo] of ${JSON.stringify(passos)}.entries()) {
      try {
        if (passo.webhook) resultados.push(await wc.processarWebhook(passo.webhook) ?? null);
        if (passo.receber) {
          const res = respostaFalsa();
          await wc.receberWebhookAsaas({ body: passo.receber, get: () => undefined, ip: '52.67.12.206' }, res);
          resultados.push({ status: res._status, json: res._json });
        }
        if (passo.reprocessar) resultados.push(await wc.reprocessarInbox());
        if (passo.reconciliar) resultados.push(await wc.reconciliarDivergenciasUmaVez());
        if (passo.vencerInbox) {
          const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
          for (const l of estado.tabelas.webhook_inbox ?? []) if (l.proxima_tentativa_em) l.proxima_tentativa_em = new Date(Date.now() - 1000).toISOString();
          writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
          resultados.push(null);
        }
        if (passo.reivindicar) resultados.push((await inbox.reivindicarProcessamento(passo.reivindicar))?.id ?? null);
        if (passo.reivindicarEFalhar) {
          const l = await inbox.reivindicarProcessamento(passo.reivindicarEFalhar);
          resultados.push(l ? await inbox.marcarFalha(l.id, l.tentativas, 'falhou de novo') : 'nao-reivindicada');
        }
        if (passo.reivindicarEnvio) resultados.push((await outbox.reivindicarEnvio(passo.reivindicarEnvio))?.id ?? null);
        if (passo.reenfileirar) resultados.push(await inbox.reenfileirar(passo.reenfileirar));
        if (passo.vincularReserva) resultados.push(await cobrancas.vincularSessaoAReserva(...passo.vincularReserva));
        if (passo.esperar) { await new Promise((r) => setTimeout(r, passo.esperar)); resultados.push(null); }
      } catch (e) { erros.push({ indice, mensagem: e.message }); resultados.push('LANCOU'); }
    }
    await new Promise((r) => setTimeout(r, 200)); // o disparo fora do fluxo e a outbox terminam
    console.log(JSON.stringify({ chamadas, erros, resultados }));
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
  const saida = JSON.parse(stdout.trim().split('\n').pop());
  const banco = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas;
  const porCharge = (id) => banco.cobrancas.find((l) => l.charge_id === id);
  const avisos = (chargeId) => (banco.outbox_notificacoes ?? []).filter((o) => o.payload?.chargeId === chargeId);
  const errosRegistrados = () => banco.erros ?? [];
  const inboxPorId = (id) => (banco.webhook_inbox ?? []).find((l) => l.id === id);
  const inboxPorEvento = (idEvento) => (banco.webhook_inbox ?? []).find((l) => l.evento_id_provedor === idEvento);
  const erroDoPasso = (i) => saida.erros.find((e) => e.indice === i)?.mensagem ?? null;
  return { ...saida, banco, porCharge, avisos, errosRegistrados, inboxPorId, inboxPorEvento, erroDoPasso, stderr };
}

/* ── S1) confirmação FORJADA: a Asaas diz que não foi paga ───────────── */
{
  const corpo = evento('PAYMENT_CONFIRMED', 'pay_f');
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_f' })] },
    asaas: { 'GET /v3/payments/pay_f': [naAsaas('PENDING')] },
    passos: [{ receber: corpo }]
  });
  igual(r.resultados[0].status, 200, 'S1: o evento é guardado (200) — a Asaas não precisa reenviar');
  ok(r.chamadas.includes('GET /v3/payments/pay_f'), 'S1: o webhook PERGUNTOU à Asaas antes de mexer no dinheiro');
  igual(r.porCharge('pay_f').status, 'pendente', 'S1: confirmação sem pagamento na Asaas NÃO confirma nada');
  igual(r.avisos('pay_f').length, 0, 'S1: e o contratante não ouve "confirmado"');
  const linhaInbox = r.inboxPorEvento(corpo.id);
  igual(linhaInbox.status, 'falhou', 'S1: a linha fica na inbox para tentar de novo (evento prematuro confirma depois; forjado esgota)');
  ok(/sem respaldo na Asaas/.test(linhaInbox.ultimo_erro), `S1: com o motivo — ${linhaInbox.ultimo_erro}`);
}

/* ── S2) evento sobre cobrança que NÃO existe nesta conta da Asaas ───── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_n' })] },
    asaas: { 'GET /v3/payments/pay_n': [{ status: 404, corpo: { errors: [{ code: 'not_found' }] } }] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_n') }]
  });
  igual(r.porCharge('pay_n').status, 'pendente', 'S2: 404 na Asaas — nada aplicado');
  ok(r.errosRegistrados().some((e) => e.contexto === 'webhookController.semRespaldo' && /NÃO existe nesta conta/.test(e.mensagem)), 'S2: e vira linha em `erros` (token vazado ou outra integração) — não some calado');
  igual(r.erros, [], 'S2: não lança (não há o que tentar de novo)');
}

/* ── S3) o VÍNCULO vem da Asaas, não do corpo ─────────────────────────── */
{
  const r = await rodar({
    tabelas: {
      cobrancas: [
        linha({ id: uuid(31), metodo_pagamento: 'pix', status: 'pendente', charge_id: null }),
        linha({ id: uuid(32), metodo_pagamento: 'pix', status: 'pendente', charge_id: null })
      ]
    },
    asaas: { 'GET /v3/payments/pay_v': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(31)}` })] },
    // o corpo aponta para a OUTRA reserva
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_v', { externalReference: `reserva-${uuid(32)}` }) }]
  });
  const certa = r.banco.cobrancas.find((l) => l.id === uuid(31));
  const errada = r.banco.cobrancas.find((l) => l.id === uuid(32));
  igual([certa.charge_id, certa.status], ['pay_v', 'confirmado'], 'S3: a reserva amarrada é a que a ASAAS diz');
  igual([errada.charge_id ?? null, errada.status], [null, 'pendente'], 'S3: a que o corpo dizia não é tocada');
}

/* ── S4) VALOR: confirmação de outro valor não confirma sozinha ────────── */
{
  let r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_d', valor_cobrado: 10 })] },
    asaas: { 'GET /v3/payments/pay_d': [naAsaas('RECEIVED', { value: 1 })] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_d', { value: 10 }) }]
  });
  igual(r.porCharge('pay_d').status, 'pendente', 'S4: a Asaas diz R$ 1,00 contra R$ 10,00 daqui — não confirma');
  ok(/valor 1 na Asaas/.test(r.erroDoPasso(0) ?? ''), `S4: lança com os dois valores — ${r.erroDoPasso(0)}`);
  // controle: parcela de cartão (o `value` da Asaas é o da parcela) confirma
  r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_p1', asaas_checkout_id: 'chk_p', valor_cobrado: 20 })] },
    asaas: { 'GET /v3/payments/pay_p1': [naAsaas('CONFIRMED', { value: 5, installment: 'ins_1', checkoutSession: 'chk_p' })] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_p1') }]
  });
  igual(r.porCharge('pay_p1').status, 'confirmado', 'S4: controle — parcelado não compara parcela com total');
}

/* ── S5) SEC-019: a liquidação D+30 durante a disputa ──────────────────── */
{
  let r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'chargeback', charge_id: 'pay_cb', status_evento_em: agoraMenos(60 * 24) })] },
    asaas: { 'GET /v3/payments/pay_cb': [naAsaas('CHARGEBACK_DISPUTE')] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_cb', {}, { dateCreated: new Date().toISOString() }) }]
  });
  igual(r.porCharge('pay_cb').status, 'chargeback', 'S5: a cobrança em disputa CONTINUA em disputa — o RECEIVED é histórico');
  igual(r.avisos('pay_cb').length, 0, 'S5: e o contratante não ouve "confirmado" (não devolve acesso a quem contestou)');
  igual(r.erros, [], 'S5: obsoleto provado, sem barulho');
  // controle: a disputa foi GANHA — a Asaas volta a RECEIVED
  r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'chargeback', charge_id: 'pay_cb', status_evento_em: agoraMenos(60 * 24) })] },
    asaas: { 'GET /v3/payments/pay_cb': [naAsaas('RECEIVED')] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_cb', {}, { dateCreated: new Date().toISOString() }) }]
  });
  igual(r.porCharge('pay_cb').status, 'confirmado', 'S5: controle — disputa ganha na Asaas devolve a cobrança a confirmado');
}

/* ── S6) SEC-008: o estorno chega ANTES da confirmação ─────────────────── */
{
  const estorno = evento('PAYMENT_REFUNDED', 'pay_o', {}, { dateCreated: '2026-09-25 10:05:00' });
  const confirmacao = evento('PAYMENT_RECEIVED', 'pay_o', {}, { dateCreated: '2026-09-25 10:00:00' });
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_o' })] },
    asaas: { 'GET /v3/payments/pay_o': [naAsaas('REFUNDED', { refunds: [{ status: 'DONE', value: 10 }] })] },
    passos: [{ receber: estorno }, { receber: confirmacao }, { vencerInbox: true }, { reprocessar: true }]
  });
  const final = r.porCharge('pay_o');
  igual(final.status, 'estornado', 'S8: a cobrança termina ESTORNADA — antes terminava paga com o dinheiro devolvido');
  igual(Number(final.valor_estornado), 10, 'S8: com o valor que a Asaas devolveu');
  const fatos = r.avisos('pay_o').map((o) => o.chave_idempotencia).sort();
  igual(fatos, ['pedido|pay_o|confirmado', 'pedido|pay_o|estornado'], 'S8: o contratante ouve os dois fatos, cada um uma vez');
  igual(r.inboxPorEvento(estorno.id).status, 'processado', 'S8: o estorno prematuro não foi descartado — foi reprocessado');
  ok((r.banco.webhook_eventos ?? []).some((a) => /ainda não se aplica/.test(a.detalhe ?? '')), 'S8: e a primeira passada disse por quê (falta o estado anterior)');
  igual(r.resultados[3], { examinadas: 1, processadas: 1, falhas: 0 }, 'S8: o worker reprocessou exatamente o que faltava');
}

/* ── S7) carimbo NO FUTURO não congela a cobrança ─────────────────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_t' })] },
    asaas: { 'GET /v3/payments/pay_t': [naAsaas('RECEIVED'), naAsaas('REFUNDED', { refunds: [{ status: 'DONE', value: 10 }] })] },
    passos: [
      { webhook: evento('PAYMENT_CONFIRMED', 'pay_t', {}, { dateCreated: '2099-01-01 00:00:00' }) },
      // alvo `estorno_solicitado`, a Asaas já em REFUNDED: o respaldo existe e quem decide ordem é o carimbo
      { webhook: evento('PAYMENT_REFUND_IN_PROGRESS', 'pay_t', {}, { dateCreated: new Date(Date.now() + 5000).toISOString() }) }
    ]
  });
  igual(r.porCharge('pay_t').status, 'estorno_solicitado', 'S7: o evento seguinte VALE — um carimbo de 2099 teria feito todo evento real parecer "mais antigo"');
  ok(!String(r.porCharge('pay_t').status_evento_em).startsWith('2099'), 'S7: e nenhum carimbo do futuro foi gravado');
}

/* ── S8b) estorno FORJADO e baixa desfeita ────────────────────────────── */
{
  let r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'confirmado', charge_id: 'pay_e' })] },
    asaas: { 'GET /v3/payments/pay_e': [naAsaas('RECEIVED')] },
    passos: [{ webhook: evento('PAYMENT_REFUNDED', 'pay_e', { refunds: [{ status: 'DONE', value: 10 }] }) }]
  });
  igual(r.porCharge('pay_e').status, 'confirmado', 'estorno forjado (a lista do CORPO diz DONE, a Asaas não tem estorno): nada muda');
  ok(/sem respaldo/.test(r.erroDoPasso(0) ?? ''), 'e lança para a inbox, que esgota e registra');
  igual(r.avisos('pay_e').length, 0);
  r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'boleto', status: 'confirmado', charge_id: 'pay_u' })] },
    asaas: { 'GET /v3/payments/pay_u': [naAsaas('PENDING')] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_u', {}, { dateCreated: new Date().toISOString() }) }]
  });
  igual(r.porCharge('pay_u').status, 'pendente', 'baixa desfeita DE VERDADE (a Asaas voltou a PENDING): aplica');
  r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'boleto', status: 'confirmado', charge_id: 'pay_u' })] },
    asaas: { 'GET /v3/payments/pay_u': [naAsaas('RECEIVED')] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED_IN_CASH_UNDONE', 'pay_u', {}, { dateCreated: new Date().toISOString() }) }]
  });
  igual(r.porCharge('pay_u').status, 'confirmado', 'baixa desfeita FORJADA (a Asaas diz RECEIVED): o pago continua pago');
}

/* ── S10) a Asaas fora do ar: nada aplicado, e o evento fica guardado ──── */
{
  const corpo = evento('PAYMENT_CONFIRMED', 'pay_x');
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_x' })] },
    asaas: { 'GET /v3/payments/pay_x': [{ status: 503, corpo: { errors: [{ description: 'indisponível' }] } }] },
    passos: [{ receber: corpo }]
  });
  igual(r.resultados[0].status, 200, 'S10: guardado mesmo sem poder conferir');
  igual(r.porCharge('pay_x').status, 'pendente', 'S10: "não consegui perguntar" nunca vira "confirmado"');
  igual(r.inboxPorEvento(corpo.id).status, 'falhou', 'S10: e a inbox tenta de novo');
}

/* ── S11) INTEGRIDADE: o charge está na linha que a Asaas não reconhece ── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(111), metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_i' }), linha({ id: uuid(112), metodo_pagamento: 'pix', status: 'pendente', charge_id: null })] },
    asaas: { 'GET /v3/payments/pay_i': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(112)}` })] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_i') }]
  });
  ok(/vínculo inconsistente/.test(r.erroDoPasso(0) ?? ''), `S11: banco e Asaas discordam de qual linha é esta cobrança — nada se aplica (${r.erroDoPasso(0)})`);
  igual(r.porCharge('pay_i').status, 'pendente');
}

/* ── S11b) CICLO 2+ DE ASSINATURA: a referência é a da 1ª reserva, e isso é certo ──
   C1-02 (ciclo adversarial 1): a linha do ciclo 2 nasce com id próprio
   (`registrarCicloAssinatura`), e o pagamento dele na Asaas herda a
   referência da assinatura — `reserva-<id da 1ª>`. A conferência de
   vínculo exigia `reserva-<id desta linha>` e lançava para sempre: o
   ciclo pago ficava `vencido`, o estorno e o chargeback nunca entravam. */
{
  const primeira = uuid(113); const ciclo2 = uuid(114);
  const r = await rodar({
    tabelas: { cobrancas: [
      linha({ id: primeira, metodo_pagamento: 'assinatura', status: 'confirmado', charge_id: 'pay_c1', asaas_subscription_id: 'sub_s11b' }),
      linha({ id: ciclo2, metodo_pagamento: 'assinatura', status: 'vencido', charge_id: 'pay_c2', asaas_subscription_id: 'sub_s11b' })
    ] },
    asaas: { 'GET /v3/payments/pay_c2': [naAsaas('RECEIVED', { externalReference: `reserva-${primeira}`, subscription: 'sub_s11b' })] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_c2', { subscription: 'sub_s11b', externalReference: `reserva-${primeira}` }) }]
  });
  igual(r.erroDoPasso(0), null, `C1-02: o evento do ciclo 2 não é "vínculo inconsistente" só por levar a referência da assinatura (${r.erroDoPasso(0)})`);
  igual(r.porCharge('pay_c2').status, 'confirmado', 'C1-02: o ciclo 2 recusado e depois pago fica pago');
  igual(r.porCharge('pay_c1').status, 'confirmado', 'e a 1ª cobrança não é tocada');
}
/* ── S11c) ...mas o ciclo que a Asaas diz ser de OUTRA assinatura continua barrado ── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(115), metodo_pagamento: 'assinatura', status: 'vencido', charge_id: 'pay_c3', asaas_subscription_id: 'sub_nossa' })] },
    asaas: { 'GET /v3/payments/pay_c3': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(116)}`, subscription: 'sub_outra' })] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_c3', { subscription: 'sub_outra' }) }]
  });
  ok(/vínculo inconsistente/.test(r.erroDoPasso(0) ?? ''), `S11c: a linha é da assinatura sub_nossa e a Asaas diz sub_outra — nada se aplica (${r.erroDoPasso(0)})`);
  igual(r.porCharge('pay_c3').status, 'vencido');
}

/* ── S11d) A cobrança substituída que a Asaas liquidou no mesmo instante ──
   D-3 (auditoria do diff): substituir um Pix/boleto ou uma pop-up
   desatualizada grava a antiga como `cancelado`, que não tinha saída. Se
   a Asaas ainda assim liquidar (o pagador pagou no instante da exclusão),
   o evento esbarrava em "Asaas à frente" oito vezes, e o reconciliador
   não achava caminho: dinheiro recebido, contratante nunca avisado. */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(117), metodo_pagamento: 'pix', status: 'cancelado', charge_id: 'pay_substituida' })] },
    asaas: { 'GET /v3/payments/pay_substituida': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(117)}` })] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_substituida') }]
  });
  igual(r.erroDoPasso(0), null, `D-3: o pagamento real de uma cobrança substituída é aplicado (${r.erroDoPasso(0)})`);
  igual(r.porCharge('pay_substituida').status, 'confirmado', 'D-3: e a cobrança fica paga — é dinheiro recebido');
}
/* ── S11e) …mas o CHECKOUT_* atrasado não tira nada de `cancelado` ─────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(118), metodo_pagamento: 'pix', status: 'cancelado', charge_id: 'pay_sem_pagar' })] },
    asaas: { 'GET /v3/payments/pay_sem_pagar': [naAsaas('PENDING', { externalReference: `reserva-${uuid(118)}` })] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_sem_pagar') }]
  });
  igual(r.porCharge('pay_sem_pagar').status, 'cancelado', 'D-3 controle: evento de pagamento que a Asaas NÃO respalda não tira do cancelado');
}

/* ── S12) DOIS pagamentos na Asaas para a mesma reserva ───────────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(121), metodo_pagamento: 'pix', status: 'confirmado', charge_id: 'pay_primeiro' })] },
    asaas: { 'GET /v3/payments/pay_segundo': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(121)}` })] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_segundo') }]
  });
  ok(r.errosRegistrados().some((e) => e.contexto === 'webhookController.duplicidadeDeReserva'), 'invariante 12: o segundo pagamento da mesma reserva é DENUNCIADO — antes era ignorado calado');
  igual(r.banco.cobrancas.length, 1, 'e nenhuma linha é inventada');
  igual(r.porCharge('pay_primeiro').status, 'confirmado', 'e a linha paga não é tocada');
}

/* ── S13) o RECONCILIADOR DIRIGIDO (JULES-004) ────────────────────────── */
{
  const inboxA = esgotada('PAYMENT_CONFIRMED', 'pay_ra');
  const inboxC = esgotada('PAYMENT_RECEIVED', 'pay_rc');
  const inboxD = esgotada('PAYMENT_CONFIRMED', 'pay_rd');
  const inboxE = esgotada('PAYMENT_PARTIALLY_REFUNDED', 'pay_re');
  const r = await rodar({
    tabelas: {
      cobrancas: [
        linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_ra' }),                                           // A: esgotou; a Asaas já estornou
        linha({ metodo_pagamento: 'cartao_credito', status: 'em_analise', charge_id: 'pay_rb', atualizado_em: agoraMenos(60 * 48) }), // B: parada em análise há 2 dias
        linha({ metodo_pagamento: 'pix', status: 'estornado', charge_id: 'pay_rc' }),                                          // C: sem caminho de volta
        linha({ metodo_pagamento: 'pix', status: 'confirmado', charge_id: 'pay_rd' }),                                         // D: já igual
        linha({ metodo_pagamento: 'pix', status: 'estornado_parcialmente', charge_id: 'pay_re', valor_estornado: 3 }),          // E: segundo parcial perdido
        linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_rf' }),                                           // F: sem sinal nenhum
        linha({ metodo_pagamento: 'cartao_credito', status: 'em_analise', charge_id: 'pay_rg', atualizado_em: agoraMenos(60) })  // G: em análise há 1 hora (normal)
      ],
      webhook_inbox: [inboxA, inboxC, inboxD, inboxE]
    },
    asaas: {
      'GET /v3/payments/pay_ra': [naAsaas('REFUNDED', { refunds: [{ status: 'DONE', value: 10 }] })],
      'GET /v3/payments/pay_rb': [naAsaas('CONFIRMED')],
      'GET /v3/payments/pay_rc': [naAsaas('RECEIVED')],
      'GET /v3/payments/pay_rd': [naAsaas('RECEIVED')],
      'GET /v3/payments/pay_re': [naAsaas('RECEIVED', { refunds: [{ status: 'DONE', value: 3 }, { status: 'DONE', value: 2 }] })]
    },
    passos: [{ reconciliar: true }]
  });
  igual(r.resultados[0], { examinadas: 5, corrigidas: 3, iguais: 1, semCaminho: 1, falhas: 0 }, 'JULES-004: as cinco com sinal, e só elas');
  igual([r.porCharge('pay_ra').status, Number(r.porCharge('pay_ra').valor_estornado)], ['estornado', 10], 'A: levada ao estado da Asaas pelos passos permitidos');
  igual(r.avisos('pay_ra').map((o) => o.chave_idempotencia).sort(), ['pedido|pay_ra|confirmado', 'pedido|pay_ra|estornado'], 'A: o contratante ouve a história verdadeira — foi pago, depois estornado');
  igual(r.inboxPorId(inboxA.id).status, 'processado', 'A: a linha esgotada é fechada');
  ok(/reconciliada/.test(r.inboxPorId(inboxA.id).ultimo_erro), 'A: dizendo que foi a reconciliação, não o evento, que resolveu');
  igual(r.porCharge('pay_rb').status, 'confirmado', 'B: a análise que parou há dois dias é resolvida pelo estado da Asaas');
  igual(r.porCharge('pay_rc').status, 'estornado', 'C: sem transição permitida, nada é forçado');
  ok(r.errosRegistrados().some((e) => /pay_rc/.test(e.mensagem) && /não há transição permitida/.test(e.mensagem)), 'C: e um humano é chamado');
  igual(r.inboxPorId(inboxC.id).status, 'falhou', 'C: a linha fica aberta até alguém decidir');
  igual(r.inboxPorId(inboxD.id).status, 'processado', 'D: já estava de acordo — só fecha a linha');
  igual(Number(r.porCharge('pay_re').valor_estornado), 5, 'E: o segundo estorno parcial, cujo evento se perdeu, entra');
  ok(r.avisos('pay_re').some((o) => o.chave_idempotencia === 'pedido|pay_re|estornado_parcialmente|500'), 'E: como fato próprio para o contratante');
  ok(!r.chamadas.some((c) => /pay_rf|pay_rg/.test(c)), 'F e G: sem sinal, nenhuma pergunta à Asaas — é dirigido, não varredura');
}

/* ── S14) REENTREGA de um evento esgotado o reabre (SEC-024) ──────────── */
{
  const linhaEsgotada = esgotada('PAYMENT_CONFIRMED', 'pay_z', { impressao_digital: 'asaas:evt_z', evento_id_provedor: 'evt_z' });
  const linhaOk = esgotada('PAYMENT_CONFIRMED', 'pay_w', { impressao_digital: 'asaas:evt_w', evento_id_provedor: 'evt_w', status: 'processado', tentativas: 0 });
  const r = await rodar({
    tabelas: {
      cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_z' }), linha({ metodo_pagamento: 'pix', status: 'confirmado', charge_id: 'pay_w' })],
      webhook_inbox: [linhaEsgotada, linhaOk]
    },
    asaas: { 'GET /v3/payments/pay_z': [naAsaas('RECEIVED')], 'GET /v3/payments/pay_w': [naAsaas('RECEIVED')] },
    passos: [
      { receber: { id: 'evt_z', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_z' } } },
      { receber: { id: 'evt_w', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_w' } } }
    ]
  });
  igual(r.resultados[0], { status: 200, json: { recebido: true } }, 'SEC-024: a reentrega de um evento que FALHOU não é "duplicado"');
  igual(r.porCharge('pay_z').status, 'confirmado', 'SEC-024: ela é processada — é o gesto do operador que reenvia pelo painel da Asaas');
  igual(r.inboxPorId(linhaEsgotada.id).status, 'processado');
  igual(r.resultados[1], { status: 200, json: { recebido: true, duplicado: true } }, 'controle: reentrega do que JÁ deu certo continua "duplicado"');
  ok(!r.chamadas.includes('GET /v3/payments/pay_w'), 'controle: e nem pergunta à Asaas');
}

/* ── S15) o CAS de reivindicação respeita o recuo (SEC-023) ───────────── */
{
  const ib = (id, extra) => ({ id, provedor: 'asaas', impressao_digital: `asaas:${id}`, tipo_evento: 'PAYMENT_CONFIRMED', referencia_tipo: 'payment', referencia_id: 'pay_q', tentativas: 1, recebido_em: agoraMenos(30), corpo_hash: 'x', corpo_minimo: {}, ...extra });
  const ob = (id, extra) => ({ id, contratante_id: 'loja', url: LOJA.webhook_url, tipo: 'pedido', evento: 'confirmado', chave_idempotencia: `k_${id}`, payload: {}, tentativas: 1, criado_em: agoraMenos(30), ...extra });
  const r = await rodar({
    tabelas: {
      webhook_inbox: [
        ib(uuid(151), { status: 'falhou', proxima_tentativa_em: agoraMais(10) }),
        ib(uuid(152), { status: 'falhou', proxima_tentativa_em: agoraMenos(1) }),
        ib(uuid(153), { status: 'falhou', proxima_tentativa_em: null }),
        ib(uuid(154), { status: 'recebido', proxima_tentativa_em: agoraMais(1) }),
        ib(uuid(155), { status: 'processando', proxima_tentativa_em: agoraMais(4) }),
        ib(uuid(156), { status: 'processando', proxima_tentativa_em: agoraMenos(1) }),
        ib(uuid(157), { status: 'falhou', tentativas: 8, proxima_tentativa_em: null })
      ],
      outbox_notificacoes: [
        ob(uuid(161), { status: 'falhou', proxima_tentativa_em: agoraMais(10) }),
        ob(uuid(162), { status: 'falhou', proxima_tentativa_em: agoraMenos(1) }),
        ob(uuid(163), { status: 'pendente', proxima_tentativa_em: agoraMenos(1) }),
        ob(uuid(164), { status: 'enviando', proxima_tentativa_em: agoraMenos(1), enviando_em: agoraMenos(0) }),
        ob(uuid(165), { status: 'enviando', proxima_tentativa_em: agoraMenos(1), enviando_em: agoraMenos(10) })
      ]
    },
    passos: [
      { reivindicar: uuid(151) }, { reivindicar: uuid(152) }, { reivindicar: uuid(153) }, { reivindicar: uuid(154) }, { reivindicar: uuid(155) }, { reivindicar: uuid(156) },
      { reivindicarEnvio: uuid(161) }, { reivindicarEnvio: uuid(162) }, { reivindicarEnvio: uuid(163) }, { reivindicarEnvio: uuid(164) }, { reivindicarEnvio: uuid(165) },
      { reenfileirar: uuid(157) }, { reivindicarEFalhar: uuid(157) }
    ]
  });
  const [r151, r152, r153, r154, r155, r156, o161, o162, o163, o164, o165] = r.resultados;
  igual(r151, null, 'SEC-023: `falhou` com o recuo ainda correndo NÃO é reivindicada (era: tentativa queimada na hora)');
  igual(r152, uuid(152), 'SEC-023: com o recuo vencido, é');
  igual(r153, null, 'esgotada (sem próxima tentativa) nunca é reivindicada');
  igual(r154, uuid(154), '`recebido` é reivindicada a qualquer hora — é o processamento inline do receptor');
  igual(r155, null, '`processando` com arrendamento vivo: de outro processo');
  igual(r156, uuid(156), '`processando` com arrendamento vencido: o processo morreu, volta');
  igual(o161, null, 'SEC-023 (outbox): `falhou` no recuo não é reenviada antes da hora');
  igual(o162, uuid(162), 'SEC-023 (outbox): recuo vencido, sim');
  igual(o163, uuid(163), '`pendente` na hora, sim');
  igual(o164, null, '`enviando` recente: de outro envio');
  igual(o165, uuid(165), '`enviando` abandonado: volta');
  igual(r.resultados[11], true, 'SEC-024: o reenvio administrativo aceita a linha esgotada');
  igual(r.resultados[12].esgotou, false, 'SEC-024: e a primeira falha depois dele NÃO esgota — as tentativas foram zeradas (era: 8 + 1 = esgotada na hora)');
  igual(r.resultados[12].tentativas, 1);
}

/* ── S16) o carimbo do reconciliador não descarta o evento real mais velho ─ */
{
  const r = await rodar({
    tabelas: {
      cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_s' })],
      webhook_inbox: [esgotada('PAYMENT_CONFIRMED', 'pay_s')]
    },
    asaas: { 'GET /v3/payments/pay_s': [naAsaas('RECEIVED'), naAsaas('RECEIVED'), naAsaas('REFUNDED', { refunds: [{ status: 'DONE', value: 10 }] })] },
    passos: [
      { reconciliar: true },
      // o estorno aconteceu há 10 min; o evento dele chega DEPOIS do reconciliador ter gravado "agora"
      { webhook: evento('PAYMENT_REFUNDED', 'pay_s', {}, { dateCreated: agoraMenos(10) }) }
    ]
  });
  igual(r.porCharge('pay_s').status, 'estornado', 'o estorno real vale: com a Asaas JÁ no estado que ele aponta, o carimbo mais velho não o descarta');
  ok(new Date(r.porCharge('pay_s').status_evento_em).getTime() > Date.now() - 5 * 60_000, 'e o carimbo gravado não anda para trás');
}

/* ── S17) o vínculo da reserva é CAS ──────────────────────────────────── */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ id: uuid(171), metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_ja' }), linha({ id: uuid(172), metodo_pagamento: 'pix', status: 'pendente', charge_id: null })] },
    passos: [
      { vincularReserva: [uuid(171), { chargeId: 'pay_outro' }] },
      { vincularReserva: [uuid(172), { chargeId: 'pay_novo' }] },
      { vincularReserva: [uuid(172), { chargeId: 'pay_terceiro' }] }
    ]
  });
  igual(r.resultados, [false, true, false], 'vínculo só no que está vazio — o segundo a chegar recebe `false` e relê');
  igual(r.banco.cobrancas.find((l) => l.id === uuid(171)).charge_id, 'pay_ja', 'a linha já vinculada NÃO troca de cobrança');
  igual(r.banco.cobrancas.find((l) => l.id === uuid(172)).charge_id, 'pay_novo');
}

/* ── S18) a lista de estornos que o GET não trouxe ────────────────────── */
{
  const r = await rodar({
    tabelas: {
      cobrancas: [linha({ metodo_pagamento: 'pix', status: 'estornado_parcialmente', charge_id: 'pay_rh', valor_estornado: 3 })],
      webhook_inbox: [esgotada('PAYMENT_PARTIALLY_REFUNDED', 'pay_rh')]
    },
    asaas: {
      'GET /v3/payments/pay_rh': [naAsaas('RECEIVED', { refunds: null })],
      'GET /v3/payments/pay_rh/refunds': [{ status: 200, corpo: { hasMore: false, data: [{ status: 'DONE', value: 3 }, { status: 'DONE', value: 4 }] } }]
    },
    passos: [
      { reconciliar: true },
      // e um RECEIVED atrasado sobre a cobrança parcialmente estornada: histórico, não "estado faltando"
      { webhook: evento('PAYMENT_RECEIVED', 'pay_rh', {}, { dateCreated: new Date().toISOString() }) }
    ]
  });
  ok(r.chamadas.includes('GET /v3/payments/pay_rh/refunds'), 'sem `refunds` no GET, a lista é buscada à parte');
  igual(Number(r.porCharge('pay_rh').valor_estornado), 7, 'e o estorno que faltava entra');
  igual(r.porCharge('pay_rh').status, 'estornado_parcialmente');
  igual(r.erroDoPasso(1), null, 'o RECEIVED atrasado não vira alarme de estado faltando');
}

/* ── CP3-09) O RESPALDO DO PROVEDOR, pelo receptor de verdade ─────────
   A tabela é fixada célula por célula no autoteste do controlador; aqui,
   o efeito dela no dinheiro: com o token vazado, cada evento forjado
   abaixo chega com um `payment.id` real e a Asaas dizendo OUTRA coisa.
   Nenhum pode mudar o status nem avisar o contratante. Antes, só o caso
   "Asaas em PENDING" era exercitado — as sabotagens destes passavam. */
{
  const forjados = [
    ['confirmado com a Asaas em OVERDUE', 'boleto', 'pendente', 'PAYMENT_CONFIRMED', naAsaas('OVERDUE')],
    ['confirmado com a Asaas em análise de risco', 'cartao_credito', 'pendente', 'PAYMENT_CONFIRMED', naAsaas('AWAITING_RISK_ANALYSIS')],
    ['confirmado de uma cobrança REMOVIDA na Asaas', 'pix', 'pendente', 'PAYMENT_CONFIRMED', naAsaas('PENDING', { deleted: true })],
    ['chargeback com a Asaas dizendo pago', 'cartao_credito', 'confirmado', 'PAYMENT_CHARGEBACK_REQUESTED', naAsaas('RECEIVED')],
    ['baixa desfeita com a Asaas dizendo pago', 'pix', 'confirmado', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', naAsaas('RECEIVED')],
    ['estorno em andamento com a Asaas dizendo pago', 'boleto', 'confirmado', 'PAYMENT_REFUND_IN_PROGRESS', naAsaas('RECEIVED')]
  ];
  for (const [nome, metodo, antes, tipo, asaas] of forjados) {
    const charge = `pay_forjado_${(seq += 1)}`;
    const r = await rodar({
      tabelas: { cobrancas: [linha({ metodo_pagamento: metodo, status: antes, charge_id: charge })] },
      asaas: { [`GET /v3/payments/${charge}`]: [asaas] },
      passos: [{ receber: evento(tipo, charge) }]
    });
    igual(r.porCharge(charge).status, antes, `CP3-09: ${nome} — o status não muda`);
    igual(r.avisos(charge).length, 0, `CP3-09: ${nome} — o contratante não ouve nada`);
  }
  /* controle positivo: o MESMO evento, com a Asaas concordando, aplica —
     senão os casos acima passariam por um receptor que recusa tudo. */
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'confirmado', charge_id: 'pay_cb_real' })] },
    asaas: { 'GET /v3/payments/pay_cb_real': [naAsaas('CHARGEBACK_REQUESTED')] },
    passos: [{ receber: evento('PAYMENT_CHARGEBACK_REQUESTED', 'pay_cb_real') }]
  });
  igual(r.porCharge('pay_cb_real').status, 'chargeback', 'controle: chargeback com a Asaas em disputa aplica');
}

/* O estorno TOTAL não se aplica sobre um parcial que a Asaas ainda diz
   parcial: `estornado` é terminal, e a cobrança nunca mais sairia dele. */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'pix', status: 'estornado_parcialmente', valor_estornado: 3, charge_id: 'pay_total_forjado' })] },
    asaas: { 'GET /v3/payments/pay_total_forjado': [naAsaas('RECEIVED', { refunds: [{ status: 'DONE', value: 3 }] })] },
    passos: [{ receber: evento('PAYMENT_REFUNDED', 'pay_total_forjado') }]
  });
  igual(r.porCharge('pay_total_forjado').status, 'estornado_parcialmente', 'CP3-09: PAYMENT_REFUNDED com a Asaas em parcial não vira estorno total (terminal)');
}

/* A SESSÃO de pop-up que a Asaas diz é a da linha — ou nada se aplica.
   Tirar a comparação deixava um pagamento de outra sessão confirmar esta. */
{
  const r = await rodar({
    tabelas: { cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_outra_sessao', asaas_checkout_id: 'sess_nossa' })] },
    asaas: { 'GET /v3/payments/pay_outra_sessao': [naAsaas('RECEIVED', { checkoutSession: 'sess_outra' })] },
    passos: [{ receber: evento('PAYMENT_CONFIRMED', 'pay_outra_sessao') }]
  });
  igual(r.porCharge('pay_outra_sessao').status, 'pendente', 'CP3-09: sessão divergente não confirma');
  igual(r.avisos('pay_outra_sessao').length, 0, 'CP3-09: e não avisa ninguém');
}

/* ── FP1A-4) pagamento com a NOSSA referência de reserva e sem linha ──
   Voltava calado: dinheiro nosso sem registro. Agora chama um humano;
   um charge alheio (referência que não é nossa) continua ignorado. */
{
  const r = await rodar({
    tabelas: { cobrancas: [] },
    asaas: {
      'GET /v3/payments/pay_sem_linha': [naAsaas('RECEIVED', { externalReference: `reserva-${uuid(181)}` })],
      'GET /v3/payments/pay_alheio': [naAsaas('RECEIVED', { externalReference: 'pedido-de-outro-sistema' })]
    },
    passos: [{ receber: evento('PAYMENT_CONFIRMED', 'pay_sem_linha') }, { receber: evento('PAYMENT_CONFIRMED', 'pay_alheio') }]
  });
  const alertas = r.errosRegistrados().filter((e) => e.contexto === 'webhookController.reservaSemLinha');
  igual(alertas.length, 1, 'FP1A-4: pagamento com referência de reserva nossa e sem linha chama um humano — e só esse');
  ok(String(alertas[0]?.mensagem ?? alertas[0]?.message ?? JSON.stringify(alertas[0])).includes('pay_sem_linha'), 'FP1A-4: o alerta nomeia o pagamento');
}

console.log(`webhook-confere-na-asaas: ${checagens} checagens OK`);
