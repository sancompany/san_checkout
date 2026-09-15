/**
 * SAN CHECKOUT v2 — src/services/assinaturaService.js
 * Tabela `assinaturas` — uma linha por assinatura ATIVA na Asaas,
 * usada só pra localizar o id da assinatura (`sub_...`) na hora de
 * cancelar (POST /cancelar-assinatura, `assinaturaController.js`). O
 * histórico de cobrança de cada ciclo mensal fica em `cobrancas`
 * (ver `cobrancaService.registrarCicloAssinatura`), não aqui.
 *
 * ⚠️ NUNCA TESTADO AO VIVO: precisa de uma assinatura RECURRENT real
 * confirmada em sandbox (CHECKOUT_PAID com `payment.subscription`
 * preenchido) pra `upsertAssinatura` rodar de verdade pela primeira vez.
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
