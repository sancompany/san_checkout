/**
 * SAN CHECKOUT v2 — src/controllers/planoController.js
 * GET /api/checkout/plano/:contratanteId/:planoId
 * Devolve o plano CRU (sem wrapper) — o front (assinaturaHandler.js)
 * espera receber os campos direto, igual ao formato do INTEGRACAO.md
 * seção 6.1.
 */

import { resolverPlano } from '../services/pedidoService.js';
import { responderErro } from '../utils/erros.js';

export async function obterPlano(requisicao, resposta) {
  const { contratanteId, planoId } = requisicao.params;

  try {
    const { plano } = await resolverPlano(contratanteId, planoId);
    resposta.json(plano);
  } catch (erro) {
    responderErro(resposta, erro, 'planoController.obterPlano', 500);
  }
}
