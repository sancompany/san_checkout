/**
 * SAN CHECKOUT v2 — src/services/assinaturaService.js
 * Tabela `assinaturas` — uma linha por assinatura ATIVA na Asaas,
 * usada só pra localizar o id da assinatura (`sub_...`) na hora de
 * cancelar (POST /cancelar-assinatura, `assinaturaController.js`). O
 * histórico de cobrança de cada ciclo mensal fica em `cobrancas`
 * (ver `cobrancaService.registrarCicloAssinatura`), não aqui.
 *
 * Testado ao vivo em 16/09/2026: `sub_qut6521d50496vkn` (testemaster,
 * plano anual, R$10) percorreu criar → pausar → retomar → conciliar →
 * cancelar com dinheiro de sandbox de verdade, sem fixture. Foi esse
 * exercício que revelou o `ciclo` gravado errado — ver
 * `atualizarCicloAssinatura` abaixo.
 */

import { supabase } from '../config/supabase.js';

/** Cria ou atualiza a linha da assinatura — chamado pelo
 *  webhookController (`amarrarAssinaturaACobranca`) assim que o
 *  `payment.subscription` da Asaas é conhecido. Hoje isso acontece no
 *  `PAYMENT_CONFIRMED` (não no `CHECKOUT_PAID`, que não traz esse
 *  campo — ver `docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-pagamento.md`). */
export async function upsertAssinatura({ id, contratanteId, planoId, documento, valor, ciclo, proximaCobranca }) {
  const { error } = await supabase.from('assinaturas').upsert({
    id,
    contratante_id: contratanteId,
    plano_id: planoId ?? null,
    documento,
    valor,
    ciclo: ciclo ?? 'MONTHLY',
    proxima_cobranca: proximaCobranca ?? null,
    status: 'ativa'
  });

  if (error) console.error('[assinaturaService.upsertAssinatura]', error.message);
}

/**
 * Corrige o `ciclo` do nosso registro pelo que a Asaas reporta.
 *
 * Existe porque quem cobra é a Asaas: se o ciclo daqui divergir do dela,
 * o errado é o nosso. Foi exatamente o caso das assinaturas nascidas
 * antes da correção de 15/09/2026 — gravadas como `MONTHLY` porque o
 * código lia um campo de webhook que não existe
 * (`docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`).
 * Medido em 16/09: `sub_qut6521d50496vkn` está `YEARLY` na Asaas e
 * estava `MONTHLY` aqui. Sem isto, essas linhas ficariam erradas para
 * sempre — a correção de origem só vale para assinaturas novas.
 */
export async function atualizarCicloAssinatura(id, ciclo) {
  const { error } = await supabase
    .from('assinaturas')
    .update({ ciclo })
    .eq('id', id);

  if (error) console.error('[assinaturaService.atualizarCicloAssinatura]', error.message);
}

export async function atualizarStatusAssinatura(id, status) {
  const { error } = await supabase
    .from('assinaturas')
    .update({ status })
    .eq('id', id);

  if (error) console.error('[assinaturaService.atualizarStatusAssinatura]', error.message);
}

/** Busca a assinatura de um contratante+plano+documento — a busca é por
 *  esses três porque é o que o projeto contratante tem em mãos (o id da
 *  assinatura na Asaas ele nunca chega a ver).
 *
 * @param {string[]} [statusAceitos] — por padrão só `ativa`, que é o que
 *   o cancelamento sempre quis. Retomar precisa achar uma `pausada`, e
 *   por isso o parâmetro existe.
 */
export async function buscarAssinaturaAtiva(contratanteId, planoId, documento, statusAceitos = ['ativa']) {
  const { data, error } = await supabase
    .from('assinaturas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('plano_id', planoId)
    .eq('documento', documento)
    .in('status', statusAceitos)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}
