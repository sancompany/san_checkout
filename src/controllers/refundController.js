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
 * Peça acrescentada nesta rodada (VISAO_COMPLETA.md seção 7): Boleto é
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
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import { buscarCobrancaPorPedido, atualizarStatusCobranca } from '../services/cobrancaService.js';
import { estornarCobranca } from '../services/asaasService.js';
import { responderErro } from '../utils/erros.js';

export async function estornar(requisicao, resposta) {
  const chave = requisicao.get('X-Checkout-Key');
  const { pedidoId } = requisicao.body ?? {};

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
  if (!pedidoId) return resposta.status(400).json({ erro: 'pedidoId é obrigatório.' });

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

    const cobranca = await buscarCobrancaPorPedido(contratante.id, pedidoId);
    if (!cobranca) return resposta.status(404).json({ erro: 'Cobrança não encontrada pra esse pedido.' });

    const { assincrono } = await estornarCobranca(cobranca.charge_id, {
      metodoPagamento: cobranca.metodo_pagamento
    });

    // Boleto: o dinheiro só volta depois que o pagador completa o link
    // bancário que a Asaas manda — status local intermediário real,
    // não um erro (atualizado de novo quando PAYMENT_REFUNDED chegar
    // de verdade, ver webhookController.js).
    const statusLocal = assincrono ? 'estorno_solicitado' : 'estornado';
    await atualizarStatusCobranca(cobranca.charge_id, statusLocal);

    resposta.json({
      chargeId: cobranca.charge_id,
      status: statusLocal
    });
  } catch (erro) {
    responderErro(resposta, erro, 'refundController.estornar');
  }
}
