/**
 * SAN CHECKOUT v2 — src/controllers/refundController.js
 * POST /api/checkout/estornar
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada na
 * consulta de pedido — identifica quem está pedindo o estorno e
 * impede um contratante estornar cobrança de outro)
 * Body: { pedidoId, valor? }
 *
 * `valor` ausente = estorno TOTAL. `valor` presente = estorno PARCIAL
 * (desde 24/09/2026, H-04): devolve só aquela parte, a cobrança fica
 * `estornado_parcialmente` com `valor_estornado` acumulado, e pode ser
 * estornada de novo até completar o cobrado — quando completa, vira
 * `estornado`. A conta é em centavos (`utils/dinheiro.js`): `30` e
 * `30.000000000000004` são o mesmo dinheiro, e nunca se devolve mais
 * do que falta. Boleto não oferece parcial (o endpoint assíncrono da
 * Asaas não documenta `value`, e não foi medido) — recusa com 400 antes
 * de reivindicar qualquer coisa.
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
  registrarEstorno,
  reivindicarEstorno,
  liberarEstorno
} from '../services/cobrancaService.js';
import { estornarCobranca, foiRecusaLimpaDaAsaas } from '../services/asaasService.js';
import { registrarErro } from '../services/erroService.js';
import { responderErro } from '../utils/erros.js';
import { emCentavos, emReais } from '../utils/dinheiro.js';

const dependenciasPadrao = {
  buscarContratantePorChave,
  buscarCobrancaPorPedido,
  registrarEstorno,
  reivindicarEstorno,
  liberarEstorno,
  estornarCobranca,
  registrarErro
};

/**
 * Decide o estorno a pedir e o estado em que a cobrança fica depois.
 * Pura, para o autoteste exercitar as bordas em centavos.
 *
 * @returns {{ erro?: string, valorAsaas: number|null, valorEstornadoDepois: number, statusDepois: 'estornado'|'estornado_parcialmente' }}
 */
export function planejarEstorno(cobranca, valorPedido) {
  const cobrado = emCentavos(cobranca.valor_cobrado);
  const jaEstornado = emCentavos(cobranca.valor_estornado) ?? 0;
  const parcial = valorPedido !== undefined && valorPedido !== null && valorPedido !== '';

  if (!parcial) {
    // Total: devolve o que FALTA. Numa linha já parcialmente estornada,
    // mandar `{}` à Asaas estornaria o restante — e é isso que "total"
    // significa aqui; o acumulado passa a ser o cobrado.
    return { valorAsaas: null, valorEstornadoDepois: cobrado != null ? emReais(cobrado) : null, statusDepois: 'estornado' };
  }

  const pedido = emCentavos(valorPedido);
  if (pedido == null || pedido <= 0) return { erro: 'valor do estorno inválido — informe um número maior que zero, em reais, ou omita para estornar tudo.' };
  if (cobranca.metodo_pagamento === 'boleto') return { erro: 'Boleto não aceita estorno parcial — omita `valor` para estornar tudo.' };
  if (cobrado == null) return { erro: 'Esta cobrança não tem valor cobrado registrado — estorno parcial indisponível.' };

  const restante = cobrado - jaEstornado;
  if (pedido > restante) {
    return { erro: `valor do estorno (R$ ${emReais(pedido).toFixed(2)}) maior que o restante estornável (R$ ${emReais(restante).toFixed(2)}).` };
  }
  const acumulado = jaEstornado + pedido;
  return {
    valorAsaas: emReais(pedido),
    valorEstornadoDepois: emReais(acumulado),
    statusDepois: acumulado >= cobrado ? 'estornado' : 'estornado_parcialmente'
  };
}

