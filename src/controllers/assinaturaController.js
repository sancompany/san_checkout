/**
 * SAN CHECKOUT v2 — src/controllers/assinaturaController.js
 * POST /api/checkout/cancelar-assinatura
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada em
 * /pedido e /estornar)
 * Body: { planoId, documento }
 *
 * "Cancelamento: só o projeto aciona — o pagador nunca cancela direto
 * no checkout" (VISAO_COMPLETA.md seção 4.4, INTEGRACAO.md seção 6.1).
 * Por isso a busca é por planoId+documento (o que o projeto contratante
 * tem) e não pelo id da assinatura na Asaas (que o projeto nunca chega
 * a ver — só existe internamente, na tabela `assinaturas`).
 *
 * Cancelar aqui só PARA a geração de cobranças futuras — não estorna
 * nenhuma cobrança já paga (se for o caso, usar /estornar separado).
 *
 * ⚠️ NUNCA TESTADO AO VIVO: precisa de uma assinatura RECURRENT real e
 * confirmada em sandbox pra existir uma linha em `assinaturas` pra
 * cancelar.
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import { buscarAssinaturaAtiva, atualizarStatusAssinatura } from '../services/assinaturaService.js';
import {
  cancelarAssinatura as cancelarAssinaturaNaAsaas,
  alterarStatusAssinatura
} from '../services/asaasService.js';
import { documentoValido } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

export async function cancelarAssinatura(requisicao, resposta) {
  const chave = requisicao.get('X-Checkout-Key');
  const { planoId, documento } = requisicao.body ?? {};

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
  if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

    /* `pausada` entra aqui, e a falta dela era um beco sem saída.

       Até 15/09/2026 esta busca usava o default `['ativa']`, e o efeito
       foi medido ao vivo: uma assinatura pausada respondia 200 no
       `/pausar-assinatura` (que aceita `pausada`) e 404 no
       `/cancelar-assinatura` — a MESMA linha, o mesmo plano, o mesmo
       documento. Quem pausasse não conseguia mais cancelar por lugar
       nenhum: a assinatura ficava INACTIVE na Asaas para sempre, e o
       único caminho era mexer no painel na mão.

       `cancelada` fica de FORA de propósito. Seria simpático responder
       `jaEstava: true` como pausar/retomar fazem, mas esta busca ordena
       por `criado_em` desc e pega uma só: numa renovação (duas linhas
       para o mesmo plano+documento), aceitar `cancelada` faria a antiga
       recém-encerrada mascarar uma ativa mais nova em algum caso de
       ordem. 404 aqui é honesto — não há assinatura cancelável. */
    const assinatura = await buscarAssinaturaAtiva(
      contratante.id, planoId, documento, ['ativa', 'pausada']
    );
    if (!assinatura) {
      return resposta.status(404).json({ erro: 'Nenhuma assinatura ativa ou pausada encontrada pra esse plano/documento.' });
    }

    await cancelarAssinaturaNaAsaas(assinatura.id);
    await atualizarStatusAssinatura(assinatura.id, 'cancelada');

    resposta.json({ assinaturaId: assinatura.id, status: 'cancelada' });
  } catch (erro) {
    responderErro(resposta, erro, 'assinaturaController.cancelarAssinatura');
  }
}

/**
 * Pausar e retomar — `POST /api/checkout/pausar-assinatura` e
 * `/retomar-assinatura`, mesma autenticação e mesmo body do
 * cancelamento.
 *
 * Por que isso importa: antes só existia CANCELAR, que é definitivo. Um
 * assinante que queria parar por um mês tinha que ser cancelado e
 * assinar tudo de novo depois — na prática, virava churn. Pausado, o
 * mesmo vínculo volta a cobrar quando for reativado.
 *
 * Uma fábrica em vez de dois handlers quase idênticos: só mudam o
 * status na Asaas, o status local e quais status locais são aceitos na
 * busca.
 */
function criarHandlerDeStatus({ statusAsaas, statusLocal, statusAceitos, jaEstaAssim }) {
  return async function handler(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    const { planoId, documento } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    try {
      const contratante = await buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      const assinatura = await buscarAssinaturaAtiva(contratante.id, planoId, documento, statusAceitos);
      if (!assinatura) {
        return resposta.status(404).json({ erro: `Nenhuma assinatura ${statusAceitos.join(' ou ')} encontrada pra esse plano/documento.` });
      }

      // Já está no estado pedido: responde sucesso sem chamar a Asaas.
      // Repetir a chamada não quebraria nada, mas gastar uma requisição
      // pra confirmar o que já é verdade não tem por quê.
      if (assinatura.status === statusLocal) {
        return resposta.json({ assinaturaId: assinatura.id, status: statusLocal, jaEstava: true });
      }

      await alterarStatusAssinatura(assinatura.id, statusAsaas);
      await atualizarStatusAssinatura(assinatura.id, statusLocal);

      resposta.json({ assinaturaId: assinatura.id, status: statusLocal });
    } catch (erro) {
      responderErro(resposta, erro, `assinaturaController.${jaEstaAssim}`);
    }
  };
}

export const pausarAssinatura = criarHandlerDeStatus({
  statusAsaas: 'INACTIVE',
  statusLocal: 'pausada',
  statusAceitos: ['ativa', 'pausada'],
  jaEstaAssim: 'pausarAssinatura'
});

export const retomarAssinatura = criarHandlerDeStatus({
  statusAsaas: 'ACTIVE',
  statusLocal: 'ativa',
  statusAceitos: ['pausada', 'ativa'],
  jaEstaAssim: 'retomarAssinatura'
});
