#!/usr/bin/env node
/**
 * tests/acerto-de-troca-nunca-fica-orfao.js
 *
 * CLASSE CR-02 da remediação da Estação 6 (SEC-009, SEC-010): efeito
 * financeiro sem identidade durável antes do provedor, na troca de plano.
 *
 * O furo: a aprovação reivindica a intenção (`PROCESSING_PAYMENT`),
 * cobra o acerto no cartão salvo e SÓ DEPOIS grava o `charge_id`. Um
 * processo que morresse entre as duas — um deploy basta, a `main` publica
 * sozinha — deixava a intenção em `PROCESSING_PAYMENT` sem `charge_id`
 * para sempre: o sweeper pulava essa combinação (o comentário dele dizia
 * que ela "não deveria acontecer"), e o `PAYMENT_CONFIRMED` do acerto era
 * descartado por não achar intenção nem cobrança. O assinante pagava e o
 * plano nunca mudava.
 *
 * Aqui a queda é DE VERDADE: um processo filho roda a aprovação real
 * contra o banco falso, a Asaas roteirizada responde a cobrança — e o
 * processo morre (`process.exit`) antes de a resposta chegar ao código,
 * que é exatamente a janela. Um SEGUNDO processo, sem nada em memória,
 * tem de resolver: pelo sweeper, pelo webhook, e provando a ausência
 * quando a cobrança não chegou a existir. Nunca uma segunda cobrança.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

let checagens = 0;
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const INTENCAO = '7a1c0de0-0000-4000-8000-000000000001';
const LOJA = { id: 'loja', nome: 'Loja', api_key: 'segredo-da-loja-0123456789', webhook_url: 'https://loja.exemplo/hook', api_base_url: 'https://loja.exemplo/api', metodos_habilitados: null };

function mundoInicial() {
  return {
    tabelas: {
      contratantes: [LOJA],
      assinaturas: [{ id: 'sub_t', contratante_id: 'loja', plano_id: 'plano_mensal', documento: '11144477735', valor: 100, ciclo: 'MONTHLY', status: 'ativa', mutation_version: 3, trocando_em: null }],
      intencoes_troca_plano: [{
        id: INTENCAO, assinatura_id: 'sub_t', contratante_id: 'loja',
        plano_id: 'plano_mensal', plano_novo_id: 'plano_caro', plano_nome: 'Mensal', plano_novo_nome: 'Caro',
        ciclo_atual: 'MONTHLY', ciclo_novo: 'MONTHLY', valor_atual: 100, valor_novo: 160, valor_pago_do_periodo: 100,
        vencimento_atual: '2026-10-10T03:00:00.000Z', dias_restantes: 15, credito: 50, debito: 80, valor_acerto: 30,
        mutation_version_snapshot: 3, status: 'PENDING_APPROVAL', charge_id: null, aprovando_em: null, tentativas_sweeper: 0,
        criada_em: new Date(Date.now() - 60_000).toISOString(), expira_em: new Date(Date.now() + 10 * 60_000).toISOString()
      }],
      cobrancas: [],
      outbox_notificacoes: []
    }
  };
}

/** A assinatura na Asaas, antes e depois do PUT. */
const SUB_ANTES = { status: 200, corpo: { id: 'sub_t', status: 'ACTIVE', deleted: false, value: 100, cycle: 'MONTHLY', nextDueDate: '2026-10-10', customer: 'cus_1', creditCard: { creditCardToken: 'tok_1' } } };
const SUB_DEPOIS = { status: 200, corpo: { ...SUB_ANTES.corpo, value: 160 } };

/**
 * Um processo filho. `passo`: 'aprovar' | 'varrer' | 'webhook'.
 * `asaas`: roteiro `{ 'MÉTODO /caminho': [resp…] }` (a última se repete);
 * resp = { status, corpo } | { cai: 'antes' | 'depois' } — `cai` derruba
 * o processo na chamada: 'antes' sem a Asaas ter recebido, 'depois' com a
 * Asaas tendo cobrado (a resposta nunca chega ao código).
 */
