/**
 * SAN CHECKOUT v2 — src/controllers/refundController.js
 * POST /api/checkout/estornar
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada na
 * consulta de pedido — identifica quem está pedindo o estorno e
 * impede um contratante estornar cobrança de outro)
 * Body: { pedidoId, valor?, chaveIdempotencia?, chargeId? } — a chave é
 * obrigatória no parcial e o que faz a repetição não estornar de novo
 * (SEC-002, `services/estornoService.js`, `API.md` §5.4)
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
  buscarCobrancasDoPedido,
  registrarEstorno,
  reivindicarEstorno,
  liberarEstorno,
  STATUS_ESTORNAVEIS
} from '../services/cobrancaService.js';
import { executarEstorno } from '../services/estornoService.js';
import { registrarErro } from '../services/erroService.js';
import { responderErro } from '../utils/erros.js';
import { emCentavos, emReais } from '../utils/dinheiro.js';
import { idCanonico } from '../utils/validadores.js';
import { notificarFatoDePedido } from './webhookController.js';

const dependenciasPadrao = {
  buscarContratantePorChave,
  buscarCobrancasDoPedido,
  registrarEstorno,
  reivindicarEstorno,
  liberarEstorno,
  executarEstorno,
  registrarErro,
  notificarFatoDePedido
};

/**
 * Decide o estorno a pedir e o estado em que a cobrança fica depois.
 * Pura, para o autoteste exercitar as bordas em centavos. Desde 25/09/2026
 * quem EXECUTA é `estornoService.executarEstorno` (que também conta o que
 * está em voo); esta continua sendo a validação barata, antes de qualquer
 * arrendamento, dos erros que não dependem de estado: valor inválido,
 * parcial em boleto, parcial acima do cobrado.
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

/**
 * QUAL cobrança do pedido se estorna (SEC-005). Até 25/09/2026 era "a
 * mais recente", e a mais recente pode ser uma pop-up abandonada depois
 * de o Pix antigo pagar — o `/estornar` respondia 409 sobre um pedido
 * pago, e o dinheiro real ficava sem caminho de volta pela API.
 *
 *  - `chargeId` informado: só vale se for de uma cobrança DESTE pedido
 *    (e deste contratante — a lista já veio escopada).
 *  - Sem `chargeId`: a única cobrança estornável do pedido. Duas pagas é a
 *    duplicidade do RN-52 — escolher sozinho qual devolver seria decidir
 *    pelo contratante, então a resposta pede o `chargeId` e lista os dois.
 *  - Nenhuma estornável: a mais recente, para a resposta dizer por quê.
 */
export function escolherCobrancaParaEstornar(linhas, chargeId) {
  const doPedido = (linhas ?? []).filter((l) => l?.charge_id);
  if (chargeId !== undefined) {
    const achada = doPedido.find((l) => l.charge_id === chargeId);
    return achada ? { cobranca: achada } : { http: 404, corpo: { erro: 'Cobrança não encontrada pra esse pedido.' } };
  }
  const estornaveis = doPedido.filter((l) => STATUS_ESTORNAVEIS.includes(l.status));
  if (estornaveis.length === 1) return { cobranca: estornaveis[0] };
  if (estornaveis.length > 1) {
    return {
      http: 409,
      corpo: {
        codigo: 'mais_de_uma_cobranca_paga',
        erro: 'Este pedido tem mais de uma cobrança paga (pagamento duplicado). Informe o chargeId da que deve ser estornada.',
        chargeIds: estornaveis.map((l) => l.charge_id)
      }
    };
  }
  const representativa = doPedido.find((l) => l.status !== 'cancelado_por_outro_pagamento') ?? doPedido[0];
  return representativa ? { cobranca: representativa } : { http: 404, corpo: { erro: 'Cobrança não encontrada pra esse pedido.' } };
}

