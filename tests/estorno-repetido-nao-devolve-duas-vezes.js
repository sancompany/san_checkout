#!/usr/bin/env node
/**
 * tests/estorno-repetido-nao-devolve-duas-vezes.js
 *
 * CLASSE CR-02 da remediação da Estação 6, pedaço do estorno (SEC-002).
 *
 * O furo: cobrança de R$ 100, estorno parcial de R$ 30, a resposta se
 * perde, o contratante repete (como o `API.md` §5.4 mandava) — e a Asaas
 * devolvia mais R$ 30. O arrendamento da cobrança só serializava chamadas
 * simultâneas; uma repetição sequencial era indistinguível de um segundo
 * parcial legítimo.
 *
 * Aqui rodam o controlador e o serviço REAIS (`refundController`,
 * `estornoService`) contra um banco em memória com as mesmas regras de CAS
 * das consultas de verdade e uma Asaas falsa que guarda os estornos com a
 * `description` e recusa o que passa do cobrado (como a real faz no Pix).
 * Cada cenário da remediação é um bloco: repetição, A+B legítimos,
 * duplicata de A, total depois de parcial, parcial depois de total, valor
 * excessivo, resposta perdida, queda do processo e reinício, concorrência
 * — e, no fim de cada um, a invariante: o que a Asaas devolveu nunca passa
 * do cobrado.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { criarRefundController } = await import('../src/controllers/refundController.js');
const { executarEstorno, reconciliarEstornosUmaVez, restanteEstornavel, ESTADOS_EM_ABERTO, MINUTOS_ATE_PROVAR_AUSENCIA, MINUTOS_ATE_ALERTAR } = await import('../src/services/estornoService.js');
const { foiRecusaLimpaDaAsaas } = await import('../src/services/asaasService.js');
const { STATUS_ESTORNAVEIS } = await import('../src/services/cobrancaService.js');

let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };
const clone = (x) => (x == null ? x : structuredClone(x));
const centavos = (v) => Math.round(Number(v) * 100);

function erroAsaas(status, mensagem, comCorpo = true) {
  const e = new Error(mensagem);
  e.status = status;
  if (comCorpo) e.corpoAsaas = { errors: [{ description: mensagem }] };
  return e;
}

/** Um mundo novo por cenário: banco, Asaas, relógio e avisos. */
function mundo() {
  let relogio = Date.parse('2026-09-25T12:00:00Z');
  let seq = 0;
  const iso = () => new Date(relogio).toISOString();
  const cobrancas = new Map();
  const estornos = new Map();
  const asaas = { chamadas: [], refunds: new Map(), roteiro: [], statusPagamento: new Map(), parcelamento: new Map(), leituras: 0, leituraFalha: false, duranteChamada: null };
  const erros = [];
  const avisos = [];

  function cobranca(id, extras = {}) {
    cobrancas.set(id, {
      id, contratante_id: 'c1', pedido_id: 'ped_1', charge_id: `pay_${id}`, metodo_pagamento: 'pix',
      status: 'confirmado', valor_cobrado: 100, valor_estornado: null, estornando_em: null, criado_em: iso(), ...extras
    });
    return cobrancas.get(id);
  }
  const porCharge = (chargeId) => [...cobrancas.values()].find((c) => c.charge_id === chargeId);

  /* ---- a cobrança: as mesmas condições das consultas reais ---- */
  const reivindicarEstorno = async (chargeId) => {
    const c = porCharge(chargeId);
    if (!c || !STATUS_ESTORNAVEIS.includes(c.status)) return false;
    if (c.estornando_em && relogio - Date.parse(c.estornando_em) < 5 * 60_000) return false;
    c.estornando_em = iso();
    return true;
  };
  const liberarEstorno = async (chargeId) => { const c = porCharge(chargeId); if (c) c.estornando_em = null; };
  const registrarEstorno = async (chargeId, { status, valorEstornado }, { liberarArrendamento = true } = {}) => {
    const c = porCharge(chargeId);
    const podeStatus = c && [...STATUS_ESTORNAVEIS, 'estorno_solicitado'].includes(c.status);
    const podeValor = valorEstornado == null || c?.valor_estornado == null || Number(c.valor_estornado) < Number(valorEstornado);
    if (!podeStatus || !podeValor) { if (liberarArrendamento && c) c.estornando_em = null; return false; }
    c.status = status;
    if (valorEstornado != null) c.valor_estornado = valorEstornado;
    if (liberarArrendamento) c.estornando_em = null;
    return true;
  };

  /* ---- a Asaas falsa ---- */
  const totalNaAsaas = (chargeId) => (asaas.refunds.get(chargeId) ?? []).filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + centavos(r.value), 0);
  async function estornarCobranca(chargeId, { metodoPagamento, valor, descricao }) {
    asaas.chamadas.push({ chargeId, valor, descricao });
    if (asaas.duranteChamada) await asaas.duranteChamada();
    const comportamento = asaas.roteiro.shift() ?? 'ok';
    if (comportamento === 'timeout_antes') throw erroAsaas(504, 'A Asaas não respondeu a tempo.', false);
    if (comportamento === 'recusa') throw erroAsaas(400, 'Saldo insuficiente para o estorno.');
    if (comportamento === '429') throw erroAsaas(429, 'muitas requisições');
    const c = porCharge(chargeId);
    const restante = centavos(c.valor_cobrado) - totalNaAsaas(chargeId);
    const pedido = valor == null ? restante : centavos(valor);
    if (pedido <= 0 || pedido > restante) throw erroAsaas(400, 'O valor do estorno ultrapassa o valor disponível da cobrança.');
    if (metodoPagamento !== 'boleto') {
      const lista = asaas.refunds.get(chargeId) ?? [];
      lista.push({ value: pedido / 100, status: 'DONE', description: descricao ?? null, dateCreated: iso() });
      asaas.refunds.set(chargeId, lista);
    } else {
      asaas.statusPagamento.set(chargeId, 'REFUND_REQUESTED');
    }
    if (comportamento === 'timeout_depois') throw erroAsaas(504, 'A Asaas não respondeu a tempo.', false);
    return { status: 'REFUNDED', assincrono: metodoPagamento === 'boleto' };
  }

  /* ---- o registro de operações: as mesmas regras de CAS do banco ---- */
  const depsServico = {
    buscarOperacao: async (c, k) => clone([...estornos.values()].find((o) => o.contratante_id === c && o.chave_idempotencia === k) ?? null),
    inserirOperacao: async (linha) => {
      if ([...estornos.values()].some((o) => o.contratante_id === linha.contratante_id && o.chave_idempotencia === linha.chave_idempotencia)) return { conflito: true };
      const op = { tentativas: 0, chamando_em: null, status_resultado: null, valor_estornado_depois: null, ultimo_erro: null, ...linha, criado_em: iso(), atualizado_em: iso() };
      estornos.set(op.id, op);
      return { operacao: clone(op) };
    },
    transitar: async (id, de, campos) => {
      const op = estornos.get(id);
      if (!op || !de.includes(op.estado)) return null;
      Object.assign(op, campos, { atualizado_em: iso() });
      return clone(op);
    },
    operacoesDaCobranca: async (cid) => [...estornos.values()].filter((o) => o.cobranca_id === cid).map((o) => ({ id: o.id, estado: o.estado, valor_centavos: o.valor_centavos, status_resultado: o.status_resultado })),
    operacoesParaReconciliar: async () => [...estornos.values()].filter((o) => ESTADOS_EM_ABERTO.includes(o.estado)).map(clone),
    buscarCobrancaDaOperacao: async (id) => clone(cobrancas.get(id) ?? null),
    estornarCobranca,
    listarEstornosDaCobranca: async (chargeId) => (asaas.refunds.get(chargeId) ?? []).map(clone),
    consultarPagamento: async (chargeId) => ({ status: asaas.statusPagamento.get(chargeId) ?? 'RECEIVED', excluida: false }),
    lerPagamentoNaAsaas: async (chargeId) => {
      asaas.leituras += 1;
      if (asaas.leituraFalha) throw erroAsaas(504, 'A Asaas não respondeu a tempo.', false);
      return { id: chargeId, status: asaas.statusPagamento.get(chargeId) ?? 'CONFIRMED', installment: asaas.parcelamento.get(chargeId) ?? null };
    },
    foiRecusaLimpaDaAsaas,
    registrarErro: async (e) => { erros.push(e.message); },
    registrarNaCobrancaSemSoltar: (chargeId, dados) => registrarEstorno(chargeId, dados, { liberarArrendamento: false }),
    novoId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    agora: () => relogio
  };

  const controlador = criarRefundController({
    buscarContratantePorChave: async (chave) => (chave === 'chave_boa' ? { id: 'c1', webhook_url: 'https://loja.exemplo/hook' } : null),
    buscarCobrancasDoPedido: async (contratanteId, pedidoId) => [...cobrancas.values()]
      .filter((c) => c.contratante_id === contratanteId && c.pedido_id === pedidoId && c.charge_id)
      .sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1)).map(clone),
    reivindicarEstorno, liberarEstorno, registrarEstorno,
    executarEstorno: (dados, gancho) => executarEstorno(dados, gancho, depsServico),
    registrarErro: depsServico.registrarErro,
    notificarFatoDePedido: async (contratante, cob, fato) => { avisos.push(fato); }
  });

  async function estornar(body, chave = 'chave_boa') {
    const r = { codigo: 200, corpo: null, status(c) { this.codigo = c; return this; }, json(c) { this.corpo = c; return this; } };
    await controlador.estornar({ get: (h) => (h === 'X-Checkout-Key' ? chave : undefined), body }, r);
    return r;
  }

  /** A invariante que vale em TODO cenário: a Asaas nunca devolveu mais que o cobrado. */
  function acumuladoNuncaPassaDoCobrado(rotulo) {
    for (const c of cobrancas.values()) {
      ok(totalNaAsaas(c.charge_id) <= centavos(c.valor_cobrado), `${rotulo}: ${c.charge_id} — estornado na Asaas (${totalNaAsaas(c.charge_id)}) ≤ cobrado (${centavos(c.valor_cobrado)})`);
    }
  }

  return {
    cobranca, cobrancas, estornos, asaas, erros, avisos, estornar, depsServico, totalNaAsaas, acumuladoNuncaPassaDoCobrado,
    avancar: (min) => { relogio += min * 60_000; }
  };
}

