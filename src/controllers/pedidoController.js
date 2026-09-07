/**
 * SAN CHECKOUT v2 — src/controllers/pedidoController.js
 * GET /api/checkout/pedido/:contratanteId/:pedidoId
 * Chamado pelo front assim que a tela abre — resolve via pull e já
 * devolve a taxa calculada (assumindo Pix, único método desta leva).
 */

import { resolverPedido } from '../services/pedidoService.js';
import { calcularTaxa } from '../services/taxaService.js';
import { responderErro } from '../utils/erros.js';

export async function obterPedido(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;

  try {
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId);

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);
    const taxa = calcularTaxa(valorBase, 'pix', 1, Boolean(pedido.isentarTaxa));

    resposta.json({
      contratanteNome: contratante.nome,
      pedido,
      taxa
    });
  } catch (erro) {
    responderErro(resposta, erro, 'pedidoController.obterPedido', 500);
  }
}
