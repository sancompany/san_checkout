/**
 * SAN CHECKOUT v2 — src/controllers/pedidoController.js
 * GET /api/checkout/pedido/:contratanteId/:pedidoId
 * Chamado pelo front assim que a tela abre — resolve via pull e já
 * devolve a taxa calculada (assumindo Pix, único método desta leva).
 */

import { resolverPedido } from '../services/pedidoService.js';
import { calcularTaxa } from '../services/taxaService.js';
import { valorValido } from '../utils/validadores.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { responderErro } from '../utils/erros.js';

export async function obterPedido(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;

  try {
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId);

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);

    /* A MESMA regra que o caminho que cobra usa (`valorValido`:
       maior que zero e até 100.000). Sem ela, esta rota anuncia um
       total pagável para um pedido que a criação de cobrança vai
       recusar: `calcularTaxa(0, …)` devolve as taxas cheias sobre base
       zero — medido em 13/09/2026 com o contratante de teste,
       `valorCobrado: 1.49` para um pedido de R$ 0,00 —, e o front lê
       `taxa.valorCobrado` como "o total". A tela ficava comprável, com
       botão de pagar, e o erro só aparecia depois de o comprador
       preencher tudo e clicar.

       `taxa: null` faz o guarda do front disparar (ele exige um total
       finito e maior que zero) e a tela cair no estado Indisponível,
       com `R$ —` e sem botão — que é o comportamento escrito em
       `docs/funcional.md` §4.1. */
    const taxa = valorValido(valorBase)
      ? calcularTaxa(valorBase, 'pix', 1, Boolean(pedido.isentarTaxa))
      : null;

    /* Quem decide o destino de volta é AQUI, não o navegador.

       O front manda o `returnUrl` cru que veio na barra de endereço e
       recebe de volta o destino aprovado, ou `null`. A lista de origens
       do contratante nunca sai do servidor: mandá-la para o front
       publicaria os domínios cadastrados dele para qualquer um que
       abrisse um link de checkout, e o front não precisa dela para
       nada — precisa só da resposta.

       `null` não é erro: link sem `returnUrl`, ou com destino de fora
       da lista, continua sendo um checkout que cobra normalmente. Só
       não ganha o botão de voltar. Ver `utils/retornoSeguro.js`. */
    const retornoUrl = retornoSeguro(requisicao.query?.returnUrl, contratante, { pedidoId });

    resposta.json({
      contratanteNome: contratante.nome,
      metodosHabilitados: contratante.metodos_habilitados ?? null,
      pedido,
      taxa,
      retornoUrl
    });
  } catch (erro) {
    responderErro(resposta, erro, 'pedidoController.obterPedido', 500);
  }
}
