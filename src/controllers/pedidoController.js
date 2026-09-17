/**
 * SAN CHECKOUT v2 — src/controllers/pedidoController.js
 * GET /api/checkout/pedido/:contratanteId/:pedidoId
 * Chamado pelo front assim que a tela abre — resolve via pull e já
 * devolve a taxa calculada (assumindo Pix, único método desta leva).
 */

import { resolverPedido } from '../services/pedidoService.js';
import { calcularTaxa, taxaComParcelasQueCabem } from '../services/taxaService.js';
import {
  valorValido, valorCobradoAceitavel, MENSAGEM_PISO_ASAAS,
  MAXIMO_DE_PARCELAS_DO_CHECKOUT
} from '../utils/validadores.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { responderErro } from '../utils/erros.js';

/* FÁBRICA, não terceiro parâmetro.

   A injeção existe para o autoteste poder exercitar esta rota sem
   Supabase e sem a API de um contratante no ar — que é exatamente por
   que a regra do piso nunca teve teste.

   Mas ela NÃO pode ser um terceiro parâmetro do handler: o Express
   chama todo handler como `(req, res, next)`, então `deps` chegaria
   sendo o `next` e `deps.resolverPedido` seria `undefined` em
   produção — o teste passaria e a rota quebraria. A fábrica fecha a
   dependência por closure, e o que vai para o `router` é uma função de
   dois parâmetros, como o Express espera. */
export function criarObterPedido({ resolverPedido: resolver = resolverPedido } = {}) {
  return async function obterPedido(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;

    try {
      const { contratante, pedido } = await resolver(contratanteId, pedidoId);

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

      /* O PISO DA ASAAS, dito na hora de abrir a tela — não no clique.

         A Asaas recusa qualquer cobrança abaixo de R$ 5,00 no valor
         cobrado, nos seis caminhos (medido em 17/09, ver
         `utils/validadores.js`). Até aqui o comprador só descobria isso
         depois de preencher nome, e-mail, CPF e telefone e apertar
         pagar: a resposta vinha da Asaas, em linguagem de provedor, e
         nada na tela dizia que aquele link nunca ia funcionar.

         `taxa` continua indo preenchida, porque o total É aquele — o que
         muda é que a tela nasce sem formulário, com o motivo escrito.
         `bloqueio` é campo novo e só aparece quando existe: acrescentar
         campo é permitido pelo contrato (API.md §4.1), e um cliente
         antigo que o ignore cai no comportamento de antes, não pior. */
      const bloqueio = taxa && !valorCobradoAceitavel(taxa.valorCobrado)
        ? { codigo: 'valor_abaixo_do_piso', mensagem: MENSAGEM_PISO_ASAAS }
        : null;

      /* QUANTAS PARCELAS A TELA PODE OFERECER.

         O piso de R$ 5,00 da Asaas vale POR PARCELA (`API.md` §9.1), e o
         backend já capa o que manda para a pop-up. Sem dizer isso à
         tela, o comprador de um pedido de R$ 24,00 escolhe 12x aqui, a
         pop-up abre oferecendo 5x, e ele vê duas telas discordando sobre
         a compra que está fazendo — o tipo de coisa que faz desistir na
         hora de digitar o cartão.

         Quem decide é AQUI, como em todo o resto: a tela recebe o número
         e corta a lista. Calcular no front exigiria a tabela de taxas no
         navegador, que é a mesma razão pela qual o total não é calculado
         lá (RN-03). */
      const maxParcelas = taxa
        ? taxaComParcelasQueCabem(valorBase, MAXIMO_DE_PARCELAS_DO_CHECKOUT, Boolean(pedido.isentarTaxa)).parcelas
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
        retornoUrl,
        ...(maxParcelas ? { maxParcelas } : {}),
        ...(bloqueio ? { bloqueio } : {})
      });
    } catch (erro) {
      responderErro(resposta, erro, 'pedidoController.obterPedido', 500);
    }
  }
}

export const obterPedido = criarObterPedido();
