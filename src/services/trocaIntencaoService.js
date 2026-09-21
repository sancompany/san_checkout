/**
 * SAN CHECKOUT v2 — src/services/trocaIntencaoService.js
 * Acesso a `intencoes_troca_plano` (migration 0011/0012) — a máquina de
 * 10 estados do redesenho de troca de plano
 * (`docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`).
 *
 * Cada transição é um `UPDATE` condicional (CAS): `.eq('status', de)`
 * garante que só quem está no estado certo consegue avançar — a mesma
 * receita de `assinaturaService.reivindicarTroca`, aplicada por LINHA de
 * intenção em vez de por assinatura.
 */

import { supabase } from '../config/supabase.js';
import { hojeCivil, diaCivilAntes, inicioDoDiaCivil } from '../utils/diaCivil.js';

/** TTL duro da aprovação. */
const MINUTOS_DE_APROVACAO = 15;

/**
 * Quando a intenção expira: 15 minutos à frente, OU a virada do dia
 * civil de Brasília — o que vier primeiro.
 *
 * Por que a virada de dia importa: sem ela, uma intenção criada às
 * 23h58 de Brasília venceria às 00h13 do dia seguinte — cruzando a
 * fronteira que a métrica de sucesso (`docs/funcional.md` §9) usa para
 * "confirmadas por dia". Não é o caso mais comum, mas é barato de
 * fechar e evita uma aprovação legítima contar no dia errado.
 */
export function calcularExpiracao(agora = new Date()) {
  const candidato = new Date(agora.getTime() + MINUTOS_DE_APROVACAO * 60_000);
  const proximoDiaCivil = diaCivilAntes(hojeCivil(agora), -1);
  const meiaNoite = inicioDoDiaCivil(proximoDiaCivil);
  return candidato < meiaNoite ? candidato : meiaNoite;
}

/**
 * Cria a intenção — o retrato congelado inteiro numa escrita só.
 * @returns {Promise<{id: string, expiraEm: string}>}
 */
export async function criarIntencao(dados) {
  const expiraEm = calcularExpiracao();

  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .insert({
      assinatura_id: dados.assinaturaId,
      contratante_id: dados.contratanteId,
      plano_id: dados.planoId,
      plano_novo_id: dados.planoNovoId,
      plano_nome: dados.planoNome,
      plano_novo_nome: dados.planoNovoNome,
      ciclo_atual: dados.cicloAtual,
      ciclo_novo: dados.cicloNovo,
      valor_atual: dados.valorAtual,
      valor_novo: dados.valorNovo,
      valor_pago_do_periodo: dados.valorPagoDoPeriodo,
      vencimento_atual: dados.vencimentoAtual,
      dias_restantes: dados.diasRestantes,
      credito: dados.credito,
      debito: dados.debito,
      valor_acerto: dados.valorAcerto,
      mutation_version_snapshot: dados.mutationVersionSnapshot,
      expira_em: expiraEm.toISOString()
    })
    .select('id')
    .single();

  if (error) throw error;
  return { id: data.id, expiraEm: expiraEm.toISOString() };
}

/** Pelo `charge_id` — é assim que o WEBHOOK encontra a intenção
 *  (`webhookController.js`, "o acerto de troca"): ele conhece o
 *  `payment.id`, nunca o id da intenção. `null` quando não existe
 *  (chargeId que não é de nenhuma troca — a rota devolve calada,
 *  igual a qualquer chargeId desconhecido). */
