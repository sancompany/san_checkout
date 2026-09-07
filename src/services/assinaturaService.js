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
 *  webhookController assim que a 1ª cobrança confirma (CHECKOUT_PAID)
 *  e a Asaas revela o id da assinatura (`payment.subscription`). */
export async function upsertAssinatura({ id, contratanteId, planoId, cpf, valor, ciclo, proximaCobranca }) {
  const { error } = await supabase.from('assinaturas').upsert({
    id,
    contratante_id: contratanteId,
    plano_id: planoId ?? null,
    cpf,
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

/** Busca a assinatura ATIVA de um contratante+plano+CPF — usado só
 *  pelo endpoint de cancelamento, que recebe planoId/cpf (não o id da
 *  assinatura na Asaas, que o projeto contratante nunca chega a ver). */
export async function buscarAssinaturaAtiva(contratanteId, planoId, cpf) {
  const { data, error } = await supabase
    .from('assinaturas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('plano_id', planoId)
    .eq('cpf', cpf)
    .eq('status', 'ativa')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}