/* ======================= 1. DUPLICATA DO MESMO PARCIAL ======================= */
{
  const m = mundo();
  m.cobranca('c1');
  const a = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([a.codigo, a.corpo?.status, a.corpo?.valorEstornado], [200, 'estornado_parcialmente', 30], 'A: 30 de 100 estornados');
  ok(m.asaas.chamadas[0].descricao?.startsWith('san-estorno:'), 'o marcador da operação vai na description para a Asaas');
  const repetida = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([repetida.codigo, repetida.corpo?.repetido, repetida.corpo?.valorEstornado], [200, true, 30], 'a REPETIÇÃO de A devolve o resultado gravado');
  igual(m.asaas.chamadas.length, 1, 'SEC-002: a repetição NÃO chama a Asaas de novo');
  igual(m.totalNaAsaas('pay_c1'), 3000, 'e a Asaas devolveu R$ 30, não R$ 60');
  igual(m.avisos.length, 1, 'o contratante é avisado uma vez só');
  m.acumuladoNuncaPassaDoCobrado('duplicata de A');
}

/* =================== 2. A + B LEGÍTIMOS, E A CHAVE REUSADA =================== */
{
  const m = mundo();
  m.cobranca('c1');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  const b = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-B' });
  igual([b.codigo, b.corpo?.status, b.corpo?.valorEstornado], [200, 'estornado_parcialmente', 60], 'B, com chave nova e o MESMO valor, é outro estorno legítimo');
  igual(m.asaas.chamadas.length, 2, 'duas operações, duas chamadas');
  const reuso = await m.estornar({ pedidoId: 'ped_1', valor: 40, chaveIdempotencia: 'estorno-A' });
  igual([reuso.codigo, reuso.corpo?.codigo], [409, 'chave_idempotencia_reutilizada'], 'a chave de A com OUTRO valor é recusada, nunca reinterpretada');
  igual(m.asaas.chamadas.length, 2, 'e não chama a Asaas');
  m.acumuladoNuncaPassaDoCobrado('A+B');
}

/* ============== 3. TOTAL DEPOIS DE PARCIAL; PARCIAL DEPOIS DE TOTAL ============== */
{
  const m = mundo();
  m.cobranca('c1');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  const total = await m.estornar({ pedidoId: 'ped_1' });
  igual([total.codigo, total.corpo?.status, total.corpo?.valorEstornado], [200, 'estornado', 100], 'total depois de parcial devolve o restante e fecha em 100');
  igual(m.asaas.chamadas.at(-1).valor, null, 'o total vai à Asaas sem `value` (ela devolve o restante)');
  const totalDeNovo = await m.estornar({ pedidoId: 'ped_1' });
  igual([totalDeNovo.codigo, totalDeNovo.corpo?.repetido], [200, true], 'repetir o total (sem chave) devolve o gravado — a chave derivada da cobrança');
  const parcialDepois = await m.estornar({ pedidoId: 'ped_1', valor: 10, chaveIdempotencia: 'estorno-C' });
  igual(parcialDepois.codigo, 400, 'parcial depois do total: recusado — o restante estornável é R$ 0,00 (o 400 que o API.md §5.4 documenta)');
  ok(/restante estornável \(R\$ 0\.00\)/.test(parcialDepois.corpo?.erro ?? ''), `e a mensagem diz que não sobrou nada; veio ${parcialDepois.corpo?.erro}`);
  igual(m.asaas.chamadas.length, 2, 'nem a repetição do total nem o parcial chamaram a Asaas');
  m.acumuladoNuncaPassaDoCobrado('total/parcial');
}

/* ============================ 4. VALOR EXCESSIVO ============================ */
{
  const m = mundo();
  m.cobranca('c1');
  const r = await m.estornar({ pedidoId: 'ped_1', valor: 120, chaveIdempotencia: 'estorno-X' });
  igual(r.codigo, 400, 'parcial acima do cobrado: 400');
  igual(m.asaas.chamadas.length, 0, 'sem chamar a Asaas');
  igual(m.estornos.size, 0, 'e sem abrir operação');
  await m.estornar({ pedidoId: 'ped_1', valor: 80, chaveIdempotencia: 'estorno-A' });
  const excede = await m.estornar({ pedidoId: 'ped_1', valor: 20.01, chaveIdempotencia: 'estorno-B' });
  igual(excede.codigo, 400, 'um centavo acima do restante: 400');
  const exato = await m.estornar({ pedidoId: 'ped_1', valor: 20, chaveIdempotencia: 'estorno-B' });
  igual([exato.codigo, exato.corpo?.status], [200, 'estornado'], 'exatamente o restante passa e completa');
  m.acumuladoNuncaPassaDoCobrado('excessivo');
}

/* =============== 5. RESPOSTA PERDIDA: a Asaas estornou e o 504 voltou =============== */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_depois');
  const primeira = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(primeira.codigo, 504, 'a primeira volta 504 (o contratante não sabe o que aconteceu)');
  const op = [...m.estornos.values()][0];
  igual(op.estado, 'UNKNOWN_PROVIDER_RESULT', 'a operação fica UNKNOWN, não "falhou"');
  ok(m.erros.some((e) => e.includes('AMBÍGUA')), 'e vira Lei 8');
  const repetida = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([repetida.codigo, repetida.corpo?.repetido, repetida.corpo?.valorEstornado], [200, true, 30], 'a repetição RECONCILIA pelo marcador e devolve o estorno que já aconteceu');
  igual(m.asaas.chamadas.length, 1, 'SEC-002, o cenário do achado: a repetição NÃO estorna de novo');
  igual(m.totalNaAsaas('pay_c1'), 3000, 'R$ 30, não R$ 60');
  igual([m.cobrancas.get('c1').status, Number(m.cobrancas.get('c1').valor_estornado)], ['estornado_parcialmente', 30], 'e a cobrança passa a dizer o que a Asaas fez');
  m.acumuladoNuncaPassaDoCobrado('resposta perdida');
}

