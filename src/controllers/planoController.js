/**
 * SAN CHECKOUT v2 — src/controllers/planoController.js
 * GET /api/checkout/plano/:contratanteId/:planoId
 * Devolve o plano CRU (sem wrapper) — o front (assinaturaHandler.js)
 * espera receber os campos direto, igual ao formato do API.md §4.2.
 */

import { resolverPlano } from '../services/pedidoService.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { valorCobradoAceitavel, MENSAGEM_PISO_ASAAS } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

/* Fábrica, não terceiro parâmetro — ver a nota em `pedidoController.js`:
   o Express chama todo handler como `(req, res, next)`. */
export function criarObterPlano({ resolverPlano: resolver = resolverPlano } = {}) {
  return async function obterPlano(requisicao, resposta) {
    const { contratanteId, planoId } = requisicao.params;

    try {
      const { contratante, plano } = await resolver(contratanteId, planoId);

      // Assinatura não tem pedidoId — o destino volta sem `?pedido=`.
      // Quem identifica a assinatura para o contratante é o webhook
      // assinado, não a barra de endereço (ver utils/retornoSeguro.js).
      const retornoUrl = retornoSeguro(requisicao.query?.returnUrl, contratante);

      /* Assinatura não leva taxa nossa: o que a Asaas cobra por ciclo é o
         valor do plano cru. Então o piso de R$ 5,00 se aplica direto a
         ele — medido em `POST /v3/subscriptions` (R$ 2,50 → 400, R$ 5,00
         → 200), ver `utils/validadores.js`. Mesmo motivo do pedido: sem
         isto, quem assina descobre no clique, depois de preencher
         endereço completo (a Asaas exige endereço no cartão). */
      const bloqueio = !valorCobradoAceitavel(plano.valor)
        ? { codigo: 'valor_abaixo_do_piso', mensagem: MENSAGEM_PISO_ASAAS }
        : null;

      // O plano vai CRU (o front espera os campos direto, ver
      // API.md §4.2). O que é nosso entra debaixo de `_checkout`,
      // com underscore, pra nunca colidir com um campo do contratante —
      // acrescentar campo é permitido pelo contrato, renomear/roubar
      // nome não seria.
      resposta.json({
        ...plano,
        _checkout: {
          metodosHabilitados: contratante.metodos_habilitados ?? null,
          contratanteNome: contratante.nome,
          retornoUrl,
          ...(bloqueio ? { bloqueio } : {})
        }
      });
    } catch (erro) {
      responderErro(resposta, erro, 'planoController.obterPlano', 500);
    }
  }
}

export const obterPlano = criarObterPlano();
