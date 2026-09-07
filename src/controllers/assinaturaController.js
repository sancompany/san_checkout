/**
 * SAN CHECKOUT v2 — src/controllers/assinaturaController.js
 * POST /api/checkout/cancelar-assinatura
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada em
 * /pedido e /estornar)
 * Body: { planoId, cpf }
 *
 * "Cancelamento: só o projeto aciona — o pagador nunca cancela direto
 * no checkout" (VISAO_COMPLETA.md seção 4.4, INTEGRACAO.md seção 6.1).
 * Por isso a busca é por planoId+cpf (o que o projeto contratante tem)
 * e não pelo id da assinatura na Asaas (que o projeto nunca chega a
 * ver — só existe internamente, na tabela `assinaturas`).
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
import { cancelarAssinatura as cancelarAssinaturaNaAsaas } from '../services/asaasService.js';
import { cpfValido } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

export async function cancelarAssinatura(requisicao, resposta) {
  const chave = requisicao.get('X-Checkout-Key');
  const { planoId, cpf } = requisicao.body ?? {};

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
  if (!planoId || !cpf) return resposta.status(400).json({ erro: 'planoId e cpf são obrigatórios.' });
  if (!cpfValido(cpf)) return resposta.status(400).json({ erro: 'CPF inválido.' });

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

    const assinatura = await buscarAssinaturaAtiva(contratante.id, planoId, cpf);
    if (!assinatura) {
      return resposta.status(404).json({ erro: 'Nenhuma assinatura ativa encontrada pra esse plano/CPF.' });
    }

    await cancelarAssinaturaNaAsaas(assinatura.id);
    await atualizarStatusAssinatura(assinatura.id, 'cancelada');

    resposta.json({ assinaturaId: assinatura.id, status: 'cancelada' });
  } catch (erro) {
    responderErro(resposta, erro, 'assinaturaController.cancelarAssinatura');
  }
}