/* ========== 6. TIMEOUT ANTES DE PROCESSAR: ausência só depois do prazo ========== */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_antes');
  igual((await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' })).codigo, 504, 'timeout antes de a Asaas processar');
  const cedo = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([cedo.codigo, cedo.corpo?.codigo], [409, 'estorno_em_reconciliacao'], 'logo depois: ainda não se sabe — 409, sem chamar');
  igual(m.asaas.chamadas.length, 1, 'nenhuma chamada nova antes de provar a ausência');
  m.avancar(MINUTOS_ATE_PROVAR_AUSENCIA + 1);
  const depois = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([depois.codigo, depois.corpo?.status], [200, 'estornado_parcialmente'], 'provada a ausência, a MESMA chave estorna');
  igual(m.asaas.chamadas.length, 2, 'uma chamada nova, uma só');
  igual(m.totalNaAsaas('pay_c1'), 3000, 'e a Asaas devolveu R$ 30 no total');
  m.acumuladoNuncaPassaDoCobrado('timeout antes');
}

/* ============== 7. QUEDA DO PROCESSO NO MEIO DA CHAMADA, E REINÍCIO ============== */
{
  // 7a. A Asaas estornou, o processo morreu antes de gravar CONFIRMED.
  const m = mundo();
  m.cobranca('c1');
  const transitarReal = m.depsServico.transitar;
  m.depsServico.transitar = async (id, de, campos) => {
    if (campos.estado === 'CONFIRMED' && de.length === 1 && de[0] === 'CALLING_PROVIDER') throw new Error('processo morreu (SIGKILL)');
    return transitarReal(id, de, campos);
  };
  const r = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  ok(r.codigo >= 500, `o pedido que morreu no meio não volta 200 (veio ${r.codigo})`);
  m.depsServico.transitar = transitarReal; // "reinício": o processo novo não tem o defeito
  igual([...m.estornos.values()][0].estado, 'CALLING_PROVIDER', 'a operação ficou em CALLING_PROVIDER — ninguém sabe dela além do registro');
  m.avancar(3);
  const passada = await reconciliarEstornosUmaVez(m.depsServico);
  igual(passada.confirmadas, 1, 'o worker, no processo novo, CONFIRMA pelo marcador na Asaas');
  igual([...m.estornos.values()][0].estado, 'CONFIRMED', 'a operação não fica invisível para sempre');
  igual(Number(m.cobrancas.get('c1').valor_estornado), 30, 'e a cobrança fica com o valor estornado');
  const repetida = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([repetida.codigo, repetida.corpo?.repetido], [200, true], 'o contratante que repete recebe o gravado');
  igual(m.asaas.chamadas.length, 1, 'e a Asaas foi chamada uma vez só');
  m.acumuladoNuncaPassaDoCobrado('queda depois de estornar');

  // 7b. O processo morreu DEPOIS de gravar e ANTES de reivindicar: nunca chamou.
  const n = mundo();
  n.cobranca('c1');
  const transitarN = n.depsServico.transitar;
  n.depsServico.transitar = async (id, de, campos) => {
    if (campos.estado === 'CALLING_PROVIDER') throw new Error('processo morreu antes de reivindicar');
    return transitarN(id, de, campos);
  };
  await n.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  n.depsServico.transitar = transitarN;
  igual([...n.estornos.values()][0].estado, 'PENDING', 'a operação ficou PENDING');
  igual(n.asaas.chamadas.length, 0, 'e a Asaas nunca foi chamada');
  n.avancar(3);
  await reconciliarEstornosUmaVez(n.depsServico);
  igual([...n.estornos.values()][0].estado, 'FAILED_RETRYABLE', 'PENDING velha vira FAILED_RETRYABLE — é certo que não chamou');
  const tentativa = await n.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([tentativa.codigo, n.asaas.chamadas.length], [200, 1], 'a mesma chave estorna uma vez');
  n.acumuladoNuncaPassaDoCobrado('queda antes de chamar');

  // 7c. Morreu no meio e a Asaas NÃO estornou: ausência provada só depois do prazo.
  const p = mundo();
  p.cobranca('c1');
  p.asaas.roteiro.push('timeout_antes');
  const transitarP = p.depsServico.transitar;
  p.depsServico.transitar = async (id, de, campos) => {
    if (campos.estado === 'UNKNOWN_PROVIDER_RESULT') throw new Error('processo morreu antes de gravar UNKNOWN');
    return transitarP(id, de, campos);
  };
  await p.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  p.depsServico.transitar = transitarP;
  p.avancar(3);
  await reconciliarEstornosUmaVez(p.depsServico);
  igual([...p.estornos.values()][0].estado, 'CALLING_PROVIDER', 'antes do prazo de ausência, o worker não decide nada');
  p.avancar(MINUTOS_ATE_PROVAR_AUSENCIA);
  await reconciliarEstornosUmaVez(p.depsServico);
  igual([...p.estornos.values()][0].estado, 'FAILED_RETRYABLE', 'depois do prazo, sem marcador e sem valor novo: provado que não estornou');
  igual(p.asaas.chamadas.length, 1, 'o worker nunca chama o estorno');
  m.acumuladoNuncaPassaDoCobrado('queda sem estornar');
}

/* ===== 7d. O WEBHOOK DO PRÓPRIO ESTORNO CHEGOU ANTES DO RECONCILIADOR (C1-04) =====
   A Asaas estornou, a resposta se perdeu (UNKNOWN), e o
   `PAYMENT_PARTIALLY_REFUNDED` — que costuma chegar em segundos — já
   gravou `valor_estornado = 30` na cobrança. Se o marcador não volta na
   lista da Asaas, a conta "Asaas − o que já sabemos" dá ZERO: a primeira
   versão tomava isso como prova de que nada foi estornado, a operação
   virava FAILED_RETRYABLE, e a mesma chave estornava 30 DE NOVO. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_depois');
  const a = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  ok(a.codigo >= 500 || a.corpo?.codigo, 'controle: a resposta da Asaas se perdeu');
  for (const r of m.asaas.refunds.get('pay_c1')) r.description = null; // o marcador não volta na lista
  m.cobrancas.get('c1').valor_estornado = 30;                          // o webhook do estorno já gravou
  m.cobrancas.get('c1').status = 'estornado_parcialmente';
  m.avancar(MINUTOS_ATE_PROVAR_AUSENCIA + 1);
  await reconciliarEstornosUmaVez(m.depsServico);
  const op = [...m.estornos.values()][0];
  ok(op.estado !== 'FAILED_RETRYABLE', `C1-04: o estorno que o webhook já registrou NÃO é "provado ausente" (ficou ${op.estado})`);
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(m.asaas.refunds.get('pay_c1').length, 1, 'C1-04: a repetição da mesma chave não estorna uma segunda vez na Asaas');
  igual(m.asaas.chamadas.length, 1, 'e nem chama o estorno de novo');
  m.avancar(MINUTOS_ATE_ALERTAR);
  await reconciliarEstornosUmaVez(m.depsServico);
  const alerta = m.erros.find((e) => /não permite decidir/.test(e)) ?? '';
  ok(alerta.includes(op.id) && alerta.includes('pay_c1'), 'o que não dá para decidir chama um humano, com a operação e a cobrança');
  ok(/RUNBOOK §6\.3/.test(alerta), 'C2-M1: e o alerta diz ONDE está o procedimento para resolver — antes ele só mandava "conferir"');
  const runbook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'RUNBOOK.md'), 'utf8');
  ok(/estorno <id> … a Asaas não permite decidir[\s\S]*?update estornos set estado = 'CONFIRMED'[\s\S]*?FAILED_RETRYABLE/.test(runbook), 'C2-M1: o RUNBOOK tem o procedimento, com as duas saídas (confirmar ou liberar a repetição)');
  /* controle: sem estorno nenhum na Asaas, a ausência continua provável */
  const n = mundo();
  n.cobranca('c1', { valor_estornado: 20, status: 'estornado_parcialmente' }); // estorno de 20 feito no painel, antes
  n.asaas.refunds.set('pay_c1', [{ value: 20, status: 'DONE', description: null, dateCreated: new Date().toISOString() }]);
  n.asaas.roteiro.push('timeout_antes');
  await n.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-B' });
  n.avancar(MINUTOS_ATE_PROVAR_AUSENCIA + 1);
  await reconciliarEstornosUmaVez(n.depsServico);
  igual([...n.estornos.values()][0].estado, 'FAILED_RETRYABLE', 'controle: a Asaas só tem o estorno de 20 (anterior, menor que 30) — este de 30 é provado ausente e pode ser refeito');
}