async function processo({ arquivo, chamadas, passo, asaas }) {
  const codigo = `
    const { appendFileSync } = await import('node:fs');
    const roteiro = ${JSON.stringify(asaas)};
    const usadas = {};
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if (u.hostname === 'loja.exemplo') {
        const corpo = u.pathname.endsWith('/plano/plano_caro') ? { nome: 'Caro', valor: 160, ciclo: 'MONTHLY' } : { ok: true };
        return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const chave = (opcoes.method ?? 'GET') + ' ' + u.pathname;
      const lista = roteiro[chave];
      const r = lista ? lista[Math.min(usadas[chave] ?? 0, lista.length - 1)] : null;
      usadas[chave] = (usadas[chave] ?? 0) + 1;
      if (r?.cai === 'antes') { appendFileSync(process.env.CHAMADAS, chave + ' [não chegou]\\n'); process.exit(137); }
      appendFileSync(process.env.CHAMADAS, chave + '\\n');
      if (!r) return new Response(JSON.stringify({ errors: [{ description: 'rota fora do roteiro: ' + chave }] }), { status: 500 });
      if (r.cai === 'depois') {
        // A Asaas cobrou; o processo morre antes de a resposta chegar ao código.
        return { ok: true, status: 200, json: async () => { queueMicrotask(() => process.exit(137)); return r.corpo; } };
      }
      return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    const passo = ${JSON.stringify(passo)};
    if (passo === 'aprovar') {
      const { iniciarCobranca } = await import('./src/services/trocaExecucaoService.js');
      console.log(JSON.stringify(await iniciarCobranca(${JSON.stringify(INTENCAO)})));
    } else if (passo === 'varrer') {
      const { varrerUmaVez } = await import('./src/services/trocaSweeperService.js');
      console.log(JSON.stringify(await varrerUmaVez()));
    } else if (passo === 'cas') {
      const { registrarChargeId } = await import('./src/services/trocaIntencaoService.js');
      const r = [];
      for (const id of ['pay_a', 'pay_a', 'pay_b']) r.push(await registrarChargeId(${JSON.stringify(INTENCAO)}, id));
      console.log(JSON.stringify(r));
    } else if (passo === 'webhook') {
      const { processarWebhook } = await import('./src/controllers/webhookController.js');
      await processarWebhook({ id: 'evt_acerto', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-25 10:00:00', payment: { id: 'pay_acerto' } });
      await new Promise((r) => setTimeout(r, 300)); // a aplicação da troca roda fora do fluxo do webhook
      console.log('{}');
    }
    await new Promise((r) => setTimeout(r, 150));
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', BANCO_FALSO_ARQUIVO: arquivo, CHAMADAS: chamadas, ORIGEM_FRONTEND: 'https://checkout.exemplo' }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  return { status, stdout, stderr };
}

function preparar() {
  const pasta = mkdtempSync(join(tmpdir(), 'troca-orfa-'));
  const arquivo = join(pasta, 'banco.json');
  const chamadas = join(pasta, 'chamadas.txt');
  writeFileSync(arquivo, JSON.stringify(mundoInicial()));
  writeFileSync(chamadas, '');
  const ler = () => JSON.parse(readFileSync(arquivo, 'utf8')).tabelas;
  const lerChamadas = () => (existsSync(chamadas) ? readFileSync(chamadas, 'utf8').split('\n').filter(Boolean) : []);
  /** O relógio andou `min` minutos desde a reivindicação. */
  const envelhecer = (min) => {
    const estado = JSON.parse(readFileSync(arquivo, 'utf8'));
    for (const i of estado.tabelas.intencoes_troca_plano) if (i.aprovando_em) i.aprovando_em = new Date(Date.now() - min * 60_000).toISOString();
    writeFileSync(arquivo, JSON.stringify(estado));
  };
  return { arquivo, chamadas, ler, lerChamadas, envelhecer };
}

const cobrancasDoAcerto = (chamadas) => chamadas.filter((c) => c.startsWith('POST /v3/payments'));

/* ── 1) a queda DEPOIS de a Asaas cobrar, resolvida pelo SWEEPER ────── */
{
  const m = preparar();
  const aprovacao = await processo({ ...m, passo: 'aprovar', asaas: {
    'GET /v3/subscriptions/sub_t': [SUB_ANTES],
    'POST /v3/payments': [{ cai: 'depois', corpo: { id: 'pay_acerto', status: 'CONFIRMED', value: 30 } }]
  } });
  igual(aprovacao.status, 137, 'a queda aconteceu de verdade, no meio da aprovação');
  let banco = m.ler();
  const orfa = banco.intencoes_troca_plano[0];
  igual([orfa.status, orfa.charge_id], ['PROCESSING_PAYMENT', null], 'a janela: reivindicada, cobrada na Asaas, e sem charge_id aqui');
  ok(banco.assinaturas[0].trocando_em, 'e o arrendamento da assinatura ficou preso com ela');
  igual(cobrancasDoAcerto(m.lerChamadas()).length, 1, 'a Asaas recebeu UMA cobrança');

  // outro processo, sem nada em memória, antes do prazo da órfã: não mexe
  let varredura = await processo({ ...m, passo: 'varrer', asaas: {} });
  igual(varredura.status, 0, varredura.stderr);
  igual(m.ler().intencoes_troca_plano[0].status, 'PROCESSING_PAYMENT', 'recém-reivindicada: o sweeper espera (a coreografia pode estar em curso)');

  m.envelhecer(5);
  varredura = await processo({ ...m, passo: 'varrer', asaas: {
    'GET /v3/payments': [{ status: 200, corpo: { data: [{ id: 'pay_acerto', status: 'CONFIRMED', deleted: false }], hasMore: false } }],
    'GET /v3/payments/pay_acerto': [{ status: 200, corpo: { id: 'pay_acerto', status: 'CONFIRMED', value: 30 } }],
    'PUT /v3/subscriptions/sub_t': [{ status: 200, corpo: {} }],
    'GET /v3/subscriptions/sub_t': [SUB_DEPOIS]
  } });
  igual(varredura.status, 0, varredura.stderr);
  banco = m.ler();
  const i = banco.intencoes_troca_plano[0];
  igual([i.status, i.charge_id], ['COMPLETED', 'pay_acerto'], 'SEC-009: o sweeper achou a cobrança pela referência troca:<id>, vinculou e concluiu');
  igual([banco.assinaturas[0].plano_id, Number(banco.assinaturas[0].valor), banco.assinaturas[0].mutation_version], ['plano_caro', 160, 4], 'o assinante recebeu o plano que pagou');
  igual(banco.assinaturas[0].trocando_em ?? null, null, 'e o arrendamento voltou');
  ok(banco.cobrancas.some((c) => c.charge_id === 'pay_acerto' && c.metodo_pagamento === 'acerto_troca'), 'o acerto ficou registrado em cobrancas');
  ok((banco.outbox_notificacoes ?? []).some((o) => o.evento === 'plano_trocado'), 'e o contratante é avisado');
  ok(m.lerChamadas().includes(`GET /v3/payments`), 'a procura foi pela referência, na Asaas');
  igual(cobrancasDoAcerto(m.lerChamadas()).length, 1, 'NUNCA uma segunda cobrança às cegas — uma só, a da aprovação');
}

/* ── 2) a mesma queda, resolvida pelo WEBHOOK do acerto ───────────── */
{
  const m = preparar();
  await processo({ ...m, passo: 'aprovar', asaas: {
    'GET /v3/subscriptions/sub_t': [SUB_ANTES],
    'POST /v3/payments': [{ cai: 'depois', corpo: { id: 'pay_acerto', status: 'CONFIRMED', value: 30 } }]
  } });
  igual(m.ler().intencoes_troca_plano[0].charge_id, null, 'órfã, de novo');
  const webhook = await processo({ ...m, passo: 'webhook', asaas: {
    // a Asaas diz a referência da cobrança — o corpo do evento não diz nada
    'GET /v3/payments/pay_acerto': [{ status: 200, corpo: { id: 'pay_acerto', status: 'CONFIRMED', value: 30, deleted: false, externalReference: `troca:${INTENCAO}` } }],
    'PUT /v3/subscriptions/sub_t': [{ status: 200, corpo: {} }],
    'GET /v3/subscriptions/sub_t': [SUB_DEPOIS]
  } });
  igual(webhook.status, 0, webhook.stderr);
  const banco = m.ler();
  igual([banco.intencoes_troca_plano[0].status, banco.intencoes_troca_plano[0].charge_id], ['COMPLETED', 'pay_acerto'], 'SEC-009: o PAYMENT_CONFIRMED do acerto acha a intenção pela referência DA ASAAS e conclui — antes era descartado');
  igual(banco.assinaturas[0].plano_id, 'plano_caro');
  igual(cobrancasDoAcerto(m.lerChamadas()).length, 1, 'e nenhuma segunda cobrança');
}

/* ── 3) a queda ANTES de a cobrança chegar à Asaas: provar a ausência ─ */
{
  const m = preparar();
  const aprovacao = await processo({ ...m, passo: 'aprovar', asaas: {
    'GET /v3/subscriptions/sub_t': [SUB_ANTES],
    'POST /v3/payments': [{ cai: 'antes' }]
  } });
  igual(aprovacao.status, 137);
  igual(m.ler().intencoes_troca_plano[0].status, 'PROCESSING_PAYMENT');
  const semNada = { 'GET /v3/payments': [{ status: 200, corpo: { data: [], hasMore: false } }] };

  m.envelhecer(5);
  await processo({ ...m, passo: 'varrer', asaas: semNada });
  igual(m.ler().intencoes_troca_plano[0].status, 'PROCESSING_PAYMENT', 'nada na Asaas aos 5 min: ainda não é prova — espera');

  m.envelhecer(20);
  await processo({ ...m, passo: 'varrer', asaas: semNada });
  const banco = m.ler();
  igual(banco.intencoes_troca_plano[0].status, 'STALE', 'nada na Asaas depois de 15 min: provado que não cobrou — o link fecha');
  igual(banco.assinaturas[0].trocando_em ?? null, null, 'e o arrendamento da assinatura volta');
  igual(banco.assinaturas[0].plano_id, 'plano_mensal', 'o plano não muda');
  igual(cobrancasDoAcerto(m.lerChamadas()).filter((c) => !c.includes('não chegou')).length, 0, 'e nenhuma cobrança existiu nem foi tentada de novo');
}

/* ── 4) o vínculo do charge na intenção é CAS (o serviço de verdade) ─ */
{
  const m = preparar();
  const r = await processo({ ...m, passo: 'cas', asaas: {} });
  igual(r.status, 0, r.stderr);
  igual(JSON.parse(r.stdout.trim().split('\n').pop()), [true, true, false], 'vincula no vazio; o MESMO id de novo é idempotente; um id DIFERENTE é recusado (segundo acerto)');
  igual(m.ler().intencoes_troca_plano[0].charge_id, 'pay_a', 'e o primeiro vínculo não é sobrescrito');
}

/* ── 5) o comentário falso do sweeper não volta ───────────────────── */
{
  const fonte = readFileSync(join(RAIZ, 'src/services/trocaSweeperService.js'), 'utf8');
  ok(!/if \(!intencao\.charge_id\) continue;/.test(fonte), 'o `continue` que pulava a órfã para sempre não existe mais');
}

console.log(`acerto-de-troca-nunca-fica-orfao: ${checagens} checagens OK`);
