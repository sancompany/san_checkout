/**
 * SAN CHECKOUT v2 — src/controllers/pedidoController.js
 * GET /api/checkout/pedido/:contratanteId/:pedidoId
 * Chamado pelo front assim que a tela abre — resolve via pull e devolve
 * o pedido, os totais por método/parcelas e a COTAÇÃO (C-02): o retrato
 * do preço que esta tela vai mostrar, com id que o POST que cobra exige
 * de volta. O que se cobra depois é o que está na cotação, nunca um
 * segundo pull silencioso.
 */

import { resolverPedido } from '../services/pedidoService.js';
import { criarCotacao, montarTotaisPedido } from '../services/cotacaoService.js';
import { MENSAGEM_PISO_ASAAS } from '../utils/validadores.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { responderErro } from '../utils/erros.js';

/* FÁBRICA, não terceiro parâmetro — o Express chama todo handler como
   `(req, res, next)`, então `deps` chegaria sendo o `next`. */
export function criarObterPedido({ resolverPedido: resolver = resolverPedido, criarCotacao: cotar = criarCotacao } = {}) {
  return async function obterPedido(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;

    try {
      const { contratante, pedido } = await resolver(contratanteId, pedidoId);

      /* `totais` nulo = valor inválido (zero, negativo, acima do teto):
         `taxa: null` faz o guarda do front disparar e a tela cair no
         estado Indisponível, com `R$ —` e sem botão (docs/funcional.md
         §4.1). Um total que não se cobra não vira tela comprável. */
      const totais = montarTotaisPedido(pedido);
      const taxa = totais?.pix ?? null;

      /* O PISO DA ASAAS, dito na hora de abrir a tela — não no clique. */
      const bloqueio = totais?.abaixoDoPiso
        ? { codigo: 'valor_abaixo_do_piso', mensagem: MENSAGEM_PISO_ASAAS }
        : null;

      /* A COTAÇÃO só nasce quando há o que cobrar: sem totais, ou abaixo
         do piso, a tela não oferece botão e um id seria inútil. */
      const cotacao = totais && !bloqueio
        ? await cotar({ contratanteId: contratante.id, tipo: 'pedido', referenciaId: pedidoId, origem: pedido, totais })
        : null;

      /* Quem decide o destino de volta é AQUI, não o navegador
         (`utils/retornoSeguro.js`). */
      const retornoUrl = retornoSeguro(requisicao.query?.returnUrl, contratante, { pedidoId });

      resposta.json({
        contratanteNome: contratante.nome,
        metodosHabilitados: contratante.metodos_habilitados ?? null,
        pedido,
        taxa,
        retornoUrl,
        ...(totais?.maxParcelas ? { maxParcelas: totais.maxParcelas } : {}),
        ...(bloqueio ? { bloqueio } : {}),
        ...(cotacao ? { cotacao: { id: cotacao.id, expiraEm: cotacao.expiraEm, totais } } : {})
      });
    } catch (erro) {
      responderErro(resposta, erro, 'pedidoController.obterPedido', 500);
    }
  };
}

export const obterPedido = criarObterPedido();