/* ===== 7e. ESTORNO DE BOLETO NEGADO PELA ASAAS (D-1, auditoria do diff) =====
   O estorno total de boleto é um PEDIDO: a operação fica CONFIRMED com
   `estorno_solicitado`. Se a Asaas o nega, a cobrança volta a
   `estorno_negado` — estornável de novo (API.md §5.4). Antes desta
   correção, a repetição com a chave padrão devolvia o 200 antigo sem
   chamar a Asaas, e uma chave nova recebia "não há valor restante". */
{
  const m = mundo();
  m.cobranca('c1', { metodo_pagamento: 'boleto' });
  const a = await m.estornar({ pedidoId: 'ped_1' });
  igual([a.codigo, [...m.estornos.values()][0].status_resultado], [200, 'estorno_solicitado'], 'controle: o pedido de estorno do boleto foi aceito');
  m.cobrancas.get('c1').status = 'estorno_negado'; // o PAYMENT_REFUND_DENIED chegou
  m.asaas.statusPagamento.set('pay_c1', 'RECEIVED');
  const b = await m.estornar({ pedidoId: 'ped_1', chaveIdempotencia: 'estorno-depois-da-negativa' });
  igual(b.codigo, 200, `D-1: com o estorno negado, uma chave nova estorna — o negado não conta como devolvido (${b.corpo?.erro ?? ''})`);
  igual(m.asaas.chamadas.length, 2, 'e a Asaas é chamada de novo');
  /* a mesma chave, depois de o webhook reabrir a operação (o que `reabrirEstornosNegados` faz no banco) */
  const n = mundo();
  n.cobranca('c1', { metodo_pagamento: 'boleto' });
  await n.estornar({ pedidoId: 'ped_1' });
  n.cobrancas.get('c1').status = 'estorno_negado';
  n.asaas.statusPagamento.set('pay_c1', 'RECEIVED');
  for (const op of n.estornos.values()) if (op.estado === 'CONFIRMED' && op.status_resultado === 'estorno_solicitado') Object.assign(op, { estado: 'FAILED_RETRYABLE' });
  const c = await n.estornar({ pedidoId: 'ped_1' });
  igual([c.codigo, c.corpo?.repetido ?? false, n.asaas.chamadas.length], [200, false, 2], 'D-1: reaberta, a MESMA chave (a padrão do total) pede de novo à Asaas — não devolve o 200 antigo');
}

/* ===== 7f. O "não cabe" PROVISÓRIO não fecha a chave de vez (D-4) ===== */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('recusa');
  await m.estornar({ pedidoId: 'ped_1' });                                 // total: recusa limpa → FAILED_RETRYABLE
  m.asaas.roteiro.push('timeout_antes');
  await m.estornar({ pedidoId: 'ped_1', valor: 100, chaveIdempotencia: 'parcial-100' }); // 100 em voo (sem resposta)
  m.avancar(6); // o arrendamento da cobrança (5 min) venceu; o parcial continua sem resposta
  const emVoo = await m.estornar({ pedidoId: 'ped_1' });
  igual(emVoo.corpo?.codigo, "estorno_anterior_em_reconciliacao", `com outro estorno em voo, o total responde 409 de "espere" (veio ${emVoo.codigo} ${JSON.stringify(emVoo.corpo)} — ops ${JSON.stringify([...m.estornos.values()].map((o) => [o.chave_idempotencia, o.estado]))})`);
  const total = [...m.estornos.values()].find((o) => o.total);
  igual(total.estado, 'FAILED_RETRYABLE', 'D-4: e a operação do total NÃO é fechada de vez — o "não cabe" é provisório');
  for (const o of m.estornos.values()) if (!o.total) o.estado = 'FAILED_RETRYABLE'; // o reconciliador provou que o parcial não aconteceu
  const depois = await m.estornar({ pedidoId: 'ped_1' });
  igual(depois.codigo, 200, `D-4: provado ausente o outro, a MESMA chave do total estorna (${depois.corpo?.erro ?? depois.corpo?.codigo ?? ''})`);
  m.acumuladoNuncaPassaDoCobrado('D-4');
}

/* ======= 8. OPERAÇÃO EM VOO CONTA NO RESTANTE (acumulado ≤ elegível) ======= */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_antes');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  m.avancar(6); // o arrendamento da cobrança (5 min) venceu; A continua UNKNOWN
  const b = await m.estornar({ pedidoId: 'ped_1', valor: 80, chaveIdempotencia: 'estorno-B' });
  igual([b.codigo, b.corpo?.codigo], [409, 'estorno_anterior_em_reconciliacao'], 'B de 80 com A (30) sem resposta: 100 − 30 em voo = 70 < 80 → 409');
  const b2 = await m.estornar({ pedidoId: 'ped_1', valor: 70, chaveIdempotencia: 'estorno-B2' });
  igual(b2.codigo, 200, 'B de 70 cabe mesmo se A tiver acontecido');
  m.acumuladoNuncaPassaDoCobrado('em voo');
}