export function criarRefundController(deps = dependenciasPadrao) {
  async function estornar(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    const { pedidoId, valor } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!pedidoId) return resposta.status(400).json({ erro: 'pedidoId é obrigatório.' });

    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      const cobranca = await deps.buscarCobrancaPorPedido(contratante.id, pedidoId);
      if (!cobranca) return resposta.status(404).json({ erro: 'Cobrança não encontrada pra esse pedido.' });

      const plano = planejarEstorno(cobranca, valor);
      if (plano.erro) return resposta.status(400).json({ erro: plano.erro });

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
          metodoPagamento: cobranca.metodo_pagamento,
          valor: plano.valorAsaas
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

      // `registrarEstorno` libera o arrendamento junto com o status: num
      // parcial a linha CONTINUA estornável e o próximo pedido precisa
      // reivindicar sem esperar o prazo. No total/boleto o status sai do
      // conjunto estornável, e a coluna fica inerte pra sempre.
      const statusLocal = assincrono ? 'estorno_solicitado' : plano.statusDepois;
      await deps.registrarEstorno(cobranca.charge_id, {
        status: statusLocal,
        valorEstornado: assincrono ? undefined : plano.valorEstornadoDepois
      });

      resposta.json({
        chargeId: cobranca.charge_id,
        status: statusLocal,
        valorEstornado: assincrono ? null : plano.valorEstornadoDepois,
        estornoParcial: statusLocal === 'estornado_parcialmente'
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

    function fixture(chargeId, status, extras = {}) {
      linhas.set(chargeId, { status, estornando_em: null, valor_cobrado: 100, valor_estornado: null, metodo_pagamento: 'pix', ...extras });
    }

    const deps = {
      buscarContratantePorChave: async (chave) => (chave === 'chave_boa' ? { id: 'c1' } : null),

      buscarCobrancaPorPedido: async (_contratanteId, pedidoId) => {
        const chargeId = `pay_${pedidoId}`;
        const linha = linhas.get(chargeId);
        if (!linha) return null;
        return { charge_id: chargeId, metodo_pagamento: linha.metodo_pagamento, status: linha.status, valor_cobrado: linha.valor_cobrado, valor_estornado: linha.valor_estornado };
      },

      reivindicarEstorno: async (chargeId) => {
        const linha = linhas.get(chargeId);
        if (!linha || !['confirmado', 'estornado_parcialmente'].includes(linha.status)) return false;
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

      registrarEstorno: async (chargeId, { status, valorEstornado }) => {
        const linha = linhas.get(chargeId);
        if (!linha) return;
        linha.status = status;
        if (valorEstornado != null) linha.valor_estornado = valorEstornado;
        linha.estornando_em = null;
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

  function requisicaoFalsa({ chave, pedidoId, valor }) {
    return { get: (h) => (h === 'X-Checkout-Key' ? chave : undefined), body: { pedidoId, ...(valor !== undefined ? { valor } : {}) } };
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

  // 12. Estorno PARCIAL (H-04): manda `value` à Asaas, acumula em centavos,
  //     fica `estornado_parcialmente`, e o segundo parcial que completa vira `estornado`.
  {
    const { deps, chamadasAsaas, linhas, fixture } = costura();
    fixture('pay_p9', 'confirmado', { valor_cobrado: 100 });
    const controller = criarRefundController(deps);
    const r1 = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p9', valor: 30.1 }), r1);
    assert.equal(r1.corpo?.status, 'estornado_parcialmente');
    assert.equal(r1.corpo?.valorEstornado, 30.1);
    assert.equal(r1.corpo?.estornoParcial, true);
    assert.equal(chamadasAsaas[0].opcoes.valor, 30.1, 'o valor parcial vai à Asaas como `value`');
    assert.equal(linhas.get('pay_p9').status, 'estornado_parcialmente');
    assert.equal(linhas.get('pay_p9').estornando_em, null, 'parcial libera o arrendamento — a linha continua estornável');

    const r2 = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p9', valor: 69.9 }), r2);
    assert.equal(r2.corpo?.status, 'estornado', '30.10 + 69.90 = 100.00 em centavos — completa, sem ruído de float');
    assert.equal(r2.corpo?.valorEstornado, 100);
    assert.equal(chamadasAsaas.length, 2);
    checagens += 1;
  }

  // 13. Parcial acima do restante → 400 sem reivindicar nem chamar a Asaas;
  //     parcial em boleto → 400; valor zero/negativo/texto → 400.
  {
    const { deps, chamadasAsaas, linhas, fixture } = costura();
    fixture('pay_p10', 'estornado_parcialmente', { valor_cobrado: 100, valor_estornado: 80 });
    fixture('pay_p11', 'confirmado', { metodo_pagamento: 'boleto' });
    fixture('pay_p12', 'confirmado');
    const controller = criarRefundController(deps);
    for (const [pedidoId, valor] of [['p10', 20.01], ['p11', 10], ['p12', 0], ['p12', -5], ['p12', 'dez']]) {
      const r = respostaFalsa();
      await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId, valor }), r);
      assert.equal(r.codigo, 400, `${pedidoId} com valor ${valor} devia dar 400`);
    }
    assert.equal(chamadasAsaas.length, 0);
    assert.equal(linhas.get('pay_p10').estornando_em, null, '400 acontece ANTES de reivindicar');
    // ...e exatamente o restante passa, completando.
    const r = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p10', valor: 20 }), r);
    assert.equal(r.corpo?.status, 'estornado');
    checagens += 1;
  }

  // 14. Total depois de um parcial: manda `{}` (sem value) e o acumulado vira o cobrado.
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('pay_p13', 'estornado_parcialmente', { valor_cobrado: 50, valor_estornado: 10 });
    const controller = criarRefundController(deps);
    const r = respostaFalsa();
    await controller.estornar(requisicaoFalsa({ chave: 'chave_boa', pedidoId: 'p13' }), r);
    assert.equal(r.corpo?.status, 'estornado');
    assert.equal(r.corpo?.valorEstornado, 50);
    assert.equal(chamadasAsaas[0].opcoes.valor, null);
    checagens += 1;
  }

  // 15. planejarEstorno é puro e conta em centavos.
  {
    assert.deepEqual(planejarEstorno({ valor_cobrado: 0.3, valor_estornado: 0.1, metodo_pagamento: 'pix' }, 0.2),
      { valorAsaas: 0.2, valorEstornadoDepois: 0.3, statusDepois: 'estornado' }, '0.1 + 0.2 = 0.3 (em reais seria 0.30000000000000004)');
    assert.ok(planejarEstorno({ valor_cobrado: 10, valor_estornado: null, metodo_pagamento: 'pix' }, 10.01).erro);
    checagens += 1;
  }

  console.log(`refundController: ${checagens} checagens OK`);
}
