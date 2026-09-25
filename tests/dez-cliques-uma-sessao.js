#!/usr/bin/env node
/**
 * tests/dez-cliques-uma-sessao.js
 *
 * C-04 da auditoria de 24/09/2026 — **reserva antes da Asaas**:
 *
 *   dez requisições SIMULTÂNEAS do mesmo comprador, para o mesmo
 *   pedido (cartão) ou plano (assinatura), produzem UMA sessão pagável
 *   na Asaas. As outras nove reaproveitam a sessão da primeira, ou
 *   recebem "em andamento" — nunca uma segunda `POST /v3/checkouts`.
 *
 * E o mesmo para Pix: dez `POST /pix` simultâneos, UMA
 * `POST /v3/payments`.
 *
 * POR QUE ISTO MERECE TESTE
 * A ordem antiga era sessão-na-Asaas → linha local. O índice único
 * barrava a segunda LINHA, não a segunda SESSÃO: sobrava na Asaas uma
 * sessão pagável que ninguém do nosso lado conhecia. A correção
 * inverteu a ordem; este teste é o que impede a ordem de voltar — com
 * um banco de mentira que honra o índice único, e dez requisições de
 * verdade disparadas ao mesmo tempo, não uma atrás da outra.
 *
 * Sabotagem verificada: trocar `reservarCobrancaPopup` para não honrar
 * o índice (sempre `reservada: true`) faz o teste reprovar com "10
 * sessões". Reordenar `criarSessao` para antes da reserva, idem.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { abrirSessaoComReserva } = await import('../src/controllers/asaasCheckoutController.js');
const { criarCheckoutController } = await import('../src/controllers/checkoutController.js');

let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.equal(a, b, m); checagens += 1; };

/* Um "banco" que honra o índice único parcial de `cobrancas`:
   (contratante, pedido, método) para pedido; (contratante, plano,
   documento, método) para assinatura — só linhas `pendente`. Cada
   chamada cede o event loop (como o banco real cede), para as dez
   requisições se entrelaçarem de verdade. */
function bancoFalso() {
  const linhas = new Map();
  let proximo = 1;
  const chaveDe = (r) => (r.pedidoId
    ? `${r.contratanteId}|ped:${r.pedidoId}|${r.metodoPagamento}`
    : `${r.contratanteId}|pl:${r.planoId}|${r.documento}|${r.metodoPagamento}`);
  const ceder = () => new Promise((r) => setTimeout(r, 1));
  return {
    linhas,
    reservarCobrancaPopup: async (reserva) => {
      await ceder();
      const chave = chaveDe(reserva);
      const existente = linhas.get(chave);
      if (existente) return { reservada: false, existente };
      const id = `res_${proximo++}`;
      linhas.set(chave, { id, asaas_checkout_id: null, status: 'pendente' });
      return { reservada: true, id };
    },
    completar: async (id, asaasCheckoutId) => {
      await ceder();
      for (const l of linhas.values()) if (l.id === id) l.asaas_checkout_id = asaasCheckoutId;
    },
    liberarReservaCobranca: async (id) => { for (const [k, l] of linhas) if (l.id === id) linhas.delete(k); },
    registrarErro: async () => {},
    foiRecusaLimpaDaAsaas: (e) => e?.status === 400
  };
}

