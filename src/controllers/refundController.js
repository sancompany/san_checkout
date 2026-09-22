/**
 * SAN CHECKOUT v2 — src/controllers/refundController.js
 * POST /api/checkout/estornar
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada na
 * consulta de pedido — identifica quem está pedindo o estorno e
 * impede um contratante estornar cobrança de outro)
 * Body: { pedidoId }
 *
 * Sempre tudo ou nada — sem estorno parcial nesta versão.
 *
 * Boleto é
 * ASSÍNCRONO — o status local vira 'estorno_solicitado' em vez de
 * 'estornado' até o webhook confirmar de verdade
 * (PAYMENT_REFUND_IN_PROGRESS → depois PAYMENT_REFUNDED).
 *
 * Cancelamento de nota fiscal NÃO é mais feito aqui — nota fiscal é
 * responsabilidade de cada contratante, que já recebe o evento de
 * estorno no próprio webhook_url (ver webhookController.js).
 *
 * Estorno de Pix exercitado ao vivo em 14/09/2026 (Estação 6, sandbox,
 * contratante de teste): cobrança paga → POST /estornar com a
 * X-Checkout-Key → status local 'estornado', 200. O ramo assíncrono do
 * boleto (estorno_solicitado → PAYMENT_REFUNDED) ainda não foi exercitado
 * ao vivo.
 *
 * ── Reivindica antes de estornar, desde 22/09/2026 ────────────────────
 * Achado numa auditoria externa (Codex), confirmado lendo o código: até
 * então a rota ia direto de `buscarCobrancaPorPedido` pra
 * `estornarCobranca` na Asaas sem checar `status` nenhum. Duas chamadas
 * simultâneas pro mesmo pedido liam as duas a mesma cobrança
 * `confirmado` e as DUAS chamavam a Asaas pra estornar — o mesmo dinheiro
 * devolvido duas vezes. E nada impedia estornar uma cobrança que não
 * está `confirmado` (nunca paga, já estornada, ou com estorno de boleto
 * já em andamento). Agora a ordem é reivindicar → estornar (mesmo padrão
 * que `assinaturaService.reivindicarTroca` já usa pro acerto de troca de
 * plano) — só quem encontra a linha em `confirmado` chega a chamar a
 * Asaas, e uma falha AMBÍGUA dela (timeout, 5xx) nunca libera a
 * reivindicação, pra não abrir espaço pra uma segunda tentativa estornar
 * de novo o que já pode ter sido estornado do lado de lá.
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import {
  buscarCobrancaPorPedido,
  atualizarStatusCobranca,
  reivindicarEstorno,
  liberarEstorno
} from '../services/cobrancaService.js';
import { estornarCobranca, foiRecusaLimpaDaAsaas } from '../services/asaasService.js';
import { registrarErro } from '../services/erroService.js';
import { responderErro } from '../utils/erros.js';

const dependenciasPadrao = {
  buscarContratantePorChave,
  buscarCobrancaPorPedido,
  atualizarStatusCobranca,
  reivindicarEstorno,
  liberarEstorno,
  estornarCobranca,
  registrarErro
};

export function criarRefundController(deps = dependenciasPadrao) {
  async function estornar(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    const { pedidoId } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!pedidoId) return resposta.status(400).json({ erro: 'pedidoId é obrigatório.' });

    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      const cobranca = await deps.buscarCobrancaPorPedido(contratante.id, pedidoId);
      if (!cobranca) return resposta.status(404).json({ erro: 'Cobrança não encontrada pra esse pedido.' });

      const reivindicou = await deps.reivindicarEstorno(cobranca.charge_id);
      if (!reivindicou) {
        return resposta.status(409).json({
          erro: 'Esta cobrança não pode ser estornada agora — já foi estornada, ainda não foi ' +
            'confirmada, ou um estorno já está em andamento.'
        });
      }

      let assincrono;
      try {
        ({ assincrono } = await deps.estornarCobranca(cobranca.charge_id, {
          metodoPagamento: cobranca.metodo_pagamento
        }));
      } catch (erroAsaas) {
        if (foiRecusaLimpaDaAsaas(erroAsaas)) {
          await deps.liberarEstorno(cobranca.charge_id);
        } else {
          await deps.registrarErro(
            new Error(
              `estorno: chamada à Asaas falhou de forma AMBÍGUA para o pedido ${pedidoId} ` +
              `(charge ${cobranca.charge_id}) — NÃO SE SABE se o estorno foi processado do lado de lá. ` +
              `A reivindicação foi mantida de propósito, pra não abrir espaço pra uma segunda tentativa ` +
              `estornar de novo o que já pode ter sido estornado: ${erroAsaas.message}`
            ),
            { contexto: 'refundController.estornar', rota: 'checkout/estornar', metodo: 'POST' }
          );
        }
        throw erroAsaas;
      }

      // Sem clearing de `estornando_em` aqui de propósito: o status
      // deixa de ser `confirmado` (vira `estornado`/`estorno_solicitado`),
      // e é o STATUS que a próxima reivindicação exige — uma vez fora
      // de `confirmado`, a coluna do arrendamento fica inerte pra sempre
      // nesta linha.
      const statusLocal = assincrono ? 'estorno_solicitado' : 'estornado';
      await deps.atualizarStatusCobranca(cobranca.charge_id, statusLocal);

      resposta.json({
        chargeId: cobranca.charge_id,
        status: statusLocal
      });
    } catch (erro) {
      responderErro(resposta, erro, 'refundController.estornar');
    }
  }

  return { estornar };
}

export const { estornar } = criarRefundController();

/* ── Autoteste ──────────────────────────────────────────────────────── */
if (process.argv[1]?.endsWith('refundController.js')) {
  const { strict: assert } = await import('node:assert');

  function costura() {
    const linhas = new Map(); // charge_id -> { status, estornando_em }
    const chamadasAsaas = [];
    const errosRegistrados = [];

    function fixture(chargeId, status) {
      linhas.set(chargeId, { status, estornando_em: null });
    }

    const deps = {
      buscarContratantePorChave: async (chave) => (chave === 'chave_boa' ? { id: 'c1' } : null),

      buscarCobrancaPorPedido: async (_contratanteId, pedidoId) => {
        const chargeId = `pay_${pedidoId}`;
        const linha = linhas.get(chargeId);
        if (!linha) return null;
        return { charge_id: chargeId, metodo_pagamento: 'pix', status: linha.status };
      },

      reivindicarEstorno: async (chargeId) => {
        const linha = linhas.get(chargeId);
        if (!linha || linha.status !== 'confirmado') return false;
        if (linha.estornando_em && Date.now() - linha.estornando_em < 5 * 60_000) return false;
        linha.estornando_em = Date.now();
        return true;
      },

      liberarEstorno: async (chargeId) => {
        const linha = linhas.get(chargeId);
        if (linha) linha.estornando_em = null;
      },

      estornarCobranca: async (chargeId, opcoes) => {
        chamadasAsaas.push({ chargeId, opcoes });
        const ajuste = deps._ajustes?.[chargeId];
        if (ajuste?.erro) throw ajuste.erro;
        const linha = linhas.get(chargeId);
        linha.status = 'confirmado'; // só muda de verdade em atualizarStatusCobranca
        return { assincrono: ajuste?.assincrono ?? false };
      },

      atualizarStatusCobranca: async (chargeId, status) => {
        const linha = linhas.get(chargeId);
        if (linha) linha.status = status;
      },

      registrarErro: async (erro) => { errosRegistrados.push(erro.message); },

      _ajustes: {}
    };

    return { deps, linhas, chamadasAsaas, errosRegistrados, fixture };
  }

  function respostaFalsa() {
    const r = {
      codigo: null, corpo: null,
      status(c) { this.codigo = c; return this; },
      json(c) { this.corpo = c; return this; }
    };
    return r;
  }

  function requisicaoFalsa({ chave, pedidoId }) {
    return { get: (h) => (h === 'X-Checkout-Key' ? chave : undefined), body: { pedidoId } };
  }

  let checagens = 0;

  // 1. Sem chave → 401, sem tocar banco nem Asaas.
  {
    const { deps, chamadasAsaas } = costura();
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: undefined, pedidoId: 'p1' }), resposta);
    assert.equal(resposta.codigo, 401);
    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  // 2. Chave inválida → 401.
  {
    const { deps } = costura();
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_errada', pedidoId: 'p1' }), resposta);
    assert.equal(resposta.codigo, 401);
    checagens += 1;
  }

  // 3. Sem cobrança pra esse pedido → 404.
  {
    const { deps } = costura();
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'inexistente' }), resposta);
    assert.equal(resposta.codigo, 404);
    checagens += 1;
  }

  // 4. Caminho feliz — Pix, síncrono: reivindica, chama a Asaas UMA vez, vira 'estornado'.
  {
    const { deps, chamadasAsaas, linhas, fixture } = costura();
    fixture('pay_p1', 'confirmado');
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p1' }), resposta);
    assert.equal(resposta.corpo?.status, 'estornado');
    assert.equal(chamadasAsaas.length, 1);
    assert.equal(linhas.get('pay_p1').status, 'estornado');
    checagens += 1;
  }

  // 5. Boleto, assíncrono: vira 'estorno_solicitado', não 'estornado'.
  {
    const { deps, linhas, fixture } = costura();
    fixture('pay_p2', 'confirmado');
    deps._ajustes.pay_p2 = { assincrono: true };
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p2' }), resposta);
    assert.equal(resposta.corpo?.status, 'estorno_solicitado');
    assert.equal(linhas.get('pay_p2').status, 'estorno_solicitado');
    checagens += 1;
  }

  // 6. Cobrança 'pendente' (nunca paga) → reivindicarEstorno recusa → 409, Asaas nunca chamada.
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('pay_p3', 'pendente');
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p3' }), resposta);
    assert.equal(resposta.codigo, 409);
    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  // 7. Cobrança já 'estornado' → 409, Asaas nunca chamada (não estorna duas vezes).
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('pay_p4', 'estornado');
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p4' }), resposta);
    assert.equal(resposta.codigo, 409);
    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  // 8. Corrida real: duas chamadas 'simultâneas' pro mesmo pedido — só uma reivindica,
  //    só uma chama a Asaas, a outra recebe 409.
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('pay_p5', 'confirmado');
    const controller = criarRefundController(deps);
    const resposta1 = respostaFalsa();
    const resposta2 = respostaFalsa();
    await Promise.all([
      controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p5' }), resposta1),
      controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p5' }), resposta2)
    ]);
    const codigos = [resposta1.codigo ?? 200, resposta2.codigo ?? 200].sort();
    assert.deepEqual(codigos, [200, 409]);
    assert.equal(chamadasAsaas.length, 1, 'a Asaas só pode ser chamada UMA vez pra mesma cobrança');
    checagens += 1;
  }

  // 9. Recusa LIMPA da Asaas (4xx com corpo) → libera a reivindicação, registra erro NÃO.
  //    A rota nunca lança pra fora — o try/catch responde com responderErro (mesmo padrão
  //    de checkoutController.js), então o teste confere resposta/estado, não rejeição.
  {
    const { deps, linhas, errosRegistrados, fixture } = costura();
    fixture('pay_p6', 'confirmado');
    const erro400 = new Error('cobrança já estornada do lado da Asaas');
    erro400.status = 400;
    erro400.corpoAsaas = { errors: [{ description: 'já estornada' }] };
    deps._ajustes.pay_p6 = { erro: erro400 };
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p6' }), resposta);
    assert.equal(resposta.codigo, 400);
    assert.equal(linhas.get('pay_p6').status, 'confirmado', 'status não muda numa recusa limpa');
    assert.equal(linhas.get('pay_p6').estornando_em, null, 'reivindicação liberada — pode tentar de novo');
    assert.equal(errosRegistrados.length, 0, 'recusa limpa não é ambígua — não precisa de Lei 8 explícita');
    checagens += 1;
  }

  // 10. Falha AMBÍGUA da Asaas (timeout) → NÃO libera a reivindicação, registra em Lei 8.
  {
    const { deps, linhas, errosRegistrados, fixture } = costura();
    fixture('pay_p7', 'confirmado');
    const erroTimeout = new Error('A Asaas não respondeu a tempo. Tente de novo em instantes.');
    erroTimeout.status = 504;
    deps._ajustes.pay_p7 = { erro: erroTimeout };
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p7' }), resposta);
    assert.equal(resposta.codigo, 504);
    assert.equal(linhas.get('pay_p7').status, 'confirmado', 'status não muda numa falha ambígua');
    assert.ok(linhas.get('pay_p7').estornando_em, 'reivindicação PERMANECE — não pode tentar de novo sem esperar o prazo');
    assert.equal(errosRegistrados.length, 1, 'falha ambígua tem que virar Lei 8');
    checagens += 1;
  }

  // 11. Falha ambígua com 429 (rate limit, não é recusa limpa) → mesmo tratamento do item 10.
  {
    const { deps, linhas, errosRegistrados, fixture } = costura();
    fixture('pay_p8', 'confirmado');
    const erro429 = new Error('muitas requisições');
    erro429.status = 429;
    erro429.corpoAsaas = { errors: [{ description: 'rate limit' }] };
    deps._ajustes.pay_p8 = { erro: erro429 };
    const controller = criarRefundController(deps);
    const resposta = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p8' }), resposta);
    assert.equal(resposta.codigo, 429);
    assert.ok(linhas.get('pay_p8').estornando_em, '429 é ambíguo mesmo com corpo — rate limit não prova recusa');
    assert.equal(errosRegistrados.length, 1);
    checagens += 1;
  }

  console.log(`refundController: ${checagens} checagens OK`);
}