export async function buscarIntencaoPorChargeId(chargeId) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .select('*')
    .eq('charge_id', chargeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** A linha inteira, pelo id (o token). `null` quando não existe —
 *  nunca lança por "não encontrado", porque um token forjado ou expirado
 *  há muito tempo é uma resposta normal desta função, não uma exceção. */
export async function buscarIntencao(id) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * A transição CAS genérica: só avança quem está exatamente no(s)
 * estado(s) de origem. `deStatus` aceita um status ou uma lista.
 *
 * @returns {Promise<object|null>} a linha JÁ atualizada quando esta
 *   chamada venceu a corrida; `null` quando outra chamada chegou
 *   primeiro (ou a linha não existe, ou já está noutro estado).
 */
async function transicionar(id, deStatus, paraStatus, patch = {}) {
  let consulta = supabase
    .from('intencoes_troca_plano')
    .update({ status: paraStatus, ...patch })
    .eq('id', id);

  consulta = Array.isArray(deStatus) ? consulta.in('status', deStatus) : consulta.eq('status', deStatus);

  const { data, error } = await consulta.select('*');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

/**
 * PENDING_APPROVAL → PROCESSING_PAYMENT — a reivindicação que abre a
 * janela de cobrança. Recusa (devolve `null`) quando a intenção já foi
 * reivindicada por OUTRA chamada (duplo clique no mesmo link) ou já
 * passou do `expira_em`.
 */
export async function reivindicarProcessamento(id) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .update({ status: 'PROCESSING_PAYMENT', aprovando_em: new Date().toISOString(), aprovada_em: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PENDING_APPROVAL')
    .gt('expira_em', new Date().toISOString())
    .select('*');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

/** PENDING_APPROVAL → EXPIRED, só quando o prazo já passou — usada
 *  tanto sob demanda (alguém consulta um link vencido) quanto pelo
 *  sweeper, em lote. */
export async function expirarSePassouDoPrazo(id) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .update({ status: 'EXPIRED' })
    .eq('id', id)
    .eq('status', 'PENDING_APPROVAL')
    .lt('expira_em', new Date().toISOString())
    .select('*');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

/** PROCESSING_PAYMENT (a única origem lícita, sempre logo após
 *  `reivindicarProcessamento`) → STALE — a revalidação falhou: a
 *  assinatura mudou de `mutation_version` desde que o retrato foi
 *  congelado. Nunca cobra, nunca recalcula. */
export async function marcarStale(id) {
  return transicionar(id, 'PROCESSING_PAYMENT', 'STALE');
}

/** Grava o `charge_id` assim que `cobrarNoCartaoSalvo` devolve — ANTES
 *  de saber a classificação. É o que permite o webhook achar esta
 *  intenção mesmo enquanto o veredito ainda é UNKNOWN. */
export async function registrarChargeId(id, chargeId) {
  const { error } = await supabase
    .from('intencoes_troca_plano')
    .update({ charge_id: chargeId })
    .eq('id', id);

  if (error) throw error;
}

/** PROCESSING_PAYMENT|PAYMENT_UNKNOWN → PAYMENT_CONFIRMED. */
export async function marcarConfirmada(id) {
  return transicionar(id, ['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'], 'PAYMENT_CONFIRMED');
}

/** PROCESSING_PAYMENT|PAYMENT_UNKNOWN → PAYMENT_DECLINED. */
export async function marcarRecusada(id) {
  return transicionar(id, ['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'], 'PAYMENT_DECLINED');
}

/** PROCESSING_PAYMENT → PAYMENT_UNKNOWN — o veredito ainda não fechou
 *  (nem PAID nem recusa definitiva). De PAYMENT_UNKNOWN para
 *  PAYMENT_UNKNOWN não é uma transição real (é o mesmo estado), então
 *  não passa por aqui — quem chama já sabe que só faz sentido na
 *  primeira vez. */
export async function marcarAmbigua(id) {
  return transicionar(id, 'PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN');
}

/** Acima de quanto tempo parado em `APPLYING_PLAN` o sweeper pode
 *  assumir que o processo anterior morreu no meio e retomar. Curto o
 *  bastante para não deixar uma intenção travada por muito tempo;
 *  longo o bastante para não brigar com uma chamada que ainda está
 *  genuinamente em andamento (o `PUT`+`GET` na Asaas cabe folgado em
 *  20s×2, ver `TIMEOUT_ASAAS_MS`). */
const LEASE_APLICACAO_MS = 2 * 60_000;

/**
 * PAYMENT_CONFIRMED → APPLYING_PLAN — o CAS que garante que só UMA
 * chamada aplica o plano na Asaas, mesmo que o webhook e o sweeper
 * cheguem à confirmação quase ao mesmo tempo.
 *
 * Também cobre a RETOMADA: se o processo morreu depois de reivindicar
 * (a intenção ficou presa em `APPLYING_PLAN` para sempre, sem isso) —
 * uma segunda chamada só retoma se `aprovando_em` está mais velho que
 * `LEASE_APLICACAO_MS`, o que continua sendo CAS (o `UPDATE` só afeta a
 * linha se a condição ainda for verdadeira no momento da escrita — duas
 * retomadas concorrentes nunca vencem as duas).
 */
export async function reivindicarAplicacao(id) {
  const primeiraVez = await transicionar(id, 'PAYMENT_CONFIRMED', 'APPLYING_PLAN', { aprovando_em: new Date().toISOString() });
  if (primeiraVez) return primeiraVez;

  const limite = new Date(Date.now() - LEASE_APLICACAO_MS).toISOString();
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .update({ aprovando_em: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'APPLYING_PLAN')
    .lt('aprovando_em', limite)
    .select('*');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

/** APPLYING_PLAN → COMPLETED. */
export async function marcarConcluida(id) {
  return transicionar(id, 'APPLYING_PLAN', 'COMPLETED', { concluida_em: new Date().toISOString() });
}

/** APPLYING_PLAN → RECONCILIATION_REQUIRED — o `PUT` na Asaas não
 *  pegou (a mesma ambiguidade que `trocaPlanoController.js` já tratava
 *  com `502`, aqui sem ninguém olhando a resposta HTTP na hora). */
export async function marcarReconciliacaoNecessaria(id, deStatus) {
  return transicionar(id, deStatus, 'RECONCILIATION_REQUIRED');
}

/** Incrementa `tentativas_sweeper` — não é uma transição de estado,
 *  só o contador que decide quando escalonar. */
export async function incrementarTentativaSweeper(id) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .select('tentativas_sweeper')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;

  const { error: erroUpdate } = await supabase
    .from('intencoes_troca_plano')
    .update({ tentativas_sweeper: data.tentativas_sweeper + 1 })
    .eq('id', id);
  if (erroUpdate) throw erroUpdate;
}

/**
 * As intenções que o sweeper precisa olhar: qualquer estado não
 * terminal que já disparou (ou pode ter disparado) uma cobrança.
 * `PENDING_APPROVAL` fica de fora de propósito — o sweeper nunca cria
 * cobrança nova, e uma intenção pendente sem aprovação não tem nada
 * para reconciliar (só expira sozinha).
 */
export async function listarIntencoesParaVarredura({ limite = 100 } = {}) {
  const { data, error } = await supabase
    .from('intencoes_troca_plano')
    .select('*')
    .in('status', ['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN', 'PAYMENT_CONFIRMED', 'APPLYING_PLAN', 'RECONCILIATION_REQUIRED'])
    .order('criada_em', { ascending: true })
    .limit(limite);

  if (error) throw error;
  return data ?? [];
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/trocaIntencaoService.js`
   Só a parte pura: `calcularExpiracao`. O resto é acesso a banco puro
   (um `UPDATE ... WHERE` cada), sem lógica para testar sem rede — a
   COREOGRAFIA que usa estas funções tem o autoteste dela em
   `trocaExecucaoService.js`, com dependências falseadas.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('trocaIntencaoService.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const meioDoDia = calcularExpiracao(new Date('2026-09-20T15:00:00Z')); // 12h em Brasília
  conferir(
    meioDoDia.toISOString() === '2026-09-20T15:15:00.000Z',
    `meio do dia: 15 minutos à frente vence antes da virada, veio ${meioDoDia.toISOString()}`
  );

  // 23h58 de Brasília = 02:58Z do dia seguinte. 15 minutos dali cruzaria
  // a meia-noite de Brasília (03:00Z) — o teto tem de segurar em 03:00Z.
  const pertoDaVirada = calcularExpiracao(new Date('2026-09-21T02:58:00Z'));
  conferir(
    pertoDaVirada.toISOString() === '2026-09-21T03:00:00.000Z',
    `perto da virada: o teto é a meia-noite de Brasília, não os 15 minutos, veio ${pertoDaVirada.toISOString()}`
  );
  conferir(
    pertoDaVirada.getTime() - new Date('2026-09-21T02:58:00Z').getTime() < 15 * 60_000,
    'e esse teto é MENOR que 15 minutos — é isso que prova que ele apertou'
  );

  // Bem longe da virada: os 15 minutos vencem primeiro, folgado.
  const longeDaVirada = calcularExpiracao(new Date('2026-09-20T13:00:00Z')); // 10h de Brasília
  conferir(
    longeDaVirada.toISOString() === '2026-09-20T13:15:00.000Z',
    `longe da virada, os 15 minutos vencem primeiro, veio ${longeDaVirada.toISOString()}`
  );

  console.log(`trocaIntencaoService: ${checagens} checagens OK`);
}
