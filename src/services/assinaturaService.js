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

/** Prazo do arrendamento da troca. Curto de propósito — ver
 *  `reivindicarTroca`. */
const MINUTOS_DE_ARRENDAMENTO = 5;

/**
 * Reivindica a troca de plano de uma assinatura — o arrendamento
 * (migration 0010, coluna `trocando_em`).
 *
 * Por que existe: a troca cobra o acerto ANTES de alterar o plano (uma
 * recusa de cartão não pode deixar o assinante no plano caro de graça).
 * Duas chamadas simultâneas da rota leriam as duas o mesmo estado e
 * cobrariam DUAS vezes o mesmo acerto — dinheiro do assinante, e um
 * estorno para desfazer.
 *
 * O `update` condicional é a guarda inteira: no Postgres ele é atômico,
 * então só uma das duas chamadas encontra linha para atualizar. A outra
 * recebe `false` e a rota devolve 409 **sem ter cobrado nada**.
 *
 * O prazo curto é deliberado: um processo que morra entre a cobrança e
 * a alteração não pode trancar a assinatura para sempre. Passados os
 * minutos, uma nova tentativa reivindica de novo — e nesse caso o
 * acerto anterior já está registrado em `cobrancas`, que é onde se
 * confere o que foi cobrado.
 *
 * @returns {Promise<boolean>} `true` quando esta chamada é a dona da
 *   troca; `false` quando outra está em andamento.
 */
export async function reivindicarTroca(id) {
  const limite = new Date(Date.now() - MINUTOS_DE_ARRENDAMENTO * 60_000).toISOString();

  const { data, error } = await supabase
    .from('assinaturas')
    .update({ trocando_em: new Date().toISOString() })
    .eq('id', id)
    .or(`trocando_em.is.null,trocando_em.lt.${limite}`)
    .select('id');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/** Devolve o arrendamento sem trocar nada — usada quando a troca é
 *  abandonada depois de reivindicada (cartão recusado, plano sem cartão
 *  salvo). Falha aqui não é fatal: o prazo expira sozinho. */
export async function liberarTroca(id) {
  const { error } = await supabase
    .from('assinaturas')
    .update({ trocando_em: null })
    .eq('id', id);

  if (error) console.error('[assinaturaService.liberarTroca]', error.message);
}

/**
 * Grava a troca de plano — os cinco campos numa escrita só.
 *
 * `plano_id`, `valor` e `ciclo` passam a valer; `plano_anterior_id` e
 * `trocado_em` são o rastro (migration 0010), e existem porque a troca
 * PARA BAIXO não gera cobrança nenhuma: sem eles, esse caso mudaria o
 * plano de um assinante sem deixar nada no nosso banco.
 *
 * Escrever aqui é obrigatório e não é opcional: a Asaas **não manda
 * evento nenhum** de assinatura (`CONSTRAINTS.md` §2.2, medido — zero
 * eventos `SUBSCRIPTION_*` entre os 53 configurados). Quem altera lá
 * escreve aqui na mesma operação, ou o dado nunca chega.
 */
export async function aplicarTrocaDePlano(id, { planoNovoId, planoAnteriorId, valor, ciclo }) {
  const { error } = await supabase
    .from('assinaturas')
    .update({
      plano_id: planoNovoId,
      plano_anterior_id: planoAnteriorId,
      valor,
      ciclo,
      trocado_em: new Date().toISOString(),
      trocando_em: null
    })
    .eq('id', id);

  if (error) throw error;
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