/* ------------------------------------------------------------------
   1. Pop-up (cartão avulso): 10 cliques, 1 sessão
------------------------------------------------------------------ */
{
  const banco = bancoFalso();
  let sessoesNaAsaas = 0;
  const criarSessao = async (externalReference) => {
    sessoesNaAsaas += 1;
    await new Promise((r) => setTimeout(r, 5)); // a Asaas demora — é aqui que as outras nove chegam
    return { asaasCheckoutId: `chk_${externalReference}` };
  };
  const reserva = { contratanteId: 'c1', pedidoId: 'ped_1', documento: '11144477735', metodoPagamento: 'cartao_credito' };
  const resultados = await Promise.all(Array.from({ length: 10 }, () =>
    abrirSessaoComReserva({ reserva, criarSessao, completar: banco.completar, contexto: 'cartao' }, banco)
  ));

  igual(sessoesNaAsaas, 1, `C-04: dez cliques simultâneos abriram ${sessoesNaAsaas} sessões na Asaas — tinha que ser UMA`);
  igual(resultados.filter((r) => r.tipo === 'criada').length, 1, 'exatamente uma requisição criou');
  ok(resultados.every((r) => ['criada', 'reaproveitada', 'em_andamento'].includes(r.tipo)), 'as outras nove reaproveitam ou esperam');
  igual(banco.linhas.size, 1, 'uma linha local, não dez');
  ok(resultados.every((r) => r.tipo === 'em_andamento' || r.asaasCheckoutId === 'chk_reserva-res_1'), 'quem reaproveitou recebeu a MESMA sessão');
  ok(/^reserva-res_1$/.test([...banco.linhas.values()][0].asaas_checkout_id.replace(/^chk_/, '')), 'a sessão levou externalReference = reserva-<id da linha>');
}

/* ------------------------------------------------------------------
   2. Pop-up (assinatura): mesmo comprador, mesmo plano — 1 sessão;
      comprador DIFERENTE no mesmo plano — sessão própria
------------------------------------------------------------------ */
{
  const banco = bancoFalso();
  let sessoes = 0;
  const criarSessao = async (ref) => { sessoes += 1; await new Promise((r) => setTimeout(r, 5)); return { asaasCheckoutId: `chk_${ref}` }; };
  const maria = { contratanteId: 'mostrai', planoId: 'plano_pro', documento: '52998224725', metodoPagamento: 'assinatura' };
  const joao = { ...maria, documento: '11144477735' };
  await Promise.all([
    ...Array.from({ length: 10 }, () => abrirSessaoComReserva({ reserva: maria, criarSessao, completar: banco.completar, contexto: 'assinatura' }, banco)),
    ...Array.from({ length: 10 }, () => abrirSessaoComReserva({ reserva: joao, criarSessao, completar: banco.completar, contexto: 'assinatura' }, banco))
  ]);
  igual(sessoes, 2, 'dois compradores no mesmo plano: duas sessões, uma para cada — nunca 20');
  igual(banco.linhas.size, 2);
}

/* ------------------------------------------------------------------
   3. Recusa limpa da Asaas libera a reserva; falha ambígua NÃO libera
      (a sessão pode existir — o webhook/reconciliador decidem)
------------------------------------------------------------------ */
{
  const banco = bancoFalso();
  const reserva = { contratanteId: 'c1', pedidoId: 'ped_2', documento: '1', metodoPagamento: 'cartao_credito' };
  const limpa = Object.assign(new Error('400'), { status: 400 });
  await assert.rejects(() => abrirSessaoComReserva({ reserva, criarSessao: async () => { throw limpa; }, completar: banco.completar, contexto: 'cartao' }, banco));
  igual(banco.linhas.size, 0, 'recusa limpa: a reserva é liberada — o comprador pode tentar de novo');
  const ambigua = Object.assign(new Error('timeout'), { status: 504 });
  await assert.rejects(() => abrirSessaoComReserva({ reserva, criarSessao: async () => { throw ambigua; }, completar: banco.completar, contexto: 'cartao' }, banco));
  igual(banco.linhas.size, 1, 'falha ambígua: a reserva FICA — a sessão pode ter nascido lá');
}