export function criarRefundController(deps = dependenciasPadrao) {
  async function estornar(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    const { pedidoId, valor, chaveIdempotencia, chargeId } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!pedidoId) return resposta.status(400).json({ erro: 'pedidoId é obrigatório.' });
    if (chargeId !== undefined && !idCanonico(chargeId)) return resposta.status(400).json({ erro: 'chargeId inválido.' });

    /* A CHAVE DE IDEMPOTÊNCIA (SEC-002). No PARCIAL ela é obrigatória:
       dois parciais de R$ 30 podem ser legítimos, e só quem pede sabe se
       o segundo é outro estorno ou a repetição do primeiro. No TOTAL, sem
       chave, o servidor usa uma derivada da cobrança — um total só
       acontece uma vez, então repetir devolve o resultado gravado. */
    const parcial = valor !== undefined && valor !== null && valor !== '';
    if (chaveIdempotencia !== undefined && !idCanonico(chaveIdempotencia)) {
      return resposta.status(400).json({ erro: 'chaveIdempotencia inválida: use só letras sem acento, números, "-" e "_" (até 128 caracteres).' });
    }
    if (parcial && chaveIdempotencia === undefined) {
      return resposta.status(400).json({
        codigo: 'chave_idempotencia_obrigatoria',
        erro: 'Estorno parcial exige chaveIdempotencia: um valor único por estorno, que você repete idêntico se precisar tentar de novo. Sem ela não dá para distinguir a repetição de um segundo estorno.'
      });
    }

    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      const escolha = escolherCobrancaParaEstornar(await deps.buscarCobrancasDoPedido(contratante.id, pedidoId), chargeId);
      if (!escolha.cobranca) return resposta.status(escolha.http).json(escolha.corpo);
      const { cobranca } = escolha;

      const plano = planejarEstorno(cobranca, valor);
      if (plano.erro) return resposta.status(400).json({ erro: plano.erro });

      const r = await deps.executarEstorno(
        {
          contratante,
          cobranca,
          chave: chaveIdempotencia ?? `total-${cobranca.id}`,
          valorCentavos: parcial ? emCentavos(valor) : null
        },
        {
          reivindicar: deps.reivindicarEstorno,
          liberar: deps.liberarEstorno,
          registrarNaCobranca: deps.registrarEstorno
        }
      );

      /* O webhook que o API.md §5.4 promete ("depois do estorno você
         também recebe o webhook correspondente"). Mesma chave do fato:
         quando o PAYMENT_REFUNDED da Asaas chegar, cai na mesma linha da
         outbox e ninguém ouve duas vezes. Só quando ESTA chamada estornou
         (`efeito`) — a repetição devolve o gravado e não reavisa. Falha
         aqui não desfaz o estorno (já aconteceu do lado de lá): vira Lei 8. */
      if (r.efeito) {
        try {
          await deps.notificarFatoDePedido(contratante, { ...cobranca, cotacao_id: cobranca.cotacao_id ?? null }, {
            chargeId: cobranca.charge_id,
            statusFinanceiro: r.efeito.statusLocal,
            valorEstornado: r.efeito.assincrono ? null : r.efeito.valorEstornadoDepois
          });
        } catch (erroAviso) {
          await deps.registrarErro(
            new Error(`estorno de ${pedidoId} executado, mas o aviso ao contratante não foi enfileirado: ${erroAviso.message}`),
            { contexto: 'refundController.notificar', rota: 'checkout/estornar', metodo: 'POST' }
          );
        }
      }

      resposta.status(r.http).json(r.corpo);
    } catch (erro) {
      responderErro(resposta, erro, 'refundController.estornar');
    }
  }

  return { estornar };
}

export const { estornar } = criarRefundController();

/* ── Autoteste ──────────────────────────────────────────────────────── */
/* O FLUXO do estorno (repetição, resposta perdida, queda do processo,
   concorrência, cobrança escolhida) roda contra o serviço real em
   `tests/estorno-repetido-nao-devolve-duas-vezes.js`. Aqui ficam as
   duas funções puras e as recusas que acontecem antes de qualquer
   banco. */