/* ======================= 9. CONCORRÊNCIA =============================== */
{
  // 9a. A MESMA chave, duas requisições simultâneas.
  const m = mundo();
  m.cobranca('c1');
  let segunda = null;
  m.asaas.duranteChamada = async () => { if (!segunda) segunda = m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' }); await segunda; };
  const primeira = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  const outra = await segunda;
  igual(m.asaas.chamadas.length, 1, 'a mesma chave em paralelo chama a Asaas UMA vez');
  igual([primeira.codigo, outra.codigo].sort(), [200, 409], 'uma estorna, a outra recebe 409');

  // 9b. Chaves diferentes em paralelo, somando mais que o cobrado.
  const n = mundo();
  n.cobranca('c1');
  const [x, y] = await Promise.all([
    n.estornar({ pedidoId: 'ped_1', valor: 60, chaveIdempotencia: 'estorno-X' }),
    n.estornar({ pedidoId: 'ped_1', valor: 60, chaveIdempotencia: 'estorno-Y' })
  ]);
  igual([x.codigo, y.codigo].sort(), [200, 409], '60 + 60 sobre 100 em paralelo: só um passa');
  n.acumuladoNuncaPassaDoCobrado('concorrência');
}

/* =================== 10. RECUSA LIMPA, 429 E BOLETO =================== */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('recusa');
  const recusa = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(recusa.codigo, 400, 'recusa limpa da Asaas: o 4xx dela');
  igual([...m.estornos.values()][0].estado, 'FAILED_RETRYABLE', 'nada estornou: FAILED_RETRYABLE');
  igual(m.cobrancas.get('c1').estornando_em, null, 'e o arrendamento volta');
  const denovo = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([denovo.codigo, m.asaas.chamadas.length], [200, 2], 'a mesma chave tenta de novo com segurança');

  const n = mundo();
  n.cobranca('c1');
  n.asaas.roteiro.push('429');
  igual((await n.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' })).codigo, 429, '429 da Asaas volta 429');
  igual([...n.estornos.values()][0].estado, 'UNKNOWN_PROVIDER_RESULT', '429 é ambíguo — nunca "pode repetir"');
  ok(n.cobrancas.get('c1').estornando_em, 'e o arrendamento fica');

  const b = mundo();
  b.cobranca('c1', { metodo_pagamento: 'boleto' });
  igual((await b.estornar({ pedidoId: 'ped_1', valor: 10, chaveIdempotencia: 'estorno-A' })).codigo, 400, 'boleto não aceita parcial');
  const boleto = await b.estornar({ pedidoId: 'ped_1' });
  igual([boleto.codigo, boleto.corpo?.status], [200, 'estorno_solicitado'], 'boleto total: estorno_solicitado');
  igual((await b.estornar({ pedidoId: 'ped_1' })).corpo?.repetido, true, 'repetir o total do boleto devolve o gravado');
  igual(b.asaas.chamadas.length, 1, 'uma chamada só');
}

/* ======== 11. CHARGEBACK NO MEIO DA CHAMADA (SEC-022): quem chegou antes vence ======== */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.duranteChamada = async () => { m.cobrancas.get('c1').status = 'chargeback'; };
  const r = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(r.codigo, 200, 'o estorno aconteceu na Asaas');
  igual(m.cobrancas.get('c1').status, 'chargeback', 'a resposta atrasada NÃO apaga o chargeback que chegou pelo webhook');
  igual(m.cobrancas.get('c1').estornando_em, null, 'e o arrendamento volta mesmo assim');
}

/* ============ 12. QUAL COBRANÇA (SEC-005) E DUPLICIDADE (RN-52) ============ */
{
  const m = mundo();
  m.cobranca('pix', { criado_em: '2026-09-25T10:00:00Z' });
  m.cobranca('popup', { status: 'cancelado', metodo_pagamento: 'cartao_credito', criado_em: '2026-09-25T11:00:00Z' });
  const r = await m.estornar({ pedidoId: 'ped_1' });
  igual([r.codigo, r.corpo?.chargeId], [200, 'pay_pix'], 'a pop-up abandonada mais recente não esconde o Pix pago');

  const d = mundo();
  d.cobranca('a');
  d.cobranca('b', { metodo_pagamento: 'cartao_credito' });
  const sem = await d.estornar({ pedidoId: 'ped_1' });
  igual([sem.codigo, sem.corpo?.codigo], [409, 'mais_de_uma_cobranca_paga'], 'dois pagamentos: pede o chargeId');
  const com = await d.estornar({ pedidoId: 'ped_1', chargeId: 'pay_b' });
  igual([com.codigo, com.corpo?.chargeId], [200, 'pay_b'], 'com o chargeId, estorna a escolhida');
  igual((await d.estornar({ pedidoId: 'ped_1', chargeId: 'pay_de_outro' })).codigo, 404, 'chargeId que não é do pedido: 404');
  igual(d.asaas.chamadas.length, 1, 'uma chamada no total');
}

/* ===== 13. SÓ O MARCADOR DECIDE: um estorno feito no PAINEL da Asaas no meio =====
   O delta de valor deixa de bater (40 ≠ 30) e a regra do valor não pode
   decidir — é o marcador na `description` que prova que o NOSSO estorno
   aconteceu. Sem ele (ou sem mandá-lo), a operação ficaria em aberto e o
   contratante sem resposta. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_depois');
  m.asaas.duranteChamada = async () => {
    m.asaas.refunds.set('pay_c1', [{ value: 10, status: 'DONE', description: 'estorno manual no painel', dateCreated: '2026-09-25T12:00:00Z' }]);
    m.asaas.duranteChamada = null;
  };
  igual((await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' })).codigo, 504, 'resposta perdida');
  const repetida = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([repetida.codigo, repetida.corpo?.repetido], [200, true], 'o marcador prova o NOSSO estorno mesmo com o delta ambíguo');
  igual(repetida.corpo?.valorEstornado, 40, 'e o valor estornado é o que a Asaas diz (30 nosso + 10 do painel)');
  igual(m.asaas.chamadas.length, 1, 'sem segunda chamada');
  m.acumuladoNuncaPassaDoCobrado('painel no meio');
}

/* ===== 14. O CAS REAL de `registrarEstorno` (a suíte usa um dublê dele) =====
   O dublê acima imita a regra; esta checagem prova que a consulta de
   verdade ainda a tem — sem ela, a resposta atrasada de um estorno volta
   a apagar o chargeback que chegou no meio (SEC-022). */
{
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../src/services/cobrancaService.js', import.meta.url), 'utf8');
  const corpo = fonte.slice(fonte.indexOf('export async function registrarEstorno('));
  const funcao = corpo.slice(0, corpo.indexOf('\n}\n'));
  ok(/\.in\('status', \[\.\.\.STATUS_ESTORNAVEIS, 'estorno_solicitado'\]\)/.test(funcao), 'registrarEstorno só grava por cima de estado de onde o nosso estorno podia estar em curso');
  ok(/valor_estornado\.lt\./.test(funcao), 'e só AUMENTA o valor estornado');
  const servico = readFileSync(new URL('../src/services/estornoService.js', import.meta.url), 'utf8');
  ok(/descricao: marcador/.test(servico), 'o marcador vai para a Asaas na chamada de verdade');
  ok(/description: descricao/.test(readFileSync(new URL('../src/services/asaasService.js', import.meta.url), 'utf8')), 'e o adaptador o põe em `description`');
}

/* ============ SEC-018: COMPRA PARCELADA NÃO SE ESTORNA PELA API ============ */
{
  const m = mundo();
  m.cobranca('c1', { metodo_pagamento: 'cartao_credito', parcelas: 3 });
  m.asaas.parcelamento.set('pay_c1', 'ins_abc123');
  const total = await m.estornar({ pedidoId: 'ped_1' });
  igual([total.codigo, total.corpo?.codigo], [409, 'estorno_de_parcelamento'], 'SEC-018: estorno TOTAL de compra parcelada é recusado com código próprio');
  const parcial = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'parcial-parcelado' });
  igual([parcial.codigo, parcial.corpo?.codigo], [409, 'estorno_de_parcelamento'], 'e o PARCIAL também');
  igual(m.asaas.chamadas.length, 0, 'e a Asaas NUNCA recebe o estorno de uma parcela como se fosse o todo');
  igual(m.cobrancas.get('c1').estornando_em, null, 'o arrendamento volta — a cobrança não fica travada');
  igual(m.cobrancas.get('c1').status, 'confirmado', 'e nada muda nela');

  /* controle: cartão À VISTA (sem parcelamento na Asaas) estorna normalmente */
  const m2 = mundo();
  m2.cobranca('c2', { metodo_pagamento: 'cartao_credito', charge_id: 'pay_c2' });
  const vista = await m2.estornar({ pedidoId: 'ped_1' });
  igual([vista.codigo, vista.corpo?.status], [200, 'estornado'], 'controle: cartão à vista estorna');
  ok(m2.asaas.leituras === 1, 'depois de conferir UMA vez na Asaas se é parcelado');

  /* controle: Pix não vai à Asaas conferir parcelamento */
  const m3 = mundo();
  m3.cobranca('c3', { charge_id: 'pay_c3' });
  await m3.estornar({ pedidoId: 'ped_1' });
  igual(m3.asaas.leituras, 0, 'Pix não tem parcelamento: nenhuma leitura a mais');

  /* a conferência falhou: 502, nada estornado, arrendamento de volta */
  const m4 = mundo();
  m4.cobranca('c4', { metodo_pagamento: 'cartao_credito', charge_id: 'pay_c4' });
  m4.asaas.leituraFalha = true;
  const semLeitura = await m4.estornar({ pedidoId: 'ped_1' });
  igual(semLeitura.codigo, 502, 'sem conseguir conferir na Asaas, 502 — "não sei se é parcelado" nunca vira "não é"');
  igual([m4.asaas.chamadas.length, m4.cobrancas.get('c4').estornando_em], [0, null], 'nada estornado, arrendamento de volta');
}

/* ===== 15. A ARITMÉTICA DO RESTANTE, peça por peça (CP3-12) =====
   Cada termo de `restanteEstornavel` tinha um motivo escrito no
   comentário e nenhuma checagem: trocar qualquer um por uma versão mais
   "simples" passava as suítes. Aqui, a conta direta — e, em seguida, o
   cenário em que cada termo errado faz a Asaas ser chamada de novo.
   O `excetoId` fica de fora de propósito: nos dois chamadores a própria
   operação no banco está em FAILED_RETRYABLE (execução) ou em aberto
   (reconciliação, que só lê `confirmadas`/`jaEstornado`) — nenhum dos
   dois estados entra nesses termos. Só com um snapshot velho de uma
   operação já CONFIRMED ela contaria, e aí toda escrita da reconciliação
   perde o CAS (21a); tirá-lo não muda dinheiro nem estado. */
{
  const cob = (extras = {}) => ({ valor_cobrado: 100, valor_estornado: null, status: 'confirmado', ...extras });
  const op = (extras) => ({ id: 'op', estado: 'CONFIRMED', status_resultado: 'estornado_parcialmente', valor_centavos: 3000, ...extras });

  /* O já estornado é o MAIOR entre a cobrança e o registro de operações. */
  igual(restanteEstornavel(cob(), [op({})]).restante, 7000,
    'CP3-12: a gravação na cobrança se perdeu (valor_estornado nulo) e a operação CONFIRMED de R$ 30 ainda conta — restante R$ 70, não R$ 100');
  igual(restanteEstornavel(cob({ valor_estornado: 20, status: 'estornado_parcialmente' }), []).restante, 8000,
    'CP3-12: estorno de R$ 20 feito no painel (só a cobrança sabe dele) conta — restante R$ 80, não R$ 100');
  igual(restanteEstornavel(cob({ valor_estornado: 30, status: 'estornado_parcialmente' }), [op({})]).restante, 7000,
    'controle: cobrança e operação dizendo o mesmo R$ 30 não somam duas vezes');

  /* Só o PEDIDO de boleto negado deixa de contar — e só com a cobrança negada. */
  const pedidoBoleto = op({ status_resultado: 'estorno_solicitado', valor_centavos: 10000 });
  igual(restanteEstornavel(cob({ status: 'estorno_negado' }), [pedidoBoleto]).restante, 10000,
    'controle (D-1): negada a cobrança, o pedido de boleto que a Asaas negou não devolveu nada — restante R$ 100');
  igual(restanteEstornavel(cob(), [pedidoBoleto]).restante, 0,
    'CP3-12: com a cobrança NÃO negada, o pedido de boleto aceito conta como devolvido — restante R$ 0');
  igual(restanteEstornavel(cob({ status: 'estorno_negado' }), [op({})]).restante, 7000,
    'CP3-12: negada a cobrança, um parcial que DEVOLVEU (estornado_parcialmente) continua contando — só o `estorno_solicitado` é excluído');
  const reabertaAmbigua = op({ estado: 'UNKNOWN_PROVIDER_RESULT', status_resultado: 'estorno_solicitado', valor_centavos: 10000 });
  const r = restanteEstornavel(cob({ status: 'estorno_negado' }), [reabertaAmbigua]);
  igual([r.restante, r.emVoo], [0, 10000],
    'CP3-12: negada a cobrança, a NOVA tentativa ambígua (UNKNOWN, com o `estorno_solicitado` velho) conta como em voo — só o CONFIRMED negado sai da conta');
}

