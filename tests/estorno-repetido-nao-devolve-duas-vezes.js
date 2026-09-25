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

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { criarRefundController } = await import('../src/controllers/refundController.js');
const { executarEstorno, reconciliarEstornosUmaVez, ESTADOS_EM_ABERTO, MINUTOS_ATE_PROVAR_AUSENCIA, MINUTOS_ATE_ALERTAR } = await import('../src/services/estornoService.js');
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
    operacoesDaCobranca: async (cid) => [...estornos.values()].filter((o) => o.cobranca_id === cid).map((o) => ({ id: o.id, estado: o.estado, valor_centavos: o.valor_centavos })),
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
  ok(m.erros.some((e) => /não permite decidir/.test(e)), 'o que não dá para decidir chama um humano, com o valor e a cobrança');
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

console.log(`estorno-repetido-nao-devolve-duas-vezes: ${checagens} checagens OK`);