if (process.argv[1]?.endsWith('refundController.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  function respostaFalsa() {
    return { codigo: 200, corpo: null, status(c) { this.codigo = c; return this; }, json(c) { this.corpo = c; return this; } };
  }
  const requisicao = (chave, body) => ({ get: (h) => (h === 'X-Checkout-Key' ? chave : undefined), body });
  const semBanco = {
    ...dependenciasPadrao,
    buscarContratantePorChave: async () => { throw new Error('não devia ir ao banco'); },
    buscarCobrancasDoPedido: async () => { throw new Error('não devia ir ao banco'); },
    executarEstorno: async () => { throw new Error('não devia estornar'); }
  };
  const c = criarRefundController(semBanco);

  for (const [nome, chave, body, esperado] of [
    ['sem chave', undefined, { pedidoId: 'p1' }, 401],
    ['sem pedidoId', 'k', {}, 400],
    ['parcial SEM chaveIdempotencia', 'k', { pedidoId: 'p1', valor: 30 }, 400],
    ['chaveIdempotencia com barra', 'k', { pedidoId: 'p1', valor: 30, chaveIdempotencia: '../x' }, 400],
    ['chaveIdempotencia numérica (não converte)', 'k', { pedidoId: 'p1', valor: 30, chaveIdempotencia: 123 }, 400],
    ['chargeId adulterado', 'k', { pedidoId: 'p1', chargeId: 'pay_1/../x' }, 400]
  ]) {
    const r = respostaFalsa();
    await c.estornar(requisicao(chave, body), r);
    conferir(r.codigo === esperado, `${nome}: ${esperado}, veio ${r.codigo} ${JSON.stringify(r.corpo)}`);
  }
  {
    const r = respostaFalsa();
    await c.estornar(requisicao('k', { pedidoId: 'p1', valor: 30 }), r);
    conferir(r.corpo?.codigo === 'chave_idempotencia_obrigatoria', 'o parcial sem chave diz o código e o porquê');
  }

  // escolherCobrancaParaEstornar — SEC-005: a que PAGOU, não a mais recente.
  const pix = { charge_id: 'pay_pix', status: 'confirmado' };
  const popupAbandonada = { charge_id: 'pay_pop', status: 'cancelado' };
  conferir(escolherCobrancaParaEstornar([popupAbandonada, pix]).cobranca === pix, 'a pop-up abandonada mais recente não esconde o Pix pago');
  const dup = escolherCobrancaParaEstornar([{ charge_id: 'a', status: 'confirmado' }, { charge_id: 'b', status: 'confirmado' }]);
  conferir(dup.http === 409 && dup.corpo.codigo === 'mais_de_uma_cobranca_paga' && dup.corpo.chargeIds.length === 2, 'duas pagas (RN-52): pede o chargeId, não escolhe sozinho');
  conferir(escolherCobrancaParaEstornar([{ charge_id: 'a', status: 'confirmado' }, { charge_id: 'b', status: 'confirmado' }], 'b').cobranca.charge_id === 'b', 'com chargeId, a escolhida é a pedida');
  conferir(escolherCobrancaParaEstornar([pix], 'pay_de_outro_pedido').http === 404, 'chargeId que não é deste pedido: 404');
  conferir(escolherCobrancaParaEstornar([]).http === 404, 'pedido sem cobrança: 404');
  conferir(escolherCobrancaParaEstornar([{ charge_id: 'x', status: 'cancelado_por_outro_pagamento' }, { charge_id: 'y', status: 'estornado' }]).cobranca.charge_id === 'y', 'sem estornável: a representativa não é a irmã cancelada');

  // planejarEstorno é puro e conta em centavos.
  assert.deepEqual(planejarEstorno({ valor_cobrado: 0.3, valor_estornado: 0.1, metodo_pagamento: 'pix' }, 0.2),
    { valorAsaas: 0.2, valorEstornadoDepois: 0.3, statusDepois: 'estornado' }, '0.1 + 0.2 = 0.3 (em reais seria 0.30000000000000004)');
  checagens += 1;
  conferir(Boolean(planejarEstorno({ valor_cobrado: 10, valor_estornado: null, metodo_pagamento: 'pix' }, 10.01).erro), 'acima do cobrado: erro');
  conferir(Boolean(planejarEstorno({ valor_cobrado: 10, metodo_pagamento: 'boleto' }, 5).erro), 'parcial em boleto: erro');
  conferir(Boolean(planejarEstorno({ valor_cobrado: 10, metodo_pagamento: 'pix' }, 0).erro), 'zero: erro');

  console.log(`refundController: ${checagens} checagens OK`);
}
