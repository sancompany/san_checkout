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
 * Duas peças acrescentadas nesta rodada (VISAO_COMPLETA.md seção 7):
 *   1. Boleto é ASSÍNCRONO — o status local vira 'estorno_solicitado'
 *      em vez de 'estornado' até o webhook confirmar de verdade
 *      (PAYMENT_REFUND_IN_PROGRESS → depois PAYMENT_REFUNDED).
 *   2. Se a cobrança tem nota fiscal emitida (nota_fiscal_id
 *      preenchido), tenta cancelar ela também — SEM NUNCA bloquear o
 *      estorno do dinheiro por causa disso (pode falhar por regra da
 *      prefeitura; só loga e segue).
 *
 * ⚠️ NUNCA TESTADO AO VIVO nesta v2 — nem o estorno simples nem as
 * duas peças novas.
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import {
  buscarCobrancaPorPedido,
  atualizarStatusCobranca,
  atualizarStatusNotaFiscal
} from '../services/cobrancaService.js';
import { estornarCobranca, cancelarNotaFiscal } from '../services/asaasService.js';
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

    // Cancelamento de nota fiscal vinculada — nunca bloqueia o estorno
    // do dinheiro. Se a prefeitura não permitir cancelamento
    // automático, quem decide o que fazer com a nota é o time
    // financeiro, não este endpoint — só logamos e seguimos.
    let notaFiscalCancelamentoSolicitado = false;
    if (cobranca.nota_fiscal_id) {
      try {
        await cancelarNotaFiscal(cobranca.nota_fiscal_id);
        await atualizarStatusNotaFiscal(cobranca.charge_id, 'cancelamento_solicitado');
        notaFiscalCancelamentoSolicitado = true;
      } catch (erroNota) {
        console.error('[refundController.estornar] falha ao cancelar nota fiscal vinculada:', erroNota.message);
      }
    }

    resposta.json({
      chargeId: cobranca.charge_id,
      status: statusLocal,
      notaFiscalCancelamentoSolicitado
    });
  } catch (erro) {
    responderErro(resposta, erro, 'refundController.estornar');
  }
}
