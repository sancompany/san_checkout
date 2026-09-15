/**
 * SAN CHECKOUT v2 — src/controllers/planoController.js
 * GET /api/checkout/plano/:contratanteId/:planoId
 * Devolve o plano CRU (sem wrapper) — o front (assinaturaHandler.js)
 * espera receber os campos direto, igual ao formato do INTEGRACAO.md
 * seção 6.1.
 */

import { resolverPlano } from '../services/pedidoService.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { responderErro } from '../utils/erros.js';

export async function obterPlano(requisicao, resposta) {
  const { contratanteId, planoId } = requisicao.params;

  try {
    const { contratante, plano } = await resolverPlano(contratanteId, planoId);

    // Assinatura não tem pedidoId — o destino volta sem `?pedido=`.
    // Quem identifica a assinatura para o contratante é o webhook
    // assinado, não a barra de endereço (ver utils/retornoSeguro.js).
    const retornoUrl = retornoSeguro(requisicao.query?.returnUrl, contratante);

    // O plano vai CRU (o front espera os campos direto, ver
    // INTEGRACAO.md 6.1). O que é nosso entra debaixo de `_checkout`,
    // com underscore, pra nunca colidir com um campo do contratante —
    // acrescentar campo é permitido pelo contrato, renomear/roubar
    // nome não seria.
    resposta.json({
      ...plano,
      _checkout: {
        metodosHabilitados: contratante.metodos_habilitados ?? null,
        contratanteNome: contratante.nome,
        retornoUrl
      }
    });
  } catch (erro) {
    responderErro(resposta, erro, 'planoController.obterPlano', 500);
  }
}