/* ===== 15a. Os mesmos termos, no caminho de verdade: a Asaas não é chamada de novo ===== */
{
  /* A gravação na cobrança falhou depois de a Asaas estornar R$ 30: só o
     registro de operações sabe. Um parcial de R$ 80 não cabe. */
  const m = mundo();
  m.cobranca('c1');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  Object.assign(m.cobrancas.get('c1'), { status: 'confirmado', valor_estornado: null });
  const b = await m.estornar({ pedidoId: 'ped_1', valor: 80, chaveIdempotencia: 'estorno-B' });
  igual([b.codigo, m.asaas.chamadas.length], [400, 1],
    `CP3-12: com a gravação da cobrança perdida, o registro de operações ainda segura o restante — 80 > 70 é recusado SEM chamar a Asaas (veio ${b.codigo}, ${m.asaas.chamadas.length} chamadas)`);
  /* O mesmo, com a cobrança em `estorno_negado` (a Asaas negou OUTRO pedido):
     a negativa só tira da conta o `estorno_solicitado`, nunca o parcial de
     R$ 30 que devolveu dinheiro. */
  m.cobrancas.get('c1').status = 'estorno_negado';
  const bNegada = await m.estornar({ pedidoId: 'ped_1', valor: 80, chaveIdempotencia: 'estorno-B2' });
  igual([bNegada.codigo, m.asaas.chamadas.length], [400, 1],
    `CP3-12: cobrança negada, o parcial que devolveu continua contando — 80 > 70 é recusado SEM chamar a Asaas (veio ${bNegada.codigo}, ${m.asaas.chamadas.length} chamadas)`);

  /* Estorno de R$ 20 feito no painel e gravado pelo webhook: só a cobrança
     sabe. Com A (30) sem resposta, um parcial de 60 só caberia se a conta
     esquecesse um dos dois: 100 − 20 − 30 = 50. (A pré-conferência do
     controlador vê só os 20 da cobrança e deixa passar; quem segura é o
     serviço.) */
  const n = mundo();
  n.cobranca('c1', { valor_estornado: 20, status: 'estornado_parcialmente' });
  n.asaas.refunds.set('pay_c1', [{ value: 20, status: 'DONE', description: 'estorno manual no painel', dateCreated: '2026-09-25T11:00:00Z' }]);
  n.asaas.roteiro.push('timeout_antes');
  await n.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  n.avancar(6); // o arrendamento da cobrança venceu; A continua sem resposta
  const excede = await n.estornar({ pedidoId: 'ped_1', valor: 60, chaveIdempotencia: 'estorno-B' });
  igual([excede.corpo?.codigo, n.asaas.chamadas.length], ['estorno_anterior_em_reconciliacao', 1],
    `CP3-12: o estorno do painel (só na cobrança) E o em voo contam — 60 > 50 espera, SEM chamar a Asaas (veio ${excede.codigo} ${excede.corpo?.codigo ?? excede.corpo?.erro}, ${n.asaas.chamadas.length} chamadas)`);

  /* Boleto: a Asaas aceitou o pedido, a gravação na cobrança se perdeu
     (continua `confirmado`). Uma chave nova do total NÃO pede de novo. */
  const b2 = mundo();
  b2.cobranca('c1', { metodo_pagamento: 'boleto' });
  await b2.estornar({ pedidoId: 'ped_1' });
  Object.assign(b2.cobrancas.get('c1'), { status: 'confirmado', estornando_em: null });
  const denovo = await b2.estornar({ pedidoId: 'ped_1', chaveIdempotencia: 'outra-chave-do-total' });
  igual([denovo.codigo, b2.asaas.chamadas.length], [400, 1],
    `CP3-12: pedido de boleto aceito e cobrança não negada — o pedido conta como devolvido e o boleto não é pedido duas vezes (veio ${denovo.codigo}, ${b2.asaas.chamadas.length} chamadas)`);

  /* Boleto negado, reaberto, e a nova tentativa ficou AMBÍGUA (UNKNOWN com
     o `estorno_solicitado` velho). Uma chave nova não pode pedir por cima. */
  const b3 = mundo();
  b3.cobranca('c1', { metodo_pagamento: 'boleto' });
  await b3.estornar({ pedidoId: 'ped_1' });
  b3.cobrancas.get('c1').status = 'estorno_negado';
  b3.asaas.statusPagamento.set('pay_c1', 'RECEIVED');
  for (const o of b3.estornos.values()) Object.assign(o, { estado: 'FAILED_RETRYABLE' }); // o que `reabrirEstornosNegados` faz
  b3.asaas.roteiro.push('timeout_depois');
  const ambigua = await b3.estornar({ pedidoId: 'ped_1' });
  igual([ambigua.codigo, [...b3.estornos.values()][0].estado, [...b3.estornos.values()][0].status_resultado], [504, 'UNKNOWN_PROVIDER_RESULT', 'estorno_solicitado'],
    'controle: a nova tentativa do boleto negado ficou ambígua, ainda com o `estorno_solicitado` da primeira');
  b3.avancar(6); // o arrendamento da cobrança venceu; a operação continua sem resposta
  const porCima = await b3.estornar({ pedidoId: 'ped_1', chaveIdempotencia: 'total-com-outra-chave' });
  igual([porCima.corpo?.codigo, b3.asaas.chamadas.length], ['estorno_anterior_em_reconciliacao', 2],
    `CP3-12: a tentativa ambígua conta como em voo — a chave nova espera, e o boleto não é pedido uma terceira vez (veio ${porCima.codigo} ${porCima.corpo?.codigo ?? porCima.corpo?.erro}, ${b3.asaas.chamadas.length} chamadas)`);
}

/* ===== 16. O "não cabe" DEFINITIVO fecha a chave de vez (FAILED_FINAL) =====
   O D-4 (7f) provou o lado provisório; o definitivo não tinha checagem.
   Sem nada em voo, a chave que não cabe mais vira FAILED_FINAL e a
   repetição responde `estorno_impossivel` sem nem disputar o
   arrendamento — em vez de reavaliar a cada repetição.
   A gravação de B na cobrança se perde (como quando `registrarNaCobranca`
   lança depois de a Asaas estornar): a pré-conferência do controlador,
   que lê a cobrança, deixa A passar, e é o registro de operações, no
   serviço, que diz que não cabe. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('recusa');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' }); // recusa limpa → FAILED_RETRYABLE
  await m.estornar({ pedidoId: 'ped_1', valor: 80, chaveIdempotencia: 'estorno-B' }); // restante agora R$ 20
  Object.assign(m.cobrancas.get('c1'), { status: 'confirmado', valor_estornado: null }); // a gravação de B se perdeu
  const a = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(a.codigo, 400, `a repetição de A (30) não cabe nos R$ 20 que sobraram (veio ${a.codigo} ${a.corpo?.erro ?? a.corpo?.codigo})`);
  const opA = [...m.estornos.values()].find((o) => o.chave_idempotencia === 'estorno-A');
  igual(opA.estado, 'FAILED_FINAL', 'CP3-12: sem nada em voo, o "não cabe" é definitivo e a operação de A é FECHADA (FAILED_FINAL)');
  const r = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([r.codigo, r.corpo?.codigo], [409, 'estorno_impossivel'],
    `CP3-12: fechada, a repetição de A responde 409 estorno_impossivel com o motivo gravado (veio ${r.codigo} ${r.corpo?.codigo ?? r.corpo?.erro})`);
  ok(/não comporta/.test(r.corpo?.erro ?? ''), 'e o motivo é o gravado na operação');
  igual([m.asaas.chamadas.length, m.cobrancas.get('c1').estornando_em], [2, null], 'e a Asaas não é chamada, nem a cobrança fica presa');
}

/* ===== 17. BOLETO: ausência só depois do prazo, mesmo com a Asaas atrasada (CP3-12) =====
   O estorno de boleto é um pedido assíncrono. A Asaas aceitou, a
   resposta se perdeu, e o status do pagamento ainda não mudou para
   REFUND_REQUESTED. Antes dos 15 minutos, "o status não mudou" NÃO é
   prova de que o pedido não existe: liberar a repetição cedo pediria o
   estorno do mesmo boleto duas vezes. */
{
  const m = mundo();
  m.cobranca('c1', { metodo_pagamento: 'boleto' });
  m.asaas.roteiro.push('timeout_depois');
  igual((await m.estornar({ pedidoId: 'ped_1' })).codigo, 504, 'o pedido do boleto foi aceito e a resposta se perdeu');
  m.asaas.statusPagamento.set('pay_c1', 'RECEIVED'); // a Asaas ainda não refletiu o pedido
  m.avancar(6); // o arrendamento da cobrança (5 min) venceu; ainda dentro dos 15 min
  const cedo = await m.estornar({ pedidoId: 'ped_1' });
  igual([cedo.corpo?.codigo, m.asaas.chamadas.length], ['estorno_em_reconciliacao', 1],
    `CP3-12: antes do prazo de ausência, o boleto NÃO é pedido de novo (veio ${cedo.codigo} ${cedo.corpo?.codigo ?? cedo.corpo?.erro}, ${m.asaas.chamadas.length} chamadas)`);
  igual([...m.estornos.values()][0].estado, 'UNKNOWN_PROVIDER_RESULT', 'e a operação continua em aberto');
  m.asaas.statusPagamento.set('pay_c1', 'REFUND_REQUESTED'); // a Asaas refletiu
  const depois = await m.estornar({ pedidoId: 'ped_1' });
  igual([depois.codigo, depois.corpo?.repetido, depois.corpo?.status, m.asaas.chamadas.length], [200, true, 'estorno_solicitado', 1],
    'controle: refletido o pedido, a reconciliação confirma sem chamar de novo');
}