/* ------------------------------------------------------------------
   4. Pix direto: 10 POST /pix simultâneos, 1 POST /v3/payments
------------------------------------------------------------------ */
{
  const linhas = new Map();
  let proximo = 1;
  let pagamentosNaAsaas = 0;
  const ceder = () => new Promise((r) => setTimeout(r, 1));
  const pedidoBase = { pedidoId: 'ped_pix', status: 'pendente', valorCheio: 100, valorComDesconto: 100, desconto: 0, frete: 0, taxaDoProjeto: 0, isentarTaxa: false, itens: [], descricao: 'X' };
  const deps = {
    resolverPedido: async () => ({ contratante: { id: 'c1', wallet_id: null }, pedido: pedidoBase }),
    exigirCotacaoParaCobrar: async ({ cotacaoId, totaisNovos }) => ({ id: cotacaoId, totais: totaisNovos }),
    marcarCotacaoUsada: async () => {},
    buscarOuCriarCliente: async () => 'cus_1',
    criarCobrancaPix: async () => {
      pagamentosNaAsaas += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { chargeId: 'pay_unico', qrCodeBase64: 'QR', copiaECola: 'COPIA' };
    },
    criarCobrancaBoleto: async () => ({}),
    consultarStatus: async () => ({ status: 'PENDING' }),
    recuperarCobrancaPix: async (chargeId) => ({ chargeId, qrCodeBase64: 'QR', copiaECola: 'COPIA' }),
    recuperarCobrancaBoleto: async () => null,
    reservarCobranca: async ({ contratanteId, pedidoId, metodoPagamento }) => {
      await ceder();
      const chave = `${contratanteId}:${pedidoId}:${metodoPagamento}`;
      if (linhas.has(chave)) return { reservada: false };
      const id = `res_${proximo++}`;
      linhas.set(chave, { id, chargeId: null });
      return { reservada: true, id };
    },
    completarCobranca: async (id, dados) => { await ceder(); for (const l of linhas.values()) if (l.id === id) l.chargeId = dados.chargeId; },
    liberarReservaCobranca: async (id) => { for (const [k, l] of linhas) if (l.id === id) linhas.delete(k); },
    buscarCobrancaPendenteDoPedido: async (contratanteId, pedidoId, metodoPagamento) => {
      await ceder();
      const l = linhas.get(`${contratanteId}:${pedidoId}:${metodoPagamento}`);
      return l?.chargeId ? { charge_id: l.chargeId } : null; // como no banco: `charge_id is not null`
    },
    // A reserva ainda sem chargeId (a 1ª requisição no meio da criação):
    // conferida pela referência na Asaas, onde AINDA não há nada.
    buscarReservaPendenteDoPedido: async (contratanteId, pedidoId, metodoPagamento) => {
      await ceder();
      const l = linhas.get(`${contratanteId}:${pedidoId}:${metodoPagamento}`);
      return l && !l.chargeId ? { id: l.id } : null;
    },
    listarPagamentosPorReferenciaExterna: async () => { await ceder(); return []; },
    completarReservaOrfa: async () => { throw new Error('não deve completar nada: não há Pix perdido'); },
    registrarErro: async () => {}
  };
  const { gerarPix } = criarCheckoutController(deps);
  const corpo = { nome: 'Fulano de Tal', email: 'f@teste.com', documento: '11144477735', cotacaoId: 'cot_1' };
  const respostas = await Promise.all(Array.from({ length: 10 }, () => {
    const r = { codigo: 200, corpo: null, status(c) { r.codigo = c; return r; }, json(c) { r.corpo = c; return r; } };
    return gerarPix({ params: { contratanteId: 'c1', pedidoId: 'ped_pix' }, body: corpo }, r).then(() => r);
  }));
  igual(pagamentosNaAsaas, 1, `C-04/AUD-001: dez POST /pix simultâneos criaram ${pagamentosNaAsaas} pagamentos na Asaas — tinha que ser UM`);
  const codigos = respostas.map((r) => r.codigo);
  ok(codigos.every((c) => c === 200 || c === 409), `cada requisição termina em 200 (o Pix, reaproveitado ou não) ou 409 (em andamento): ${codigos}`);
  ok(respostas.filter((r) => r.codigo === 200).every((r) => r.corpo?.chargeId === 'pay_unico'), 'todo 200 devolve o MESMO Pix');
}

console.log(`dez-cliques-uma-sessao: ${checagens} checagens OK`);
