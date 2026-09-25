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
import { exigirIdCanonico } from '../utils/validadores.js';

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
 * Reivindica o direito de MUDAR uma assinatura — o arrendamento
 * (migration 0010, coluna `trocando_em`). Apesar do nome (nasceu com a
 * troca de plano, 17/09/2026), é o mutex de QUALQUER operação que
 * altera o estado da assinatura na Asaas: desde 22/09/2026 também
 * `cancelarAssinatura`/`pausarAssinatura`/`retomarAssinatura`
 * (`assinaturaController.js`, AUD-005) reivindicam aqui antes de
 * chamar a Asaas — sem isso, um cancelamento e uma troca de plano
 * simultâneos na MESMA assinatura corriam livres um do outro.
 *
 * Por que existe: a troca cobra o acerto ANTES de alterar o plano (uma
 * recusa de cartão não pode deixar o assinante no plano caro de graça).
 * Duas chamadas simultâneas da rota leriam as duas o mesmo estado e
 * cobrariam DUAS vezes o mesmo acerto — dinheiro do assinante, e um
 * estorno para desfazer. Cancelar/pausar/retomar não cobram nada, mas
 * têm o mesmo problema de fundo: duas chamadas concorrentes (entre si,
 * ou contra uma troca em andamento) leem o mesmo estado e agem duas
 * vezes sobre ele.
 *
 * O `update` condicional é a guarda inteira: no Postgres ele é atômico,
 * então só uma das duas chamadas encontra linha para atualizar. A outra
 * recebe `false` e a rota devolve 409 **sem ter feito nada**.
 *
 * O prazo curto é deliberado: um processo que morra no meio de uma
 * operação não pode trancar a assinatura para sempre. Passados os
 * minutos, uma nova tentativa reivindica de novo — e, no caso da troca
 * com acerto, o que já foi cobrado está registrado em `cobrancas`, que
 * é onde se confere.
 *
 * @returns {Promise<boolean>} `true` quando esta chamada é a dona da
 *   operação; `false` quando outra está em andamento.
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

/** Devolve o arrendamento sem terminar a operação — usada quando ela é
 *  abandonada depois de reivindicada (troca: cartão recusado, plano sem
 *  cartão salvo; cancelar/pausar/retomar: a chamada à Asaas falhou).
 *  Falha aqui não é fatal: o prazo expira sozinho. */
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
 *
 * `mutation_version` sobe SEMPRE, e a escrita é sempre CAS contra o
 * valor que quem chama tinha em mãos (`mutationVersionEsperada`,
 * obrigatório) — é a cerca de concorrência otimista (migration 0011)
 * que a aprovação de troca de plano usa para saber se a assinatura
 * mudou desde que o retrato foi congelado. A troca síncrona de sempre
 * (sem concorrência a temer dentro da mesma requisição, já protegida
 * por `trocando_em`) também passa por aqui com o valor que acabou de
 * ler — CAS que sempre bate não é CAS a mais, é o mesmo primitivo
 * usado em todo lugar, sem um segundo caminho "sem cerca" que alguém
 * possa esquecer de proteger amanhã.
 *
 * @returns {Promise<boolean>} `true` quando a escrita aconteceu;
 *   `false` quando o `mutation_version` já não era o esperado — nesse
 *   caso NADA foi escrito, e quem chama decide o que fazer (`STALE`,
 *   nunca sobrescrever às cegas).
 */
export async function aplicarTrocaDePlano(id, { planoNovoId, planoAnteriorId, valor, ciclo, mutationVersionEsperada }) {
  if (!Number.isInteger(mutationVersionEsperada)) {
    throw new Error('aplicarTrocaDePlano: mutationVersionEsperada é obrigatório (inteiro) — CAS sem ele não é CAS.');
  }

  const { data, error } = await supabase
    .from('assinaturas')
    .update({
      plano_id: planoNovoId,
      plano_anterior_id: planoAnteriorId,
      valor,
      ciclo,
      trocado_em: new Date().toISOString(),
      trocando_em: null,
      mutation_version: mutationVersionEsperada + 1
    })
    .eq('id', id)
    .eq('mutation_version', mutationVersionEsperada)
    .select('id');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/**
 * A assinatura pelo id dela na Asaas (`sub_...`).
 *
 * Existe por causa da troca de plano: a partir dela, o `plano_id` da
 * assinatura passa a divergir do `plano_id` das cobranças ANTIGAS, e o
 * ciclo novo (`registrarNovoCicloAssinatura`, webhookController) se
 * monta copiando a cobrança anterior. Sem esta consulta, o ciclo
 * seguinte a uma troca nasceria com o plano VELHO — e, como cada ciclo
 * copia do anterior, o erro se repetiria para sempre, avisando o
 * contratante do plano errado a cada cobrança.
 *
 * Aqui mora a verdade do plano vigente; a cobrança guarda o histórico.
 */
export async function buscarAssinaturaPorId(id) {
  const { data, error } = await supabase
    .from('assinaturas')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[assinaturaService.buscarAssinaturaPorId]', error.message);
    return null;
  }
  return data;
}

/**
 * Corrige o `valor` do nosso registro pelo que a Asaas cobra.
 *
 * ── A decisão, e ela é do dono (18/09/2026) ─────────────────────────
 * Até aqui a conciliação reconferia `status`, `ciclo` e
 * `proximaCobranca` e **não** reconferia `valor` — RN-34, declarado em
 * 17/09 em vez de corrigido às cegas, porque reconciliar é deixar a
 * Asaas mandar no número inclusive quando a alteração de lá foi erro
 * humano de quem mexeu no painel. O dono decidiu: **reconciliar**.
 *
 * E a decisão é a certa, pelo motivo que fecha o argumento contrário:
 * quem debita o cartão é a Asaas. Se o painel dela diz R$ 45 e o nosso
 * banco diz R$ 30, o assinante **está pagando R$ 45** — o nosso número
 * não é uma opinião divergente, é uma informação falsa. Guardar o valor
 * antigo para "não endossar o erro" só troca um erro de preço por um
 * erro de registro, e deixa o campo que o integrador lê mentindo.
 *
 * O cuidado que ele queria não se perde: a divergência é **denunciada**
 * na mesma resposta (`divergenciaDeValor`, `API.md` §5.3) e registrada
 * no log. Corrigir e contar não são alternativas — é o par.
 */
export async function atualizarValorAssinatura(id, valor) {
  const { error } = await supabase
    .from('assinaturas')
    .update({ valor })
    .eq('id', id);

  if (error) console.error('[assinaturaService.atualizarValorAssinatura]', error.message);
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
  // Teto do id aqui, e não em cada um dos cinco controladores de
  // assinatura que chamam esta função (`utils/validadores.js`).
  exigirIdCanonico(planoId, 'planoId');

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