/* ===== 18. A PROVA PELO VALOR só vale com UMA operação em aberto (CP3-12) =====
   Duas operações de R$ 30 sem resposta, um estorno de R$ 30 na Asaas sem
   marcador: o delta bate com as DUAS, e qualquer uma que se declarasse
   "provada" deixaria a outra ser provada ausente e repetida — o dinheiro
   atribuído à operação errada. Fica em aberto e chama um humano. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_depois');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' }); // estornou, sem resposta
  m.avancar(6);
  m.asaas.roteiro.push('timeout_antes');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-B' }); // NÃO estornou, sem resposta
  for (const r of m.asaas.refunds.get('pay_c1')) r.description = null; // o marcador não volta
  m.avancar(MINUTOS_ATE_PROVAR_AUSENCIA + 1);
  await reconciliarEstornosUmaVez(m.depsServico);
  const estados = [...m.estornos.values()].map((o) => o.estado);
  igual(estados, ['UNKNOWN_PROVIDER_RESULT', 'UNKNOWN_PROVIDER_RESULT'],
    `CP3-12: com duas em aberto, o delta de R$ 30 não prova nenhuma das duas (ficaram ${estados.join(', ')})`);
  m.avancar(MINUTOS_ATE_ALERTAR);
  await reconciliarEstornosUmaVez(m.depsServico);
  ok(m.erros.filter((e) => /não permite decidir/.test(e)).length >= 2, 'e as duas chamam um humano');
}

/* ===== 19. ESTORNO CANCELADO na Asaas não é estorno feito (CP3-12) =====
   O NOSSO estorno aparece na lista com o marcador, mas CANCELLED: o
   dinheiro não saiu. Contá-lo confirmaria a operação e o contratante
   receberia "estornado" de um estorno que não aconteceu. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('timeout_depois');
  await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  for (const r of m.asaas.refunds.get('pay_c1')) r.status = 'CANCELLED';
  m.avancar(MINUTOS_ATE_PROVAR_AUSENCIA + 1);
  await reconciliarEstornosUmaVez(m.depsServico);
  igual([...m.estornos.values()][0].estado, 'FAILED_RETRYABLE',
    `CP3-12: o estorno com o marcador mas CANCELLED não confirma a operação — provado ausente (ficou ${[...m.estornos.values()][0].estado})`);
  const repetida = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual([repetida.codigo, repetida.corpo?.repetido ?? false, m.totalNaAsaas('pay_c1')], [200, false, 3000],
    'e a mesma chave estorna de verdade — o contratante não recebe "estornado" de um cancelado');
}

/* ===== 20. O ARRENDAMENTO DA CHAMADA EM CURSO: o worker não decide por ela (CP3-12) =====
   Enquanto a requisição viva espera a Asaas, aparece na lista um estorno
   de R$ 30 feito no painel (o webhook dele ainda não chegou). O delta
   bate com a operação em curso, e sem o arrendamento o worker a
   "provaria" pelo valor. A Asaas então RECUSA o nosso — e a operação
   ficaria CONFIRMED: a repetição responderia "estornado" de um estorno
   que não aconteceu. */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.roteiro.push('recusa');
  let passada = null;
  m.asaas.duranteChamada = async () => {
    m.asaas.duranteChamada = null;
    m.asaas.refunds.set('pay_c1', [{ value: 30, status: 'DONE', description: 'estorno manual no painel', dateCreated: '2026-09-25T12:00:00Z' }]);
    passada = await reconciliarEstornosUmaVez(m.depsServico);
  };
  const r = await m.estornar({ pedidoId: 'ped_1', valor: 30, chaveIdempotencia: 'estorno-A' });
  igual(r.codigo, 400, 'a Asaas recusou o nosso estorno');
  igual([passada?.confirmadas, passada?.aguardando], [0, 1], 'CP3-12: o worker, no meio da chamada viva, não decide por ela');
  igual([...m.estornos.values()][0].estado, 'FAILED_RETRYABLE',
    `CP3-12: recusado, o nosso estorno fica FAILED_RETRYABLE — não CONFIRMED pelo valor do estorno do painel (ficou ${[...m.estornos.values()][0].estado})`);
}

/* ===== 21. O BANCO DE VERDADE (CP3-10, CP3-11, CP3-12) =====
   Os blocos acima usam um dublê de `transitar`, de `reabrirEstornosNegados`
   e do arrendamento da cobrança — então as consultas reais podiam perder a
   condição que as torna seguras sem nenhuma suíte ver. Aqui rodam as
   funções REAIS de `estornoService`/`cobrancaService` num processo filho,
   sobre o banco falso (`tests/banco-falso/`), com a Asaas trocada por um
   `fetch` roteirizado. */
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const COB = '00000000-0000-4000-8000-000000000001';
const OP = '00000000-0000-4000-8000-0000000000aa';
const minutosAtras = (min) => new Date(Date.now() - min * 60_000).toISOString();
const cobrancaReal = (extras = {}) => ({ id: COB, contratante_id: 'loja', pedido_id: 'ped_1', charge_id: 'pay_1', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 100, valor_estornado: null, estornando_em: null, ...extras });

async function noBancoFalso({ tabelas, asaas = {}, codigo }) {
  const pasta = mkdtempSync(join(tmpdir(), 'estorno-banco-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [{ id: 'loja', api_key: 'k' }], estornos: [], ...tabelas } }));
  const programa = `
    const chamadas = [];
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      const chave = (opcoes.method ?? 'GET') + ' ' + u.pathname;
      chamadas.push(chave);
      const resp = ${JSON.stringify(asaas)}[chave] ?? { status: 500, corpo: { errors: [{ description: 'fora do roteiro: ' + chave }] } };
      return new Response(JSON.stringify(resp.corpo), { status: resp.status, headers: { 'content-type': 'application/json' } });
    };
    const es = await import('./src/services/estornoService.js');
    const cs = await import('./src/services/cobrancaService.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const ler = () => JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8')).tabelas;
    const mexer = (fn) => { const e = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8')); fn(e.tabelas); writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(e)); };
    const gancho = { reivindicar: cs.reivindicarEstorno, liberar: cs.liberarEstorno, registrarNaCobranca: cs.registrarEstorno };
    const saida = {};
    ${codigo}
    saida.chamadas = chamadas;
    console.log(JSON.stringify(saida));
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', programa], {
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

/* 21a. CP3-10 — o CAS de `transitar`. O reconciliador leu a operação em
   UNKNOWN; antes de ele escrever, uma repetição da mesma chave a provou
   CONFIRMED (R$ 30 devolvidos). A lista da Asaas, lida por ele, ainda
   veio sem o marcador, e o snapshot velho diz "ausência provada". Sem a
   condição de estado no UPDATE, a escrita dele desfazia o CONFIRMED — e a
   repetição seguinte da mesma chave estornava R$ 30 DE NOVO. */
{
  const confirmada = { id: OP, cobranca_id: COB, contratante_id: 'loja', charge_id: 'pay_1', chave_idempotencia: 'A', valor_centavos: 3000, total: false, estado: 'CONFIRMED', status_resultado: 'estornado_parcialmente', valor_estornado_depois: 30, marcador: 'san-estorno:' + OP, tentativas: 1, chamando_em: null, ultimo_erro: null, criado_em: minutosAtras(30), atualizado_em: minutosAtras(1) };
  const { saida, banco } = await noBancoFalso({
    tabelas: { cobrancas: [cobrancaReal()], estornos: [confirmada] },
    asaas: { 'GET /v3/payments/pay_1/refunds': { status: 200, corpo: { data: [], hasMore: false } }, 'POST /v3/payments/pay_1/refund': { status: 200, corpo: { status: 'REFUNDED' } } },
    codigo: `
      const velho = { ...ler().estornos[0], estado: 'UNKNOWN_PROVIDER_RESULT', status_resultado: null, chamando_em: new Date(Date.now() - 30 * 60_000).toISOString() };
      saida.reconciliada = (await es.reconciliarOperacao(velho)).estado;
      saida.depoisDoReconciliador = ler().estornos[0].estado;
      const r = await es.executarEstorno({ contratante: { id: 'loja' }, cobranca: ler().cobrancas[0], chave: 'A', valorCentavos: 3000 }, gancho);
      saida.repeticao = [r.http, r.corpo.repetido ?? false];
    `
  });
  igual(saida.depoisDoReconciliador, 'CONFIRMED',
    `CP3-10: o reconciliador com o snapshot velho NÃO sobrescreve a operação já CONFIRMED no banco (ficou ${saida.depoisDoReconciliador})`);
  igual(saida.repeticao, [200, true], 'CP3-10: a repetição da mesma chave devolve o estorno gravado');
  igual(saida.chamadas.filter((c) => c.startsWith('POST')).length, 0, 'CP3-10: e a Asaas NÃO recebe um segundo estorno de R$ 30');
  igual(banco.estornos[0].estado, 'CONFIRMED', 'e o registro termina CONFIRMED');

  /* controle: a MESMA escrita, com a operação de fato em aberto no banco, passa */
  const aberta = { ...confirmada, estado: 'UNKNOWN_PROVIDER_RESULT', status_resultado: null, valor_estornado_depois: null, chamando_em: minutosAtras(30) };
  const controle = await noBancoFalso({
    tabelas: { cobrancas: [cobrancaReal()], estornos: [aberta] },
    asaas: { 'GET /v3/payments/pay_1/refunds': { status: 200, corpo: { data: [], hasMore: false } } },
    codigo: `saida.reconciliada = (await es.reconciliarOperacao(ler().estornos[0])).estado;`
  });
  igual([controle.saida.reconciliada, controle.banco.estornos[0].estado], ['FAILED_RETRYABLE', 'FAILED_RETRYABLE'],
    'controle: com a operação em aberto no banco, a ausência provada é gravada — o CAS não é uma escrita que nunca acontece');
}

/* 21b. CP3-11 — `reabrirEstornosNegados` só reabre o pedido CONFIRMED. Boleto:
   pedido aceito, NEGADO, reaberto; a nova tentativa ficou AMBÍGUA (UNKNOWN,
   com o `estorno_solicitado` velho). A negativa velha chega de novo
   (reentrega). Reabrir a ambígua liberaria a mesma chave para pedir por cima
   de um estorno que pode ter acontecido. */
{
  const COB2 = '00000000-0000-4000-8000-000000000002';
  const opBoleto = (id, cobrancaId, extras) => ({ id, cobranca_id: cobrancaId, contratante_id: 'loja', charge_id: cobrancaId === COB ? 'pay_1' : 'pay_2', chave_idempotencia: 'total-' + cobrancaId, valor_centavos: 10000, total: true, status_resultado: 'estorno_solicitado', marcador: 'san-estorno:' + id, tentativas: 1, chamando_em: null, criado_em: minutosAtras(60), atualizado_em: minutosAtras(1), ...extras });
  const { saida, banco } = await noBancoFalso({
    tabelas: {
      cobrancas: [cobrancaReal({ metodo_pagamento: 'boleto', status: 'estorno_negado' }), cobrancaReal({ id: COB2, charge_id: 'pay_2', metodo_pagamento: 'boleto', status: 'estorno_negado' })],
      estornos: [
        opBoleto(OP, COB, { estado: 'UNKNOWN_PROVIDER_RESULT', tentativas: 2, chamando_em: minutosAtras(1) }),
        opBoleto('00000000-0000-4000-8000-0000000000bb', COB2, { estado: 'CONFIRMED' })
      ]
    },
    codigo: `
      saida.ambigua = await es.reabrirEstornosNegados('${COB}');
      saida.confirmada = await es.reabrirEstornosNegados('${COB2}');
    `
  });
  const porId = Object.fromEntries(banco.estornos.map((o) => [o.cobranca_id, o.estado]));
  igual([saida.ambigua, porId[COB]], [0, 'UNKNOWN_PROVIDER_RESULT'],
    `CP3-11: a negativa NÃO reabre a tentativa ambígua, que pode ter estornado (reabriu ${saida.ambigua}, ficou ${porId[COB]})`);
  igual([saida.confirmada, porId[COB2]], [1, 'FAILED_RETRYABLE'], 'controle: o pedido CONFIRMED que a Asaas negou é reaberto');
}

/* 21c. O arrendamento REAL da cobrança (`reivindicarEstorno`): só de um
   estado estornável, e um de cada vez. O dublê do `mundo()` imita as duas
   condições; aqui se prova que a consulta de verdade ainda as tem. */
{
  const linhas = [
    ['confirmado', null], ['estornado_parcialmente', null], ['estorno_negado', null],
    ['pendente', null], ['estornado', null], ['estorno_solicitado', null], ['chargeback', null], ['cancelado', null],
    ['confirmado', minutosAtras(1)], ['confirmado', minutosAtras(6)]
  ].map(([status, estornando_em], i) => cobrancaReal({ id: `00000000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`, charge_id: `pay_${i}`, status, estornando_em }));
  const { saida } = await noBancoFalso({
    tabelas: { cobrancas: linhas },
    codigo: `
      saida.primeira = [];
      for (let i = 0; i < ${linhas.length}; i += 1) saida.primeira.push(await cs.reivindicarEstorno('pay_' + i));
      saida.segunda = await cs.reivindicarEstorno('pay_0');
      await cs.liberarEstorno('pay_0');
      saida.depoisDeLiberar = await cs.reivindicarEstorno('pay_0');
    `
  });
  igual(saida.primeira.slice(0, 3), [true, true, true], 'controle: confirmado, estornado_parcialmente e estorno_negado são estornáveis');
  igual(saida.primeira.slice(3, 8), [false, false, false, false, false],
    `CP3-12: pendente, estornado, estorno_solicitado, chargeback e cancelado NÃO são reivindicáveis para estorno (veio ${JSON.stringify(saida.primeira.slice(3, 8))})`);
  igual(saida.primeira[8], false, 'CP3-12: com o arrendamento de outro estorno vivo (1 min), a cobrança NÃO é reivindicada');
  igual(saida.segunda, false, 'CP3-12: e a segunda reivindicação seguida da MESMA cobrança perde — um estorno de cada vez');
  igual([saida.primeira[9], saida.depoisDeLiberar], [true, true], 'controle: arrendamento vencido (6 min) ou liberado volta a poder');
}

/* ======= FP2RA-2: o webhook gravou antes — o aviso é dele, não da rota ======= */
/* O PAYMENT_REFUNDED chega e é aplicado enquanto a rota ainda espera a
   resposta da Asaas. A escrita da rota perde o CAS; se ela avisasse mesmo
   assim, o contratante ouvia um segundo `estornado` com `eventoId` novo
   (o webhook, que APLICOU a transição, re-chaveia o fato). */
{
  const m = mundo();
  m.cobranca('c1');
  m.asaas.duranteChamada = async () => { const c = m.cobrancas.get('c1'); c.status = 'estornado'; c.valor_estornado = 100; };
  const r = await m.estornar({ pedidoId: 'ped_1' });
  igual(r.codigo, 200, 'FP2RA-2: o estorno total responde normalmente');
  igual(m.asaas.chamadas.length, 1, 'e a Asaas foi chamada uma vez');
  igual(m.avisos.length, 0, 'FP2RA-2: a rota NÃO avisa — o webhook que gravou antes é quem avisa');
}
/* controle: sem o webhook no meio, a rota avisa (uma vez) */
{
  const m = mundo();
  m.cobranca('c1');
  await m.estornar({ pedidoId: 'ped_1' });
  igual(m.avisos.length, 1, 'controle: a rota que gravou avisa o contratante');
}

console.log(`estorno-repetido-nao-devolve-duas-vezes: ${checagens} checagens OK`);
